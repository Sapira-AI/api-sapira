import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { BillingReadService } from '@/modules/billing/billing-read.service';
import { invoicesCte, SqlParams } from '@/modules/billing/billing-sql';
import { ConsumptionService } from '@/modules/contracts/consumption.service';
import { RevenueMetricsService } from '@/modules/metrics/revenue-metrics.service';
import { QUOTE_CONTRACT_LATERAL, quoteStatusLateral } from '@/modules/quotes/quote-status';

import { type Bucket, buildTasks, monthBounds, type Task, type TaskInputs } from './tasks';

type Row = Record<string, unknown>;

const num = (value: unknown) => Number(value ?? 0) || 0;
const ids = (value: unknown) => (Array.isArray(value) ? value.map(String) : []);
const empty = (): Bucket => ({ count: 0, amount: null });
/** Motivo de la cola que la tarea de bloqueadas no cuenta: factura sin contrato (solo lectura, datos a sanear antes del switch). */
export const NO_CONTRACT = 'no_contract';
/** Filtro de Facturación por compañías (`company_id` acepta `a,b`). */
const companyFilter = (companies: string[]) => (companies.length ? { company_id: companies.join(',') } : {});

export interface HoldingTasks {
	holding_id: string;
	as_of: string;
	currency: string;
	/** Compañías aplicadas ("Mis compañías"; `[]` = todas). */
	company_ids: string[];
	/** Todas las tareas (también en cero), ordenadas por gravedad. */
	tasks: Task[];
	/** Conteos que el Dashboard muestra con su definición de siempre (por renovar 30/90 y contratos vencidos). */
	dashboard: { renew_30: number; renew_90: number; expired_contracts: number; invoices_to_emit: number };
}

/**
 * Tareas del holding (Notificaciones v2 §4): **una sola función** para el centro (`GET /notifications/tasks`) y el Dashboard. Junta los
 * conteos de cada módulo con su propia regla (cola Por emitir de Facturación con sus motivos de bloqueo, vencidas y NC de `invoicesCte`,
 * consumos por informar de Contratos, excepciones de Ingresos) y SQL agregadas para el resto. Cada fuente falla aislada: una que no responde
 * deja su tarea en cero y un aviso en el log, sin tumbar el resto.
 */
@Injectable()
export class TasksService {
	private readonly logger = new Logger(TasksService.name);

	constructor(
		private readonly dataSource: DataSource,
		private readonly billing: BillingReadService,
		private readonly consumption: ConsumptionService,
		private readonly revenue: RevenueMetricsService
	) {}

	async forHolding(holdingId: string, asOf?: string, companyIds: string[] = []): Promise<HoldingTasks> {
		const today = asOf ?? (await this.billing.today(new Date(), holdingId));
		const companies = [...new Set(companyIds)];
		const [currency, queue, receivables, contracts, quotes, consumptions, exceptions] = await Promise.all([
			this.billing.systemCurrency(holdingId),
			this.safe('cola Por emitir', () => this.queueBuckets(holdingId, today, companies), {
				ready: empty(),
				late: { ...empty(), first_month: null, this_month: empty(), previous_month: empty(), older: { ...empty(), first_month: null } },
				blocked: { ...empty(), first_month: null, reasons: [] },
				total: 0,
			}),
			this.safe('vencidas y notas de crédito', () => this.receivableBuckets(holdingId, today, companies), {
				overdue: empty(),
				credit_notes: empty(),
			}),
			this.safe('contratos', () => this.contractBuckets(holdingId, today, companies), null),
			this.safe('cotizaciones', () => this.quoteBuckets(holdingId, today), { waiting_mapping: empty(), quotes_unprocessed: empty() }),
			this.safe('consumos por informar', () => this.consumptionBucket(holdingId, today, companies), empty()),
			this.safe('excepciones de Ingresos', () => this.exceptionsBucket(holdingId), empty()),
		]);
		const input: TaskInputs = {
			today,
			currency,
			queue,
			...receivables,
			proposals: contracts?.proposals ?? empty(),
			expired: contracts?.expired ?? empty(),
			pacts: contracts?.pacts ?? empty(),
			without_invoices: contracts?.without_invoices ?? empty(),
			starts: contracts?.starts ?? empty(),
			consumptions,
			...quotes,
			revenue_exceptions: exceptions,
			company_ids: companies,
		};

		return {
			holding_id: holdingId,
			as_of: today,
			currency,
			company_ids: companies,
			tasks: buildTasks(input),
			dashboard: {
				renew_30: contracts?.renew_30 ?? 0,
				renew_90: contracts?.renew_90 ?? 0,
				expired_contracts: contracts?.expired_contracts ?? 0,
				invoices_to_emit: queue.total,
			},
		};
	}

