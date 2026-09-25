import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { clientLifecycleSql, type ClientLifecycleStatus } from './client-lifecycle';
import { OPEN_INVOICE_STATUSES } from './client-metrics.service';

type Row = Record<string, unknown>;

const toNumber = (value: unknown) => Number(value ?? 0) || 0;
const toNullableNumber = (value: unknown) => (value === null || value === undefined ? null : Number(value));
const isoDate = (date: Date) => date.toISOString().slice(0, 10);

export type EntityInvoiceStatusFilter = 'open' | 'overdue' | 'paid' | 'all';

/**
 * Razón social 360 (`client_entities`): una razón social puede facturar a varios clientes
 * comerciales (`client_entity_clients`). Todo se acota al holding y verifica pertenencia.
 * Criterio de cartera: el mismo de `ClientMetricsService` (Emitida/Enviada/Vencida).
 */
@Injectable()
export class ClientEntityMetricsService {
	constructor(private readonly dataSource: DataSource) {}

	private async findEntity(entityId: string, holdingId: string) {
		const [entity] = await this.dataSource.query<Row[]>(
			`SELECT id, legal_name, tax_id, country, legal_address, email, phone, economic_activity, client_number,
				odoo_partner_id, odoo_fiscal_position_name, payment_terms
			FROM client_entities WHERE id = $1 AND holding_id = $2`,
			[entityId, holdingId]
		);

		if (!entity) throw new NotFoundException('Razón social no encontrada');

		return entity;
	}

	/** Datos de la razón social y los clientes comerciales a los que factura, con su aporte a la cartera. */
	async getDetail(entityId: string, holdingId: string, asOfDate = new Date()) {
		const entity = await this.findEntity(entityId, holdingId);
		const asOf = isoDate(asOfDate);

		const clients = await this.dataSource.query<Row[]>(
			`SELECT c.id, c.name_commercial, c.client_number, c.status, ${clientLifecycleSql('c')} AS lifecycle_status, ece.is_primary,
				(SELECT COUNT(*) FROM contracts ct WHERE ct.client_id = c.id AND ct.client_entity_id = $1 AND ct.status = 'Activo'
					AND (ct.contract_end_date IS NULL OR ct.contract_end_date >= $4::date)) AS active_contracts,
				COALESCE((SELECT SUM(i.total_system_currency) FROM invoices i
					WHERE i.client_entity_id = $1 AND i.client_id = c.id AND i.is_active AND i.status = ANY($3)), 0) AS receivable,
				COALESCE((SELECT SUM(i.total_system_currency) FROM invoices i
					WHERE i.client_entity_id = $1 AND i.client_id = c.id AND i.is_active AND i.status = ANY($3) AND i.due_date < $4::date), 0) AS overdue,
				COALESCE((SELECT SUM(i.total_system_currency) FROM invoices i
					WHERE i.client_entity_id = $1 AND i.client_id = c.id AND i.is_active AND i.status IN ('Emitida', 'Enviada', 'Vencida', 'Pagada')
					AND i.issue_date > $4::date - interval '12 months'), 0) AS invoiced_12m
			FROM client_entity_clients ece
			JOIN clients c ON c.id = ece.client_id AND c.holding_id = $2
			WHERE ece.client_entity_id = $1
			ORDER BY ece.is_primary DESC, c.name_commercial ASC`,
			[entityId, holdingId, OPEN_INVOICE_STATUSES, asOf]
		);

		return {
			...entity,
			odoo_partner_id: toNullableNumber(entity.odoo_partner_id),
			clients: clients.map((client) => ({
				id: client.id as string,
				name_commercial: (client.name_commercial as string) ?? null,
				client_number: (client.client_number as string) ?? null,
				status: (client.status as string) ?? null,
				lifecycle_status: (client.lifecycle_status as ClientLifecycleStatus) ?? null,
				is_primary: Boolean(client.is_primary),
				active_contracts: toNumber(client.active_contracts),
				receivable: toNumber(client.receivable),
				overdue: toNumber(client.overdue),
				invoiced_12m: toNumber(client.invoiced_12m),
			})),
		};
	}

