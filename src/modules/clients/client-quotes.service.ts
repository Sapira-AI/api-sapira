import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import type { ClientQuoteSortField } from './dtos/query-client-quotes.dto';

type Row = Record<string, unknown>;

const toNumber = (value: unknown) => Number(value ?? 0) || 0;
const text = (value: unknown) => (value === null || value === undefined || value === '' ? null : String(value));

export interface ClientQuoteFilters {
	page?: number;
	limit?: number;
	stageId?: string;
	search?: string;
	sortBy?: ClientQuoteSortField;
	sortOrder?: 'asc' | 'desc';
}

/**
 * Cotizaciones de un cliente comercial (pestaña Cotizaciones del Cliente 360), de solo lectura. Las etapas son
 * configurables por holding (`quote_stages`: nombre, orden y color), así que el filtro es por etapa y la
 * respuesta trae las etapas del holding con su conteo para este cliente.
 */
@Injectable()
export class ClientQuotesService {
	constructor(private readonly dataSource: DataSource) {}

	private async assertClientInHolding(clientId: string, holdingId: string) {
		const rows = await this.dataSource.query<Row[]>(`SELECT 1 FROM clients WHERE id = $1 AND holding_id = $2`, [clientId, holdingId]);

		if (rows.length === 0) throw new NotFoundException('Cliente no encontrado');
	}

	async getQuotes(
		clientId: string,
		holdingId: string,
		{ page = 1, limit = 25, stageId, search, sortBy = 'quote_date', sortOrder = 'desc' }: ClientQuoteFilters
	) {
		await this.assertClientInHolding(clientId, holdingId);
		const params: unknown[] = [clientId, holdingId];
		const filters = [`q.client_id = $1`, `q.holding_id = $2`];

		if (search?.trim()) filters.push(`q.quote_number ILIKE $${params.push(`%${search.trim()}%`)}`);
		// Las etapas se cuentan con los demás filtros, pero sin el de etapa (así cada chip muestra su total).
		const base = `WHERE ${filters.join(' AND ')}`;
		const stageFilter = stageId ? `AND q.quote_stage_id = $${params.push(stageId)}` : '';
		// Lista blanca: el campo de orden nunca viene del usuario tal cual.
		const orderColumn = { quote_date: 'q.quote_date', quote_number: 'q.quote_number', total_amount: 'q.total_amount', stage: 'qs.position' }[
			sortBy
		];
		const direction = sortOrder === 'asc' ? 'ASC' : 'DESC';
		const offset = (page - 1) * limit;
		const stageParams = params.slice(0, stageId ? params.length - 1 : params.length);

		const [rows, stages] = await Promise.all([
			this.dataSource.query<Row[]>(
				`SELECT q.id, q.quote_number, q.quote_date::text AS quote_date, q.booking_date::text AS booking_date, q.quote_type,
					q.currency, q.total_amount, q.payment_terms, q.notes,
					qs.id AS stage_id, qs.name AS stage_name, qs.color AS stage_color,
					s.name AS seller_name, cc.name AS contact_name,
					(SELECT COUNT(*) FROM quote_items qi WHERE qi.quote_id = q.id) AS items_count,
					ct.id AS contract_id, ct.contract_number
				FROM quotes q
				LEFT JOIN quote_stages qs ON qs.id = q.quote_stage_id
				LEFT JOIN sellers s ON s.id = q.seller_id
				LEFT JOIN client_contacts cc ON cc.id = q.client_contact_id
				LEFT JOIN LATERAL (
					SELECT c.id, c.contract_number FROM contracts c WHERE c.quote_id = q.id AND c.holding_id = q.holding_id ORDER BY c.created_at LIMIT 1
				) ct ON true
				${base} ${stageFilter}
				ORDER BY ${orderColumn} ${direction} NULLS LAST, q.id
				LIMIT ${Number(limit)} OFFSET ${Number(offset)}`,
				params
			),
			this.dataSource.query<Row[]>(
				`SELECT qs.id, qs.name, qs.color, qs.position, COUNT(q.id) AS count
				FROM quote_stages qs
				LEFT JOIN quotes q ON q.quote_stage_id = qs.id AND ${filters.join(' AND ')}
				WHERE qs.holding_id = $2
				GROUP BY qs.id
				ORDER BY qs.position NULLS LAST, qs.name`,
				stageParams
			),
		]);
		const stageList = stages.map((stage) => ({
			id: String(stage.id),
			name: String(stage.name),
			color: text(stage.color),
			count: toNumber(stage.count),
		}));
		const all = stageList.reduce((sum, stage) => sum + stage.count, 0);
		const total = stageId ? (stageList.find((stage) => stage.id === stageId)?.count ?? 0) : all;

		return {
			data: rows.map((row) => ({
				id: String(row.id),
				quote_number: text(row.quote_number),
				quote_date: text(row.quote_date),
				booking_date: text(row.booking_date),
				quote_type: text(row.quote_type),
				currency: text(row.currency),
				total_amount: toNumber(row.total_amount),
				payment_terms: text(row.payment_terms),
				notes: text(row.notes),
				stage: row.stage_id ? { id: String(row.stage_id), name: String(row.stage_name), color: text(row.stage_color) } : null,
				seller_name: text(row.seller_name),
				contact_name: text(row.contact_name),
				items_count: toNumber(row.items_count),
				contract: row.contract_id ? { id: String(row.contract_id), contract_number: text(row.contract_number) } : null,
			})),
			items: total,
			pages: Math.max(1, Math.ceil(total / limit)),
			currentPage: page,
			limit,
			stages: stageList,
			all_count: all,
		};
	}

	/** Ítems de una cotización del cliente (panel de detalle). 404 si la cotización no es del cliente y holding. */
	async getQuoteItems(clientId: string, quoteId: string, holdingId: string) {
		const quote = await this.dataSource.query<Row[]>(`SELECT 1 FROM quotes WHERE id = $1 AND client_id = $2 AND holding_id = $3`, [
			quoteId,
			clientId,
			holdingId,
		]);

		if (quote.length === 0) throw new NotFoundException('Cotización no encontrada');

		const rows = await this.dataSource.query<Row[]>(
			`SELECT id, product_name, item_type, quantity, unit_price, unit_of_measure, currency, price, final_price, discount_type, discount_value,
				term_months, billing_frequency, billing_method, is_recurring, start_date::text AS start_date, end_date::text AS end_date
			FROM quote_items WHERE quote_id = $1 AND holding_id = $2
			ORDER BY quote_item_number NULLS LAST, id`,
			[quoteId, holdingId]
		);

		return rows.map((row) => ({
			id: String(row.id),
			product_name: text(row.product_name),
			item_type: text(row.item_type),
			quantity: row.quantity === null ? null : toNumber(row.quantity),
			unit_price: row.unit_price === null ? null : toNumber(row.unit_price),
			unit_of_measure: text(row.unit_of_measure),
			currency: text(row.currency),
			final_price: toNumber(row.final_price ?? row.price),
			discount_type: text(row.discount_type),
			discount_value: row.discount_value === null ? null : toNumber(row.discount_value),
			term_months: row.term_months === null ? null : toNumber(row.term_months),
			billing_frequency: text(row.billing_frequency),
			billing_method: text(row.billing_method),
			is_recurring: Boolean(row.is_recurring),
			start_date: text(row.start_date),
			end_date: text(row.end_date),
		}));
	}
}