	/** Moneda del sistema del holding (montos de las tareas). */
	currency(holdingId: string): Promise<string> {
		return this.billing.systemCurrency(holdingId);
	}

	/** Lo que muestra el centro: solo las tareas con algo por hacer. */
	async pending(holdingId: string, asOf?: string, companyIds: string[] = []) {
		const result = await this.forHolding(holdingId, asOf, companyIds);

		return {
			holding_id: result.holding_id,
			as_of: result.as_of,
			currency: result.currency,
			company_ids: result.company_ids,
			tasks: result.tasks.filter((task) => task.count > 0),
		};
	}

	// ---------------------------------------------------------------- fuentes

	private async safe<T>(label: string, work: () => Promise<T>, fallback: T): Promise<T> {
		try {
			return await work();
		} catch (error) {
			this.logger.warn(`Tareas: no se pudo calcular "${label}": ${error instanceof Error ? error.message : String(error)}`);
			return fallback;
		}
	}

	/**
	 * Cola Por emitir hasta hoy (la misma de Facturación: grupos y motivos de bloqueo) + montos en moneda del sistema. La tarea de bloqueadas
	 * **no cuenta** el motivo `no_contract` (facturas sin contrato, solo lectura: restos del modelo viejo de suscripciones, datos a sanear
	 * antes del switch, no una tarea del usuario): una factura cuyo único motivo es ese no cuenta como bloqueada. `first_month` (`YYYY-MM`) es
	 * el primer mes de las facturas de cada tarea y de cada motivo: arma el enlace `desde=…&hasta=<mes en curso>`.
	 */
	private async queueBuckets(holdingId: string, today: string, companies: string[] = []) {
		const { entries } = await this.billing.queue(holdingId, companyFilter(companies), today, { until: today });
		const amounts = new Map<string, { amount: number; date: string | null }>();

		if (entries.length) {
			const rows = (await this.dataSource.query(
				`SELECT id::text AS id, amount_system_currency, COALESCE(issue_date, scheduled_at)::text AS date
				FROM invoices WHERE holding_id = $1 AND id = ANY($2::uuid[])`,
				[holdingId, entries.map((entry) => entry.id)]
			)) as Row[];

			for (const row of rows ?? [])
				amounts.set(String(row.id), { amount: num(row.amount_system_currency), date: row.date ? String(row.date).slice(0, 10) : null });
		}
		const { first, month: currentMonth, previousMonth } = monthBounds(today);
		const monthOf = (id: string) => amounts.get(id)?.date?.slice(0, 7) ?? null;
		const firstMonth = (list: Array<{ id: string }>) =>
			list
				.map((entry) => monthOf(entry.id))
				.filter((month): month is string => !!month)
				.sort()[0] ?? null;
		const bucket = (list: typeof entries): Bucket => ({
			count: list.length,
			amount: Math.round(list.reduce((sum, entry) => sum + (amounts.get(entry.id)?.amount ?? 0), 0) * 100) / 100,
		});
		const blocked = entries
			.filter((entry) => entry.group === 'blocked')
			.map((entry) => ({ ...entry, blocked_reasons: entry.blocked_reasons.filter((reason) => reason.code !== NO_CONTRACT) }))
			.filter((entry) => entry.blocked_reasons.length > 0);
		const reasons = new Map<string, { code: string; label: string; count: number; first_month: string | null }>();

		for (const entry of blocked) {
			const month = monthOf(entry.id);

			for (const reason of entry.blocked_reasons) {
				const current = reasons.get(reason.code) ?? { code: reason.code, label: reason.message, count: 0, first_month: null };

				current.count += 1;
				if (month && (!current.first_month || month < current.first_month)) current.first_month = month;
				reasons.set(reason.code, current);
			}
		}
		// Atrasadas (Domi 05-10, una sola tarea): no bloqueadas, del grupo `late` o con fecha de un mes pasado; cada factura cuenta una vez y
		// las bloqueadas solo en su tarea, para que el resumen de arriba no sume dos veces lo mismo.
		const blockedIds = new Set(blocked.map((entry) => entry.id));
		const late = entries.filter((entry) => {
			if (blockedIds.has(entry.id) || entry.group === 'blocked') return false;
			const date = amounts.get(entry.id)?.date;

			return entry.group === 'late' || Boolean(date && date < first);
		});
		const byMonth = (match: (month: string | null) => boolean) => late.filter((entry) => match(monthOf(entry.id)));
		const older = byMonth((month) => !!month && month < previousMonth);

		return {
			ready: bucket(entries.filter((entry) => entry.group === 'ready')),
			late: {
				...bucket(late),
				first_month: firstMonth(late),
				this_month: bucket(byMonth((month) => !month || month >= currentMonth)),
				previous_month: bucket(byMonth((month) => month === previousMonth)),
				older: { ...bucket(older), first_month: firstMonth(older) },
			},
			blocked: { ...bucket(blocked), first_month: firstMonth(blocked), reasons: [...reasons.values()].sort((a, b) => b.count - a.count) },
			total: entries.length,
		};
	}