	/**
	 * Indicadores: facturado 12 meses, cartera por antigüedad y comportamiento de pago. Con `clientId`, solo lo
	 * facturado a ese cliente comercial (filtro de la tarjeta de clientes de la Razón social 360).
	 */
	async getSummary(entityId: string, holdingId: string, asOfDate = new Date(), clientId?: string) {
		await this.findEntity(entityId, holdingId);
		const asOf = isoDate(asOfDate);
		const params: unknown[] = [entityId, holdingId, asOf, OPEN_INVOICE_STATUSES];
		const clientFilter = clientId ? `AND client_id = $${params.push(clientId)}` : '';

		const [row] = await this.dataSource.query<Row[]>(
			`WITH inv AS (
				SELECT * FROM invoices WHERE client_entity_id = $1 AND holding_id = $2 AND is_active = true ${clientFilter}
			), paid AS (
				SELECT inv.issue_date, inv.due_date, p.paid_at
				FROM inv JOIN (SELECT invoice_id, MAX(payment_date) AS paid_at FROM invoice_payments WHERE confirmed GROUP BY invoice_id) p ON p.invoice_id = inv.id
				WHERE inv.issue_date > $3::date - interval '12 months'
			)
			SELECT
				COALESCE((SELECT hs.system_currency FROM holding_settings hs WHERE hs.holding_id = $2), (SELECT MAX(system_currency) FROM inv), 'USD') AS currency,
				(SELECT COUNT(*) FROM inv WHERE status IN ('Emitida', 'Enviada', 'Vencida', 'Pagada') AND issue_date > $3::date - interval '12 months') AS invoiced_count,
				(SELECT COALESCE(SUM(total_system_currency), 0) FROM inv WHERE status IN ('Emitida', 'Enviada', 'Vencida', 'Pagada') AND issue_date > $3::date - interval '12 months') AS invoiced_amount,
				(SELECT COUNT(*) FROM inv WHERE status = ANY($4)) AS receivable_count,
				(SELECT COALESCE(SUM(total_system_currency), 0) FROM inv WHERE status = ANY($4)) AS receivable_amount,
				(SELECT COUNT(*) FROM inv WHERE status = ANY($4) AND due_date < $3::date) AS overdue_count,
				(SELECT COALESCE(SUM(total_system_currency), 0) FROM inv WHERE status = ANY($4) AND due_date < $3::date) AS overdue_amount,
				(SELECT COALESCE(MAX($3::date - due_date), 0) FROM inv WHERE status = ANY($4) AND due_date < $3::date) AS oldest_days,
				(SELECT ROUND(AVG(paid_at - issue_date)) FROM paid) AS avg_payment_days,
				(SELECT ROUND(AVG(paid_at - due_date)) FROM paid WHERE due_date IS NOT NULL) AS avg_days_late,
				(SELECT ROUND(AVG(due_date - issue_date)) FROM inv WHERE due_date IS NOT NULL AND issue_date > $3::date - interval '12 months') AS avg_terms_days`,
			params
		);

		return {
			client_entity_id: entityId,
			as_of: asOf,
			currency: (row?.currency as string) || 'USD',
			invoiced_last_12m: { amount: toNumber(row?.invoiced_amount), count: toNumber(row?.invoiced_count) },
			receivable: { amount: toNumber(row?.receivable_amount), count: toNumber(row?.receivable_count) },
			overdue: { amount: toNumber(row?.overdue_amount), count: toNumber(row?.overdue_count), oldest_days: toNumber(row?.oldest_days) },
			payment_behavior: {
				avg_payment_days: toNullableNumber(row?.avg_payment_days),
				avg_days_late: toNullableNumber(row?.avg_days_late),
				avg_terms_days: toNullableNumber(row?.avg_terms_days),
			},
		};
	}

