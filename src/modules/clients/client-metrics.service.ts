import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { HoldingMetricsService } from '@/modules/metrics/holding-metrics.service';

import type { ClientContractSortField, ClientContractStatusFilter } from './dtos/query-client-contracts.dto';
import type { ClientInvoiceSortField, ClientInvoiceStatusFilter } from './dtos/query-client-invoices.dto';

type Row = Record<string, string | number | null>;

/**
 * Estados de factura que cuentan como cartera abierta. Mismo criterio que Facturación de la app
 * actual (`useFacturacionData`): emitida, enviada o vencida, sumando `total_system_currency`.
 */
export const OPEN_INVOICE_STATUSES = ['Emitida', 'Enviada', 'Vencida'];

export interface ClientSummary {
	client_id: string;
	as_of: string;
	currency: string;
	active_contracts: number;
	next_renewal: { contract_id: string; contract_number: string | null; end_date: string; days: number } | null;
	mrr: { value: number; previous: number; trend: number };
	receivable: { amount: number; count: number };
	overdue: { amount: number; count: number; oldest_days: number };
	invoiced_last_12m: number;
}

export interface ClientReceivables {
	client_id: string;
	as_of: string;
	currency: string;
	buckets: Array<{ key: 'current' | 'd1_30' | 'd31_60' | 'd61_90' | 'd90_plus'; label: string; amount: number; count: number }>;
	invoices: Array<{
		id: string;
		invoice_number: string | null;
		legal_name: string | null;
		issue_date: string | null;
		due_date: string | null;
		days_overdue: number;
		amount: number;
		invoice_currency: string | null;
		amount_invoice_currency: number;
		status: string;
	}>;
}

export interface ClientsListSummary {
	as_of: string;
	currency: string;
	mrr: number;
	active_clients: number;
	receivable: number;
	overdue: { amount: number; clients: number };
}

export interface ContractListFilters {
	page?: number;
	limit?: number;
	status?: ClientContractStatusFilter;
	entityId?: string;
	search?: string;
	sortBy?: ClientContractSortField;
	sortOrder?: 'asc' | 'desc';
}

const toNumber = (value: unknown) => Number(value ?? 0) || 0;
const isoDate = (date: Date) => date.toISOString().slice(0, 10);

/**
 * Métricas de clientes para el rediseño (resumen y cartera). Todas las consultas se acotan al holding
 * recibido y verifican que el cliente pertenezca a él.
 */
@Injectable()
export class ClientMetricsService {
	constructor(
		private readonly dataSource: DataSource,
		private readonly holdingMetrics: HoldingMetricsService
	) {}

	/**
	 * Moneda del sistema del holding (`holding_settings.system_currency`), la de todos los montos `*_system_currency`.
	 * Sin fila de configuración, la de sus facturas; si no hay nada, USD.
	 */
	private async holdingCurrency(holdingId: string, fallback?: unknown): Promise<string> {
		const [row] = await this.dataSource.query<Row[]>(`SELECT system_currency FROM holding_settings WHERE holding_id = $1 LIMIT 1`, [holdingId]);

		return (row?.system_currency as string) || (fallback as string) || 'USD';
	}

	private async assertClientInHolding(clientId: string, holdingId: string) {
		const rows = await this.dataSource.query<Row[]>(`SELECT 1 FROM clients WHERE id = $1 AND holding_id = $2`, [clientId, holdingId]);

		if (rows.length === 0) throw new NotFoundException('Cliente no encontrado');
	}