	/** Vencidas (saldo en moneda del sistema) y notas de crédito por emitir: mismas reglas de estado que la lista de Facturación. */
	private async receivableBuckets(holdingId: string, today: string, companies: string[] = []): Promise<{ overdue: Bucket; credit_notes: Bucket }> {
		const params = new SqlParams();
		const { cte } = invoicesCte(holdingId, companyFilter(companies), params, { today, excludeCancelledByDefault: true });
		const [row] = (await this.dataSource.query(
			`${cte} SELECT
				COUNT(*) FILTER (WHERE d.is_overdue) AS overdue,
				COALESCE(SUM(CASE WHEN d.is_overdue AND COALESCE(d.total_due, 0) <> 0
					THEN d.balance * COALESCE(d.total_system_currency, 0) / d.total_due END), 0) AS overdue_amount,
				COUNT(*) FILTER (WHERE d.document_kind = 'credit_note' AND d.electronic_state = 'pending_emission') AS credit_notes
			FROM d`,
			params.values
		)) as Row[];

		return {
			overdue: { count: num(row?.overdue), amount: Math.round(num(row?.overdue_amount) * 100) / 100 },
			credit_notes: { count: num(row?.credit_notes), amount: null },
		};
	}

	/** Contratos en una consulta agregada (misma regla de "sin decisión" que el job de alertas de renovación). */
	private async contractBuckets(holdingId: string, today: string, companies: string[] = []) {
		const [row] = (await this.dataSource.query(
			`WITH live AS (
				SELECT c.id, c.contract_end_date FROM contracts c WHERE c.holding_id = $1 AND c.deleted_at IS NULL AND c.status = 'Activo'
					AND (cardinality($3::uuid[]) = 0 OR c.company_id = ANY($3::uuid[]))
			), undecided AS (
				SELECT ci.contract_id, ci.end_date FROM contract_items ci JOIN live ON live.id = ci.contract_id
				WHERE ci.holding_id = $1 AND ci.is_recurring = true AND ci.renewed_by_item_id IS NULL AND ci.churn_date IS NULL
					AND COALESCE(ci.categoria, '') NOT IN ('CHURN', 'DOWNSELL')
					AND NOT (ci.related_item_id IS NOT NULL AND COALESCE(ci.categoria, '') = 'UPSELL')
					AND ci.end_date IS NOT NULL
			), expired AS (SELECT DISTINCT contract_id FROM undecided WHERE end_date < $2::date),
			proposals AS (
				SELECT DISTINCT e.contract_id FROM contract_lifecycle_events e JOIN live ON live.id = e.contract_id
				WHERE e.holding_id = $1 AND e.event_type = 'RENEWAL_PROPOSED' AND e.event_status = 'Pending'
					AND COALESCE(e.metadata->>'status', 'open') = 'open'
			), pacts AS (
				SELECT sc.contract_id FROM contract_scheduled_changes sc JOIN live ON live.id = sc.contract_id
				WHERE sc.holding_id = $1 AND sc.status = 'scheduled' AND sc.trigger IN ('on_date', 'every_n_months') AND sc.parent_id IS NULL
					AND (CASE WHEN sc.trigger = 'on_date' THEN sc.effective_date ELSE COALESCE(sc.next_effective_date, sc.anchor_date) END) <= $2::date
			), without_invoices AS (
				-- Por ítem (Domi 05-10): un ítem recurrente vigente sin ninguna línea que lo cubra. Cubre una Por Emitir de cualquier fecha (las
				-- atrasadas van en su propia tarea) o una factura vigente cuyo período llega a hoy (facturación anual, semestral o trimestral
				-- ya cobrada: la próxima cae en la renovación).
				SELECT live.id AS contract_id FROM live
				WHERE EXISTS (
					SELECT 1 FROM contract_items ci WHERE ci.contract_id = live.id AND ci.holding_id = $1 AND ci.is_recurring = true
						AND ci.churn_date IS NULL AND COALESCE(ci.categoria, '') NOT IN ('CHURN', 'DOWNSELL')
						AND (ci.end_date IS NULL OR ci.end_date >= $2::date)
						AND NOT EXISTS (
							SELECT 1 FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id
							WHERE ii.contract_item_id = ci.id AND i.holding_id = $1 AND i.is_active = true
								AND COALESCE(i.document_type, 'FACTURA') NOT IN ('NC', 'ND')
								AND (i.status = 'Por Emitir' OR (i.status NOT IN ('Cancelada', 'Anulada') AND ii.billing_period_end >= $2::date))
						)
				)
			)
			SELECT
				(SELECT COUNT(*) FROM expired) AS expired, (SELECT array_agg(contract_id) FROM (SELECT contract_id FROM expired LIMIT 2) x) AS expired_ids,
				(SELECT COUNT(*) FROM proposals) AS proposals, (SELECT array_agg(contract_id) FROM (SELECT contract_id FROM proposals LIMIT 2) x) AS proposal_ids,
				(SELECT COUNT(*) FROM pacts) AS pacts,
				(SELECT array_agg(DISTINCT contract_id) FROM (SELECT DISTINCT contract_id FROM pacts LIMIT 2) x) AS pact_ids,
				(SELECT COUNT(*) FROM without_invoices) AS without_invoices,
				(SELECT array_agg(contract_id) FROM (SELECT contract_id FROM without_invoices LIMIT 2) x) AS without_invoice_ids,
				(SELECT COUNT(DISTINCT ci.id) FROM contract_items ci JOIN contracts c ON c.id = ci.contract_id
					WHERE c.holding_id = $1 AND c.deleted_at IS NULL AND ci.categoria IN ('NEW', 'UPSELL', 'CROSS-SELL') AND ci.churn_date IS NULL
						AND (cardinality($3::uuid[]) = 0 OR c.company_id = ANY($3::uuid[]))
						AND ci.start_date >= date_trunc('month', $2::date) AND ci.start_date < date_trunc('month', $2::date) + interval '1 month') AS starts,
				(SELECT COUNT(*) FROM live WHERE contract_end_date BETWEEN $2::date AND $2::date + 30) AS renew_30,
				(SELECT COUNT(*) FROM live WHERE contract_end_date BETWEEN $2::date AND $2::date + 90) AS renew_90,
				(SELECT COUNT(*) FROM live WHERE EXISTS (
					SELECT 1 FROM contract_items ci WHERE ci.contract_id = live.id AND ci.is_recurring = true AND ci.churn_date IS NULL
					GROUP BY ci.contract_id HAVING MAX(ci.end_date) < $2::date
				)) AS expired_contracts`,
			[holdingId, today, companies]
		)) as Row[];

		return {
			expired: { count: num(row?.expired), contract_ids: ids(row?.expired_ids) },
			proposals: { count: num(row?.proposals), contract_ids: ids(row?.proposal_ids) },
			pacts: { count: num(row?.pacts), contract_ids: ids(row?.pact_ids) },
			without_invoices: { count: num(row?.without_invoices), contract_ids: ids(row?.without_invoice_ids) },
			starts: { count: num(row?.starts) },
			renew_30: num(row?.renew_30),
			renew_90: num(row?.renew_90),
			expired_contracts: num(row?.expired_contracts),
		};
	}