	/** Facturas emitidas a la razón social, paginadas, con filtro por cliente comercial y estado. */
	async getInvoices(
		entityId: string,
		holdingId: string,
		{ page = 1, limit = 20, clientId, status = 'all' }: { page?: number; limit?: number; clientId?: string; status?: EntityInvoiceStatusFilter },
		asOfDate = new Date()
	) {
		await this.findEntity(entityId, holdingId);
		const asOf = isoDate(asOfDate);
		const statusFilter = {
			open: `AND i.status = ANY($4)`,
			overdue: `AND i.status = ANY($4) AND i.due_date < $3::date`,
			paid: `AND i.status = 'Pagada'`,
			all: `AND i.status <> 'Por Emitir'`,
		}[status];
		const params: unknown[] = [entityId, holdingId, asOf, OPEN_INVOICE_STATUSES];
		const clientFilter = clientId ? `AND i.client_id = $${params.push(clientId)}` : '';
		const where = `WHERE i.client_entity_id = $1 AND i.holding_id = $2 AND i.is_active = true ${statusFilter} ${clientFilter}`;
		const offset = (page - 1) * limit;

		const [rows, [countRow]] = await Promise.all([
			this.dataSource.query<Row[]>(
				`SELECT i.id, i.invoice_number, i.issue_date::text AS issue_date, i.due_date::text AS due_date, i.status,
					i.total_system_currency AS amount, i.invoice_currency, i.total_invoice_currency AS amount_invoice_currency,
					c.id AS client_id, c.name_commercial AS client_name, ct.contract_number,
					CASE WHEN i.status = ANY($4) AND i.due_date < $3::date THEN $3::date - i.due_date ELSE 0 END AS days_overdue
				FROM invoices i
				LEFT JOIN clients c ON c.id = i.client_id
				LEFT JOIN contracts ct ON ct.id = i.contract_id
				${where}
				ORDER BY i.issue_date DESC NULLS LAST, i.id
				LIMIT ${Number(limit)} OFFSET ${Number(offset)}`,
				params
			),
			// Mismos `params` que la consulta principal: $3 y $4 se tipan aquí aunque el filtro de estado no los use.
			// Conteo por estado con los demás filtros (cliente), para los chips de la tabla.
			this.dataSource.query<Row[]>(
				`SELECT COUNT(*) FILTER (WHERE i.status <> 'Por Emitir') AS all_count,
					COUNT(*) FILTER (WHERE i.status = ANY($4)) AS open_count,
					COUNT(*) FILTER (WHERE i.status = ANY($4) AND i.due_date < $3::date) AS overdue_count,
					COUNT(*) FILTER (WHERE i.status = 'Pagada') AS paid_count
				FROM invoices i WHERE i.client_entity_id = $1 AND i.holding_id = $2 AND i.is_active = true ${clientFilter}`,
				params
			),
		]);
		const counts = {
			all: toNumber(countRow?.all_count),
			open: toNumber(countRow?.open_count),
			overdue: toNumber(countRow?.overdue_count),
			paid: toNumber(countRow?.paid_count),
		};
		const total = counts[status];

		return {
			data: rows.map((row) => ({
				id: row.id as string,
				invoice_number: (row.invoice_number as string) ?? null,
				issue_date: (row.issue_date as string) ?? null,
				due_date: (row.due_date as string) ?? null,
				status: row.status as string,
				amount: toNumber(row.amount),
				invoice_currency: (row.invoice_currency as string) ?? null,
				amount_invoice_currency: toNumber(row.amount_invoice_currency),
				client_id: (row.client_id as string) ?? null,
				client_name: (row.client_name as string) ?? null,
				contract_number: (row.contract_number as string) ?? null,
				days_overdue: toNumber(row.days_overdue),
			})),
			items: total,
			pages: Math.max(1, Math.ceil(total / limit)),
			currentPage: page,
			limit,
			counts,
		};
	}
}