	/** MRR del cliente en el mes de `asOf` y el anterior (mismas fuentes que el dashboard). */
	private async getMrr(clientId: string, holdingId: string, asOf: string) {
		const [row] = await this.dataSource.query<Row[]>(
			`WITH months AS (SELECT date_trunc('month', $3::date) AS cur, date_trunc('month', $3::date) - interval '1 month' AS prev),
			mrr AS (
				SELECT r.period_month, r.mrr_period_system_ccy AS value
				FROM revenue_schedule_monthly r
				JOIN contracts c ON c.id = r.contract_id
				WHERE r.holding_id = $2 AND r.is_total_row = false AND c.client_id = $1
				UNION ALL
				SELECT r.period_month, r.mrr_period_system_ccy
				FROM revenue_schedule_monthly r
				JOIN subscriptions s ON s.id = r.subscription_id
				WHERE r.holding_id = $2 AND s.client_id = $1
				UNION ALL
				SELECT period_month, mrr_legacy_system_currency
				FROM mrr_legacy
				WHERE holding_id = $2 AND client_id = $1
			)
			SELECT
				COALESCE(SUM(value) FILTER (WHERE period_month = (SELECT cur FROM months)), 0) AS current,
				COALESCE(SUM(value) FILTER (WHERE period_month = (SELECT prev FROM months)), 0) AS previous
			FROM mrr`,
			[clientId, holdingId, asOf]
		);
		const current = toNumber(row?.current);
		const previous = toNumber(row?.previous);

		return { value: current, previous, trend: previous > 0 ? ((current - previous) / previous) * 100 : 0 };
	}

	async getSummary(clientId: string, holdingId: string, asOfDate = new Date()): Promise<ClientSummary> {
		await this.assertClientInHolding(clientId, holdingId);
		const asOf = isoDate(asOfDate);

		const [contracts, invoices, mrr] = await Promise.all([
			this.dataSource.query<Row[]>(
				`SELECT
					COUNT(*) FILTER (WHERE status = 'Activo' AND (contract_end_date IS NULL OR contract_end_date >= $3::date)) AS active_contracts,
					(SELECT json_build_object('contract_id', id, 'contract_number', contract_number, 'end_date', contract_end_date, 'days', contract_end_date - $3::date)
						FROM contracts
						WHERE client_id = $1 AND holding_id = $2 AND status = 'Activo' AND contract_end_date >= $3::date
						ORDER BY contract_end_date ASC LIMIT 1) AS next_renewal
				FROM contracts
				WHERE client_id = $1 AND holding_id = $2`,
				[clientId, holdingId, asOf]
			),
			this.dataSource.query<Row[]>(
				`SELECT
					MAX(system_currency) AS currency,
					COALESCE(SUM(total_system_currency) FILTER (WHERE status = ANY($4)), 0) AS receivable_amount,
					COUNT(*) FILTER (WHERE status = ANY($4)) AS receivable_count,
					COALESCE(SUM(total_system_currency) FILTER (WHERE status = ANY($4) AND due_date < $3::date), 0) AS overdue_amount,
					COUNT(*) FILTER (WHERE status = ANY($4) AND due_date < $3::date) AS overdue_count,
					COALESCE(MAX($3::date - due_date) FILTER (WHERE status = ANY($4) AND due_date < $3::date), 0) AS oldest_days,
					COALESCE(SUM(total_system_currency) FILTER (WHERE status IN ('Emitida', 'Enviada', 'Vencida', 'Pagada') AND issue_date > $3::date - interval '12 months'), 0) AS invoiced_12m
				FROM invoices
				WHERE client_id = $1 AND holding_id = $2 AND is_active = true`,
				[clientId, holdingId, asOf, OPEN_INVOICE_STATUSES]
			),
			this.getMrr(clientId, holdingId, asOf),
		]);

		const contractRow = contracts[0] ?? {};
		const invoiceRow = invoices[0] ?? {};
		const renewal = contractRow.next_renewal as unknown as ClientSummary['next_renewal'] | null;

		return {
			client_id: clientId,
			as_of: asOf,
			currency: await this.holdingCurrency(holdingId, invoiceRow.currency),
			active_contracts: toNumber(contractRow.active_contracts),
			next_renewal: renewal ? { ...renewal, days: toNumber(renewal.days) } : null,
			mrr,
			receivable: { amount: toNumber(invoiceRow.receivable_amount), count: toNumber(invoiceRow.receivable_count) },
			overdue: {
				amount: toNumber(invoiceRow.overdue_amount),
				count: toNumber(invoiceRow.overdue_count),
				oldest_days: toNumber(invoiceRow.oldest_days),
			},
			invoiced_last_12m: toNumber(invoiceRow.invoiced_12m),
		};
	}