	/**
	 * Cotizaciones: del CRM en espera de mapeo (oportunidades detenidas por un producto sin relación activa, o por esa causa y ya relacionado:
	 * falta reintentar; misma regla que el aviso de la lista) y firmadas del mes sin contrato (estado mostrado `signed`).
	 */
	private async quoteBuckets(holdingId: string, today: string): Promise<{ waiting_mapping: Bucket; quotes_unprocessed: Bucket }> {
		const [[waiting], [signed]] = (await Promise.all([
			this.dataSource.query(
				`SELECT COUNT(*) AS n FROM salesforce_opportunities_stg o
				WHERE o.holding_id = $1 AND o.processing_status = 'error' AND (
					COALESCE(o.error_message, '') ~* 'sin mapping activo' OR COALESCE(o.integration_notes, '') ~* 'sin mapping activo'
					OR EXISTS (
						SELECT 1 FROM jsonb_array_elements(
							CASE WHEN jsonb_typeof(o.raw_data->'OpportunityLineItems'->'records') = 'array' THEN o.raw_data->'OpportunityLineItems'->'records' ELSE '[]'::jsonb END
						) li
						WHERE li->>'Product2Id' IS NOT NULL AND NOT EXISTS (
							SELECT 1 FROM salesforce_product_mappings m
							WHERE m.holding_id = o.holding_id AND m.salesforce_product_id = li->>'Product2Id' AND m.is_active IS DISTINCT FROM false
						)
					)
				)`,
				[holdingId]
			),
			this.dataSource.query(
				`SELECT COUNT(*) AS n, COUNT(DISTINCT upper(COALESCE(q.currency, ''))) AS currencies, MIN(upper(q.currency)) AS currency,
					COALESCE(SUM(q.total_amount), 0) AS amount
				FROM quotes q
				LEFT JOIN quote_stages qs ON qs.id = q.quote_stage_id
				${QUOTE_CONTRACT_LATERAL}
				${quoteStatusLateral('$2')}
				WHERE q.holding_id = $1 AND q.deleted_at IS NULL AND ds.derived_status = 'signed'
					AND q.booking_date >= date_trunc('month', $2::date) AND q.booking_date < date_trunc('month', $2::date) + interval '1 month'`,
				[holdingId, today]
			),
		])) as [Row[], Row[]];
		const oneCurrency = num(signed?.currencies) === 1;

		return {
			waiting_mapping: { count: num(waiting?.n), amount: null },
			quotes_unprocessed: {
				count: num(signed?.n),
				amount: oneCurrency ? Math.round(num(signed?.amount) * 100) / 100 : null,
				currency: oneCurrency ? (signed?.currency as string | null) : null,
			},
		};
	}

