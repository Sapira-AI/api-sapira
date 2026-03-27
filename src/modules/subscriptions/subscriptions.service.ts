import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { SubscriptionQueryDto } from './dto/subscription-query.dto';

@Injectable()
export class SubscriptionsService {
	private readonly logger = new Logger(SubscriptionsService.name);

	constructor(
		@InjectDataSource()
		private readonly dataSource: DataSource
	) {}

	async findAll(holdingId: string, query: SubscriptionQueryDto) {
		this.logger.log(`🔍 Buscando suscripciones para holding: ${holdingId}`);
		this.logger.log(`📋 Parámetros de búsqueda: ${JSON.stringify(query)}`);

		const { status, clientId, search, page = 1, limit = 50 } = query;
		const offset = (page - 1) * limit;

		let whereConditions = 'WHERE s.holding_id = $1';
		const params: any[] = [holdingId];
		let paramIndex = 2;

		if (status) {
			whereConditions += ` AND s.status = $${paramIndex}`;
			params.push(status);
			paramIndex++;
		}

		if (clientId) {
			whereConditions += ` AND s.client_id = $${paramIndex}`;
			params.push(clientId);
			paramIndex++;
		}

		if (search) {
			whereConditions += ` AND (c.name_commercial ILIKE $${paramIndex} OR ce.legal_name ILIKE $${paramIndex} OR s.external_id ILIKE $${paramIndex})`;
			params.push(`%${search}%`);
			paramIndex++;
		}

		const countQuery = `
			SELECT COUNT(*) as total
			FROM subscriptions s
			LEFT JOIN clients c ON c.id = s.client_id
			LEFT JOIN client_entities ce ON ce.id = s.client_entity_id
			${whereConditions}
		`;

		this.logger.log(`🔍 Query SQL COUNT: ${countQuery}`);
		this.logger.log(`📋 Parámetros: ${JSON.stringify(params)}`);

		const dataQuery = `
			SELECT 
				s.id,
				s.external_id,
				s.source,
				s.status,
				s.client_id,
				s.client_entity_id,
				c.name_commercial as client_name_commercial,
				ce.legal_name as legal_client_name,
				s.start_date,
				s.canceled_at,
				s.cancel_at_period_end,
				s.ended_at,
				s.current_period_start,
				s.current_period_end,
				s.billing_cycle_anchor,
				s.cancellation_reason,
				s.currency,
				s.monthly_amount,
				s.system_currency,
				s.monthly_amount_system_currency,
				s.last_synced_at,
				s.created_at,
				s.updated_at,
				COUNT(DISTINCT si.id) as items_count,
				COUNT(DISTINCT i.id) as invoices_count,
				COALESCE(SUM(si.unit_price * si.quantity), 0) as mrr
			FROM subscriptions s
			LEFT JOIN clients c ON c.id = s.client_id
			LEFT JOIN client_entities ce ON ce.id = s.client_entity_id
			LEFT JOIN subscription_items si ON si.subscription_id = s.id
			LEFT JOIN invoices i ON i.subscription_id = s.id
			${whereConditions}
			GROUP BY s.id, c.name_commercial, ce.legal_name
			ORDER BY s.created_at DESC
			LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
		`;

		const [countResult, data] = await Promise.all([
			this.dataSource.query(countQuery, params),
			this.dataSource.query(dataQuery, [...params, limit, offset]),
		]);

		const total = parseInt(countResult[0]?.total || '0', 10);

		this.logger.log(`✅ Total de suscripciones encontradas: ${total}`);
		this.logger.log(`📊 Suscripciones en esta página: ${data.length}`);

		if (data.length > 0) {
			this.logger.log(`📝 Primera suscripción: ${JSON.stringify(data[0])}`);
		}

		return {
			data,
			pagination: {
				page,
				limit,
				total,
				totalPages: Math.ceil(total / limit),
			},
		};
	}

	async findOne(id: string, holdingId: string) {
		const query = `
			SELECT 
				s.*,
				json_agg(
					DISTINCT jsonb_build_object(
						'id', si.id,
						'product_id', si.product_id,
						'product_name', si.product_name,
						'quantity', si.quantity,
						'unit_price', si.unit_price,
						'currency', si.currency,
						'interval', si.interval,
						'interval_count', si.interval_count
					)
				) FILTER (WHERE si.id IS NOT NULL) as items,
				json_agg(
					jsonb_build_object(
						'id', i.id,
						'invoice_number', i.invoice_number,
						'status', i.status,
						'issue_date', i.issue_date,
						'due_date', i.due_date,
						'total_invoice_currency', i.total_invoice_currency,
						'invoice_currency', i.invoice_currency
					) ORDER BY i.issue_date ASC
				) FILTER (WHERE i.id IS NOT NULL) as invoices
			FROM subscriptions s
			LEFT JOIN subscription_items si ON si.subscription_id = s.id
			LEFT JOIN invoices i ON i.subscription_id = s.id
			WHERE s.id = $1 AND s.holding_id = $2
			GROUP BY s.id
		`;

		const result = await this.dataSource.query(query, [id, holdingId]);

		if (!result || result.length === 0) {
			return null;
		}

		return result[0];
	}

	async getStats(holdingId: string) {
		const query = `
			SELECT 
				COUNT(*) as total_subscriptions,
				COUNT(*) FILTER (WHERE status = 'active') as active_subscriptions,
				COUNT(*) FILTER (WHERE status = 'canceled') as canceled_subscriptions,
				COUNT(*) FILTER (WHERE status = 'past_due') as past_due_subscriptions,
				COALESCE(SUM(
					(SELECT SUM(si.unit_price * si.quantity) 
					 FROM subscription_items si 
					 WHERE si.subscription_id = s.id)
				) FILTER (WHERE status = 'active'), 0) as total_mrr
			FROM subscriptions s
			WHERE s.holding_id = $1
		`;

		const result = await this.dataSource.query(query, [holdingId]);
		return result[0] || {};
	}
}