	async getReceivables(clientId: string, holdingId: string, asOfDate = new Date()): Promise<ClientReceivables> {
		await this.assertClientInHolding(clientId, holdingId);
		const asOf = isoDate(asOfDate);

		const rows = await this.dataSource.query<Row[]>(
			`SELECT i.id, i.invoice_number, ce.legal_name, i.issue_date::text AS issue_date, i.due_date::text AS due_date,
				GREATEST($3::date - i.due_date, 0) AS days_overdue, i.total_system_currency AS amount, i.system_currency,
				i.invoice_currency, i.total_invoice_currency AS amount_invoice_currency, i.status
			FROM invoices i
			LEFT JOIN client_entities ce ON ce.id = i.client_entity_id
			WHERE i.client_id = $1 AND i.holding_id = $2 AND i.is_active = true AND i.status = ANY($4)
			ORDER BY i.due_date ASC NULLS LAST`,
			[clientId, holdingId, asOf, OPEN_INVOICE_STATUSES]
		);

		const bucketOf = (days: number, due: unknown) =>
			!due || days <= 0 ? 'current' : days <= 30 ? 'd1_30' : days <= 60 ? 'd31_60' : days <= 90 ? 'd61_90' : 'd90_plus';
		const buckets: ClientReceivables['buckets'] = [
			{ key: 'current', label: 'Por vencer', amount: 0, count: 0 },
			{ key: 'd1_30', label: '1–30 días', amount: 0, count: 0 },
			{ key: 'd31_60', label: '31–60 días', amount: 0, count: 0 },
			{ key: 'd61_90', label: '61–90 días', amount: 0, count: 0 },
			{ key: 'd90_plus', label: 'Más de 90 días', amount: 0, count: 0 },
		];

		const invoices = rows.map((row) => {
			const days = toNumber(row.days_overdue);
			const bucket = buckets.find((candidate) => candidate.key === bucketOf(days, row.due_date))!;

			bucket.amount += toNumber(row.amount);
			bucket.count += 1;

			return {
				id: row.id as string,
				invoice_number: (row.invoice_number as string) ?? null,
				legal_name: (row.legal_name as string) ?? null,
				issue_date: (row.issue_date as string) ?? null,
				due_date: (row.due_date as string) ?? null,
				days_overdue: days,
				amount: toNumber(row.amount),
				invoice_currency: (row.invoice_currency as string) ?? null,
				amount_invoice_currency: toNumber(row.amount_invoice_currency),
				status: row.status as string,
			};
		});

		return { client_id: clientId, as_of: asOf, currency: await this.holdingCurrency(holdingId, rows[0]?.system_currency), buckets, invoices };
	}

	/** Totales de la lista de clientes del holding: MRR del mes, cartera abierta y vencida. */
	async getListSummary(holdingId: string, asOfDate = new Date()): Promise<ClientsListSummary> {
		const asOf = isoDate(asOfDate);

		// MRR y clientes activos: la misma definición del Dashboard (HoldingMetricsService).
		const [metrics, [arRow]] = await Promise.all([
			this.holdingMetrics.monthMetrics(holdingId, asOf),
			this.dataSource.query<Row[]>(
				`SELECT
					MAX(system_currency) AS currency,
					COALESCE(SUM(total_system_currency), 0) AS receivable,
					COALESCE(SUM(total_system_currency) FILTER (WHERE due_date < $2::date), 0) AS overdue_amount,
					COUNT(DISTINCT client_id) FILTER (WHERE due_date < $2::date) AS overdue_clients
				FROM invoices
				WHERE holding_id = $1 AND is_active = true AND status = ANY($3)`,
				[holdingId, asOf, OPEN_INVOICE_STATUSES]
			),
		]);

		return {
			as_of: asOf,
			currency: metrics.currency,
			mrr: metrics.mrr.value,
			/** Clientes con MRR > 0 en el mes (igual que el Dashboard). */
			active_clients: metrics.activeClients.value,
			receivable: toNumber(arRow?.receivable),
			overdue: { amount: toNumber(arRow?.overdue_amount), clients: toNumber(arRow?.overdue_clients) },
		};
	}