	/** Líneas medidas por informar (regla de Contratos, `GET /consumption/pending`). */
	private async consumptionBucket(holdingId: string, today: string, companies: string[] = []): Promise<Bucket> {
		const at = new Date(`${today}T12:00:00.000Z`);
		// `GET /consumption/pending` filtra por una compañía: con varias, una consulta por compañía.
		const results = await Promise.all(
			(companies.length ? companies : [undefined]).map((companyId) =>
				this.consumption.pending(holdingId, { page: 1, limit: 200, ...(companyId ? { company_id: companyId } : {}) }, undefined, at)
			)
		);
		const total = results.reduce((sum, result) => sum + result.total, 0);
		const loaded = results.reduce((sum, result) => sum + result.data.length, 0);
		const contractIds = [...new Set(results.flatMap((result) => result.data.map((row) => row.contract.id)))];

		// Con más líneas que la página no se sabe si son de un solo contrato: el enlace va a la lista.
		return { count: total, contract_ids: total > loaded ? [] : contractIds.slice(0, 2) };
	}

	/**
	 * Cierre de mes (§8.6): Por Emitir activas (facturas, no NC) del mes a cerrar, por compañía, con monto en moneda del sistema. La usa la
	 * alerta `month_close_pending` (`MonthCloseService`); en Tareas ese mes es el "Mes anterior" de las atrasadas (Domi 05-10).
	 */
	async monthCloseByCompany(
		holdingId: string,
		month: string,
		companies: string[] = []
	): Promise<Array<{ company_id: string | null; company_name: string | null; count: number; amount: number; invoice_ids: string[] }>> {
		const params = new SqlParams();
		const { cte } = invoicesCte(holdingId, { ...companyFilter(companies), status: 'Por Emitir', from: month, to: month }, params, {
			today: `${month}-01`,
		});
		const rows = (await this.dataSource.query(
			`${cte} SELECT d.company_id::text AS company_id, MAX(d.company_name) AS company_name, COUNT(*) AS n,
				COALESCE(SUM(i.amount_system_currency), 0) AS amount,
				(array_agg(d.id::text ORDER BY COALESCE(d.issue_date, d.scheduled_at), d.id))[1:200] AS ids
			FROM d JOIN invoices i ON i.id = d.id
			WHERE d.status = 'Por Emitir' AND d.is_active AND d.document_kind = 'invoice'
			GROUP BY d.company_id`,
			params.values
		)) as Row[];

		return (rows ?? []).map((row) => ({
			company_id: row.company_id ? String(row.company_id) : null,
			company_name: row.company_name ? String(row.company_name) : null,
			count: num(row.n),
			amount: Math.round(num(row.amount) * 100) / 100,
			invoice_ids: ids(row.ids),
		}));
	}

	/** Excepciones de Ingresos (misma lista que la pestaña Excepciones). */
	private async exceptionsBucket(holdingId: string): Promise<Bucket> {
		const result = await this.revenue.exceptions(holdingId, { page: 1, limit: 1 });

		return { count: result.items };
	}
}