	/**
	 * Facturas del cliente (todas sus razones sociales), paginadas, con filtro de estado, razón social y
	 * búsqueda por número. `counts` trae cuántas hay por estado con los demás filtros aplicados, para los
	 * chips de la pestaña. "Por Emitir" queda fuera (son borradores de Facturación).
	 */
	async getInvoices(
		clientId: string,
		holdingId: string,
		{
			page = 1,
			limit = 20,
			status = 'all',
			entityId,
			search,
			sortBy = 'issue_date',
			sortOrder = 'desc',
		}: {
			page?: number;
			limit?: number;
			status?: ClientInvoiceStatusFilter;
			entityId?: string;
			search?: string;
			sortBy?: ClientInvoiceSortField;
			sortOrder?: 'asc' | 'desc';
		},
		asOfDate = new Date()
	) {
		await this.assertClientInHolding(clientId, holdingId);
		const params: unknown[] = [clientId, holdingId, isoDate(asOfDate), OPEN_INVOICE_STATUSES];
		const filters = [`i.client_id = $1`, `i.holding_id = $2`, `i.is_active = true`, `i.status <> 'Por Emitir'`];

		if (entityId === 'none') filters.push(`i.client_entity_id IS NULL`);
		else if (entityId) filters.push(`i.client_entity_id = $${params.push(entityId)}`);
		if (search?.trim()) filters.push(`i.invoice_number ILIKE $${params.push(`%${search.trim()}%`)}`);
		const base = `WHERE ${filters.join(' AND ')}`;
		const statusFilter = {
			open: `AND i.status = ANY($4)`,
			overdue: `AND i.status = ANY($4) AND i.due_date < $3::date`,
			paid: `AND i.status = 'Pagada'`,
			all: '',
		}[status];
		// Lista blanca: el campo de orden nunca viene del usuario tal cual.
		const orderColumn = {
			issue_date: 'i.issue_date',
			due_date: 'i.due_date',
			amount: 'i.total_system_currency',
			invoice_number: 'i.invoice_number',
			status: 'i.status',
			days_overdue: 'days_overdue',
		}[sortBy];
		const direction = sortOrder === 'asc' ? 'ASC' : 'DESC';
		const offset = (page - 1) * limit;

		const [rows, [countRow]] = await Promise.all([
			this.dataSource.query<Row[]>(
				`SELECT i.id, i.invoice_number, i.issue_date::text AS issue_date, i.due_date::text AS due_date, i.status,
					i.total_system_currency AS amount, i.invoice_currency, i.total_invoice_currency AS amount_invoice_currency,
					ce.id AS client_entity_id, ce.legal_name, ct.contract_number,
					CASE WHEN i.status = ANY($4) AND i.due_date < $3::date THEN $3::date - i.due_date ELSE 0 END AS days_overdue
				FROM invoices i
				LEFT JOIN client_entities ce ON ce.id = i.client_entity_id
				LEFT JOIN contracts ct ON ct.id = i.contract_id
				${base} ${statusFilter}
				ORDER BY ${orderColumn} ${direction} NULLS LAST, i.id
				LIMIT ${Number(limit)} OFFSET ${Number(offset)}`,
				params
			),
			this.dataSource.query<Row[]>(
				`SELECT COUNT(*) AS all_count,
					COUNT(*) FILTER (WHERE i.status = ANY($4)) AS open_count,
					COUNT(*) FILTER (WHERE i.status = ANY($4) AND i.due_date < $3::date) AS overdue_count,
					COUNT(*) FILTER (WHERE i.status = 'Pagada') AS paid_count
				FROM invoices i ${base}`,
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
				client_entity_id: (row.client_entity_id as string) ?? null,
				legal_name: (row.legal_name as string) ?? null,
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

	/**
	 * Contratos del cliente (todas sus razones sociales), paginados, con conteo por estado. Inicio = el
	 * primer `start_date` de sus ítems; fin = `contract_end_date`; MRR = RSM del mes de `asOf` en moneda del
	 * sistema (misma fuente que los indicadores) y en moneda del contrato.
	 */
	async getContracts(clientId: string, holdingId: string, filters: ContractListFilters, asOfDate = new Date()) {
		await this.assertClientInHolding(clientId, holdingId);

		return this.listContracts({ column: 'c.client_id', id: clientId }, holdingId, filters, asOfDate);
	}

	/** Contratos de una razón social (Razón social 360), con filtro opcional por cliente comercial. */
	async getEntityContracts(entityId: string, holdingId: string, filters: ContractListFilters & { clientId?: string }, asOfDate = new Date()) {
		const rows = await this.dataSource.query<Row[]>(`SELECT 1 FROM client_entities WHERE id = $1 AND holding_id = $2`, [entityId, holdingId]);

		if (rows.length === 0) throw new NotFoundException('Razón social no encontrada');

		return this.listContracts({ column: 'c.client_entity_id', id: entityId }, holdingId, filters, asOfDate);
	}

	private async listContracts(
		scope: { column: 'c.client_id' | 'c.client_entity_id'; id: string },
		holdingId: string,
		{
			page = 1,
			limit = 25,
			status = 'all',
			entityId,
			clientId,
			search,
			sortBy = 'start_date',
			sortOrder = 'desc',
		}: ContractListFilters & { clientId?: string },
		asOfDate: Date
	) {
		const params: unknown[] = [scope.id, holdingId, isoDate(asOfDate)];
		const filters = [`${scope.column} = $1`, `c.holding_id = $2`];

		if (clientId) filters.push(`c.client_id = $${params.push(clientId)}`);
		if (entityId === 'none') filters.push(`c.client_entity_id IS NULL`);
		else if (entityId) filters.push(`c.client_entity_id = $${params.push(entityId)}`);
		if (search?.trim()) filters.push(`c.contract_number ILIKE $${params.push(`%${search.trim()}%`)}`);
		const base = `WHERE ${filters.join(' AND ')}`;
		const statusFilter = {
			active: `AND c.status = 'Activo' AND (c.contract_end_date IS NULL OR c.contract_end_date >= $3::date)`,
			expired: `AND c.status = 'Activo' AND c.contract_end_date < $3::date`,
			in_review: `AND c.status = 'En revisión'`,
			cancelled: `AND c.status = 'Cancelado'`,
			all: '',
		}[status];
		// Lista blanca: el campo de orden nunca viene del usuario tal cual.
		const orderColumn = {
			contract_number: 'c.contract_number',
			start_date: 'start_date',
			end_date: 'c.contract_end_date',
			mrr: 'mrr',
			total_value: 'c.total_value_system_currency',
			status: 'c.status',
		}[sortBy];
		const direction = sortOrder === 'asc' ? 'ASC' : 'DESC';
		const offset = (page - 1) * limit;

		const [rows, [countRow]] = await Promise.all([
			this.dataSource.query<Row[]>(
				`SELECT c.id, c.contract_number, c.status, c.type, c.contract_currency, c.system_currency, c.client_id, cl.name_commercial AS client_name,
					c.total_value, c.total_value_system_currency,
					c.contract_end_date::text AS end_date,
					CASE WHEN c.status = 'Activo' AND c.contract_end_date >= $3::date THEN c.contract_end_date - $3::date END AS days_to_end,
					CASE WHEN c.status = 'Activo' AND c.contract_end_date < $3::date THEN $3::date - c.contract_end_date END AS days_since_end,
					ce.id AS client_entity_id, ce.legal_name, co.legal_name AS company_name,
					items.start_date::text AS start_date, COALESCE(items.items_count, 0) AS items_count,
					COALESCE(rsm.mrr, 0) AS mrr, COALESCE(rsm.mrr_contract_ccy, 0) AS mrr_contract_ccy
				FROM contracts c
				LEFT JOIN clients cl ON cl.id = c.client_id
				LEFT JOIN client_entities ce ON ce.id = c.client_entity_id
				LEFT JOIN companies co ON co.id = c.company_id
				LEFT JOIN LATERAL (
					SELECT MIN(ci.start_date) AS start_date, COUNT(*) AS items_count FROM contract_items ci WHERE ci.contract_id = c.id
				) items ON true
				LEFT JOIN LATERAL (
					SELECT SUM(r.mrr_period_system_ccy) AS mrr, SUM(r.mrr_period_contract_ccy) AS mrr_contract_ccy
					FROM revenue_schedule_monthly r
					WHERE r.contract_id = c.id AND r.holding_id = $2 AND r.is_total_row = false AND r.period_month = date_trunc('month', $3::date)
				) rsm ON true
				${base} ${statusFilter}
				ORDER BY ${orderColumn} ${direction} NULLS LAST, c.id
				LIMIT ${Number(limit)} OFFSET ${Number(offset)}`,
				params
			),
			this.dataSource.query<Row[]>(
				// Comparte `params` con la lista: `$3` (fecha) se tipa aunque el conteo no la use, o Postgres falla.
				`SELECT $3::date AS as_of, COUNT(*) AS all_count,
					COUNT(*) FILTER (WHERE c.status = 'Activo' AND (c.contract_end_date IS NULL OR c.contract_end_date >= $3::date)) AS active_count,
					COUNT(*) FILTER (WHERE c.status = 'Activo' AND c.contract_end_date < $3::date) AS expired_count,
					COUNT(*) FILTER (WHERE c.status = 'En revisión') AS in_review_count,
					COUNT(*) FILTER (WHERE c.status = 'Cancelado') AS cancelled_count
				FROM contracts c ${base}`,
				params
			),
		]);
		const counts = {
			all: toNumber(countRow?.all_count),
			active: toNumber(countRow?.active_count),
			expired: toNumber(countRow?.expired_count),
			in_review: toNumber(countRow?.in_review_count),
			cancelled: toNumber(countRow?.cancelled_count),
		};
		const total = counts[status];

		return {
			data: rows.map((row) => ({
				id: row.id as string,
				contract_number: (row.contract_number as string) ?? null,
				status: row.status as string,
				type: (row.type as string) || null,
				client_id: (row.client_id as string) ?? null,
				client_name: (row.client_name as string) ?? null,
				client_entity_id: (row.client_entity_id as string) ?? null,
				legal_name: (row.legal_name as string) ?? null,
				company_name: (row.company_name as string) ?? null,
				start_date: (row.start_date as string) ?? null,
				end_date: (row.end_date as string) ?? null,
				days_to_end: row.days_to_end === null || row.days_to_end === undefined ? null : toNumber(row.days_to_end),
				/** Activo con fin ya pasado (vencido sin renovar ni cerrar). */
				days_since_end: row.days_since_end === null || row.days_since_end === undefined ? null : toNumber(row.days_since_end),
				contract_currency: (row.contract_currency as string) ?? null,
				system_currency: (row.system_currency as string) ?? null,
				mrr: toNumber(row.mrr),
				mrr_contract_ccy: toNumber(row.mrr_contract_ccy),
				total_value: toNumber(row.total_value),
				total_value_system_currency: toNumber(row.total_value_system_currency),
				items_count: toNumber(row.items_count),
			})),
			items: total,
			pages: Math.max(1, Math.ceil(total / limit)),
			currentPage: page,
			limit,
			counts,
		};
	}
}
