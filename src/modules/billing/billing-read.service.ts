import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { holdingTimezone } from '@/core/utils/holding-preferences';
import { todayFor } from '@/modules/contracts/business-date';
import { relatedDocumentsOf } from '@/modules/contracts/contract-360';
import { erpDraftBlocker, planSendNow } from '@/modules/contracts/contract-invoices';
import {
	CONTRACT_CONTEXT_SELECT,
	CONTRACT_INVOICE_SELECT,
	contractInvoiceContextOf,
	contractInvoiceRowOf,
} from '@/modules/contracts/contract-invoices.service';
import { ContractsService } from '@/modules/contracts/contracts.service';
import { isUnifiedType, UNIFIED_READ_SQL, unifiedReadFields } from '@/modules/contracts/invoice-consolidation-read';

import {
	buildCalendar,
	CALENDAR_MAX_ROWS,
	calendarAmountOf,
	type CalendarInvoiceRow,
	calendarPeriods,
	type CalendarScope,
	calendarStateOf,
} from './billing-calendar';
import { buildForecast, buildGoal, type PaymentBehaviour } from './billing-forecast';
import {
	type DataCheck,
	DSO_TREND_MAX_MONTHS,
	DSO_WINDOW_DAYS,
	dsoOf,
	dsoSql,
	dsoTrendCuts,
	monthOfCut,
	previousMonthEnd,
	systemAmountChecksSql,
	systemAmountDataChecks,
} from './billing-receivables';
import {
	balanceSql,
	invoicesCte,
	monthEndOf,
	nextMonthStart,
	orderBySql,
	paidWithoutFullPaymentsSql,
	paidWithoutFullPaymentsWarnings,
	RELATED_DOCUMENTS_SQL,
	splitList,
	SqlParams,
} from './billing-sql';
import {
	type AgingRow,
	type BillingBlocker,
	buildAging,
	CHARGE_STATES,
	countGroups,
	CREDIT_TYPES,
	DOCUMENT_KINDS,
	ELECTRONIC_STATES,
	emptyBuckets,
	ERP_STATES,
	INVOICE_STATUSES,
	type IssuePath,
	normalizeEmailStatus,
	PAYMENT_STATES,
	queueBlockers,
	RECEIVABLE_STATUSES,
	type ToIssueGroup,
	toIssueGroupOf,
} from './billing-states';

import type {
	BillingAgingQueryDto,
	BillingCalendarQueryDto,
	BillingCreditNotesQueryDto,
	BillingFiltersDto,
	BillingForecastQueryDto,
	BillingGoalQueryDto,
	BillingInvoicesQueryDto,
	BillingPaymentsListQueryDto,
	BillingSubscriptionInvoicesQueryDto,
	BillingToIssueQueryDto,
	InvoiceSortField,
} from './dtos/billing.dto';

type Row = Record<string, unknown>;
/** Filtros de la antigüedad (y de la proyección, la meta y el DSO). */
type ReceivableFilters = Pick<BillingAgingQueryDto, 'company_id' | 'client_id' | 'currency' | 'source' | 'q' | 'segment' | 'market'>;

const text = (value: unknown) => (value === null || value === undefined ? null : String(value));
const num = (value: unknown) => (value === null || value === undefined ? null : Number(value));
const int = (value: unknown) => Number(value ?? 0) || 0;
const money = (value: unknown) => Math.round((Number(value ?? 0) || 0) * 100) / 100;
const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : text(value));

/** Tope de Por Emitir que la cola evalúa en memoria (bloqueos por factura); por encima, `truncated: true`. */
export const QUEUE_MAX = 5000;
/** Tope de filas de una exportación (streaming por lotes de 1.000). */
export const EXPORT_BATCH = 1000;

export interface QueueEntry {
	id: string;
	contract_id: string | null;
	group: ToIssueGroup;
	issue_path: IssuePath;
	blocked_reasons: BillingBlocker[];
	warnings: Array<{ code: string; message: string }>;
	/** Moneda y total de la factura (para los montos por grupo de la cola); `amount` null = spot sin valorizar. */
	currency?: string | null;
	amount?: number | null;
}

const paginated = <T>(data: T[], total: number, page: number, limit: number) => ({
	data,
	total,
	items: total,
	currentPage: page,
	pages: Math.max(1, Math.ceil(total / limit)),
	limit,
});

/**
 * Lecturas de Facturación v2 (spec-facturacion-v2 §5.1): lista por holding, KPIs, cola Por emitir, notas de crédito, antigüedad AR, pagos y
 * correos de una factura y catálogos de filtros. Solo lee: toda operación sobre una factura vive en `contracts` (single path).
 */
@Injectable()
export class BillingReadService {
	constructor(private readonly dataSource: DataSource) {}

	/** "Hoy" del holding en su zona horaria (`holding_settings.timezone`, ronda 4 de Configuración; default America/Santiago). */
	async today(now = new Date(), holdingId?: string | null): Promise<string> {
		return todayFor(await holdingTimezone(this.dataSource, holdingId), now);
	}

	async systemCurrency(holdingId: string): Promise<string> {
		const [row] = (await this.dataSource.query(`SELECT system_currency FROM holding_settings WHERE holding_id = $1 LIMIT 1`, [
			holdingId,
		])) as Row[];

		return text(row?.system_currency)?.toUpperCase() ?? 'USD';
	}

	// ---------------------------------------------------------------- lista

	async invoices(holdingId: string, query: BillingInvoicesQueryDto, now = new Date()) {
		const today = await this.today(now, holdingId);
		const page = query.page ?? 1;
		const limit = query.limit ?? 50;
		const blockedIds = query.blocked !== undefined ? await this.blockedIds(holdingId, query, today) : null;
		const params = new SqlParams();
		const { cte, where } = invoicesCte(holdingId, query, params, { today, excludeCancelledByDefault: true, blockedIds });
		const countParams = [...params.values];
		const order = orderBySql(query.sortBy, query.sortOrder);
		const [rows, [count]] = await Promise.all([
			this.dataSource.query(
				`${cte} SELECT d.* FROM d ${where} ${order} LIMIT ${Number(limit)} OFFSET ${(page - 1) * Number(limit)}`,
				params.values
			) as Promise<Row[]>,
			this.dataSource.query(`${cte} SELECT COUNT(*) AS total FROM d ${where}`, countParams) as Promise<Row[]>,
		]);

		return paginated(await this.decorate(holdingId, rows, today), int(count?.total), page, limit);
	}

	/** Mapea filas de `d` y agrega lo que sale de lotes: bloqueos de las Por Emitir, documentos vinculados, unificadas. */
	async decorate(holdingId: string, rows: Row[], today: string) {
		const ids = rows.map((row) => String(row.id));
		const pendingIds = rows.filter((row) => row.status === 'Por Emitir' && row.document_kind === 'invoice').map((row) => String(row.id));
		const unifiedIds = rows.filter((row) => isUnifiedType(text(row.invoice_type))).map((row) => String(row.id));
		const [queue, related, unified] = await Promise.all([
			pendingIds.length
				? this.queue(holdingId, {}, today, { ids: pendingIds })
				: Promise.resolve({ entries: [] as QueueEntry[], truncated: false }),
			ids.length ? (this.dataSource.query(RELATED_DOCUMENTS_SQL, [ids, holdingId]) as Promise<Row[]>) : Promise.resolve([] as Row[]),
			unifiedIds.length
				? (this.dataSource.query(UNIFIED_READ_SQL, [unifiedIds, holdingId]) as Promise<Row[]>).then((result) => unifiedReadFields(result))
				: Promise.resolve(new Map<string, { legacy_unified: boolean; contributions: unknown[] }>()),
		]);
		const queueById = new Map(queue.entries.map((entry) => [entry.id, entry]));
		const relatedById = new Map(related.map((row) => [String(row.id), relatedDocumentsOf(row.related_documents)]));

		return rows.map((row) => {
			const id = String(row.id);
			const entry = queueById.get(id);
			const unifiedFields = unified.get(id);

			return {
				...mapInvoiceRow(row),
				blocked_reasons: entry?.blocked_reasons ?? [],
				to_issue_group: entry?.group ?? null,
				issue_path: entry?.issue_path ?? null,
				related_documents: relatedById.get(id) ?? [],
				legacy_unified: unifiedFields?.legacy_unified ?? false,
				contributions: unifiedFields?.contributions ?? [],
			};
		});
	}

	// ---------------------------------------------------------------- KPIs

	async summary(holdingId: string, query: BillingFiltersDto, now = new Date()) {
		const today = await this.today(now, holdingId);
		const from = query.from ?? query.to ?? today.slice(0, 7);
		const to = query.to ?? query.from ?? today.slice(0, 7);
		const params = new SqlParams();
		const { cte, where } = invoicesCte(holdingId, query, params, { today, applyPeriod: false });
		const start = params.add(`${from}-01`);
		const end = params.add(nextMonthStart(to));
		const inPeriod = (column: string) => `${column}::date >= ${start}::date AND ${column}::date < ${end}::date`;
		// Solo documentos activos (con `include_inactive` los orígenes consolidados no suman dos veces). Una NC que corrige una factura que ya no
		// está vigente (anulación: la original quedó Cancelada, o es un origen consolidado) no resta de nuevo: la factura ya salió de "Facturado"
		// (misma regla que `countedInvoices` del 360).
		const billed = `d.is_active AND d.document_kind = 'invoice' AND d.status IN (${RECEIVABLE_STATUSES.map((status) => `'${status}'`).join(', ')}) AND ${inPeriod(
			'COALESCE(d.issue_date, d.scheduled_at)'
		)}`;
		const credited = `d.is_active AND d.document_kind = 'credit_note' AND d.status IS DISTINCT FROM 'Cancelada'
			AND (d.related_invoice_id IS NULL OR (d.related_invoice_status IS DISTINCT FROM 'Cancelada' AND d.related_invoice_active IS NOT FALSE))
			AND ${inPeriod('COALESCE(d.issue_date, d.scheduled_at)')}`;
		const pending = `d.is_active AND d.status = 'Por Emitir' AND d.document_kind = 'invoice' AND ${inPeriod('COALESCE(d.issue_date, d.scheduled_at)')}`;
		const ratio = `d.total_system_currency / NULLIF(d.total_due, 0)`;
		const [rows, collected, systemCurrency, queue, dso, dataChecks] = await Promise.all([
			this.dataSource.query(
				`${cte} SELECT d.invoice_currency AS currency,
					COALESCE(SUM(d.total_due) FILTER (WHERE ${billed}), 0) AS billed,
					COALESCE(SUM(d.total_system_currency) FILTER (WHERE ${billed}), 0) AS billed_system,
					COALESCE(SUM(d.total_system_currency) FILTER (WHERE ${billed} AND d.is_subscription), 0) AS billed_system_subscription,
					COUNT(*) FILTER (WHERE ${billed} AND d.total_system_currency IS NULL) AS billed_unconverted,
					COALESCE(SUM(ABS(d.total_due)) FILTER (WHERE ${credited}), 0) AS credited,
					COALESCE(SUM(ABS(d.total_system_currency)) FILTER (WHERE ${credited}), 0) AS credited_system,
					COALESCE(SUM(ABS(d.total_system_currency)) FILTER (WHERE ${credited} AND d.is_subscription), 0) AS credited_system_subscription,
					COUNT(*) FILTER (WHERE ${credited} AND d.total_system_currency IS NULL) AS credited_unconverted,
					COALESCE(SUM(d.total_due) FILTER (WHERE ${pending}), 0) AS pending_issue,
					COALESCE(SUM(d.total_system_currency) FILTER (WHERE ${pending}), 0) AS pending_issue_system,
					COUNT(*) FILTER (WHERE ${pending}) AS pending_issue_count,
					COUNT(*) FILTER (WHERE ${pending} AND d.total_due IS NULL) AS pending_issue_unvalued,
					COALESCE(SUM(d.balance) FILTER (WHERE d.balance > 0), 0) AS receivable,
					COALESCE(SUM(d.balance * ${ratio}) FILTER (WHERE d.balance > 0), 0) AS receivable_system,
					COUNT(*) FILTER (WHERE d.balance > 0 AND d.total_system_currency IS NULL) AS receivable_unconverted,
					COALESCE(SUM(d.balance) FILTER (WHERE d.is_overdue), 0) AS overdue,
					COALESCE(SUM(d.balance * ${ratio}) FILTER (WHERE d.is_overdue), 0) AS overdue_system,
					COUNT(*) FILTER (WHERE d.is_overdue) AS overdue_count,
					COALESCE(SUM(d.days_overdue) FILTER (WHERE d.is_overdue), 0) AS overdue_days,
					COUNT(*) FILTER (WHERE d.document_kind <> 'invoice' AND d.electronic_state = 'pending_emission') AS nc_pending_emission,
					COUNT(*) FILTER (WHERE ${paidWithoutFullPaymentsSql('d')}) AS paid_without_full_payments
				FROM d ${where} GROUP BY 1 ORDER BY 1`,
				params.values
			) as Promise<Row[]>,
			this.collected(holdingId, query, today, from, to),
			this.systemCurrency(holdingId),
			this.queue(holdingId, { ...query, from, to, date_field: 'issue' }, today, {}),
			// DSO a hoy y al cierre del mes anterior (delta del KPI), con los filtros de la vista salvo estado y período.
			this.dsoAt(holdingId, query, [previousMonthEnd(today), today]),
			this.systemAmountChecks(holdingId, query, today),
		]);
		const collectedBy = new Map(collected.map((row) => [String(row.currency), row]));
		const currencies = [...new Set([...rows.map((row) => String(row.currency)), ...collectedBy.keys()])].sort();
		const byCurrency = currencies.map((currency) => {
			const row = rows.find((entry) => String(entry.currency) === currency) ?? {};
			const pay = collectedBy.get(currency) ?? {};

			return {
				currency,
				billed: money(row.billed),
				credited: money(row.credited),
				net: money(Number(row.billed ?? 0) - Number(row.credited ?? 0)),
				pending_issue: money(row.pending_issue),
				pending_issue_unvalued: int(row.pending_issue_unvalued),
				receivable: money(row.receivable),
				overdue: money(row.overdue),
				collected: money(pay.collected),
				non_cash_adjustments: money(pay.non_cash_adjustments),
				unconverted_invoices:
					int(row.billed_unconverted) + int(row.credited_unconverted) + int(row.receivable_unconverted) + int(pay.collected_unconverted),
			};
		});
		const sum = (key: string, source: Row[] = rows) => money(source.reduce((total, row) => total + (Number(row[key] ?? 0) || 0), 0));
		const overdueCount = rows.reduce((total, row) => total + int(row.overdue_count), 0);
		const unconverted = byCurrency.reduce((total, row) => total + row.unconverted_invoices, 0);

		return {
			currency: systemCurrency,
			period: { from, to },
			by_currency: byCurrency,
			system: {
				currency: systemCurrency,
				billed: sum('billed_system'),
				credited: sum('credited_system'),
				net: money(sum('billed_system') - sum('credited_system')),
				pending_issue: sum('pending_issue_system'),
				receivable: sum('receivable_system'),
				overdue: sum('overdue_system'),
				collected: sum('collected_system', collected),
				non_cash_adjustments: sum('non_cash_adjustments_system', collected),
			},
			/** Parte de suscripciones (Stripe) en moneda de sistema: Facturado y Cobrado las incluyen; el resto es de contratos u otras. */
			subscriptions: {
				net: money(sum('billed_system_subscription') - sum('credited_system_subscription')),
				collected: sum('collected_system_subscription', collected),
			},
			counts: {
				pending_issue: rows.reduce((total, row) => total + int(row.pending_issue_count), 0),
				blocked: queue.entries.filter((entry) => entry.group === 'blocked').length,
				overdue: overdueCount,
				overdue_avg_days: overdueCount ? Math.round(rows.reduce((total, row) => total + int(row.overdue_days), 0) / overdueCount) : 0,
				nc_pending_emission: rows.reduce((total, row) => total + int(row.nc_pending_emission), 0),
			},
			/** DSO (días de venta pendientes de cobro, ventana 90 días) a hoy y al cierre del mes anterior. */
			dso: { ...dso[1], previous: dso[0] },
			data_checks: dataChecks,
			warnings: paidWithoutFullPaymentsWarnings(rows.reduce((total, row) => total + int(row.paid_without_full_payments), 0)),
			unconverted: {
				invoices: unconverted,
				reason: unconverted
					? 'Facturas o pagos sin tipo de cambio a la moneda del sistema: suman en su moneda, no en el total del sistema'
					: null,
			},
		};
	}

	/**
	 * Cobrado del período por moneda (pagos confirmados en la moneda de la factura, por `payment_date`): `collected` excluye los ajustes no
	 * monetarios (`settlement_reason IS NOT NULL`), que salen aparte en `non_cash_adjustments` (misma regla de período y conversión).
	 */
	private async collected(holdingId: string, query: BillingFiltersDto, today: string, from: string, to: string): Promise<Row[]> {
		const params = new SqlParams();
		const { cte, conditions } = invoicesCte(holdingId, query, params, { today, applyPeriod: false });
		const start = params.add(`${from}-01`);
		const end = params.add(nextMonthStart(to));
		// Cobrado = solo pagos monetarios; los ajustes no monetarios (`settlement_reason`, conciliación v2) van aparte.
		const cash = '(p.settlement_reason IS NULL)';

		return (await this.dataSource.query(
			`${cte} SELECT d.invoice_currency AS currency, SUM(p.amount) FILTER (WHERE ${cash}) AS collected,
				SUM(p.amount * d.total_system_currency / NULLIF(d.total_due, 0)) FILTER (WHERE ${cash}) AS collected_system,
				SUM(p.amount * d.total_system_currency / NULLIF(d.total_due, 0)) FILTER (WHERE ${cash} AND d.is_subscription) AS collected_system_subscription,
				COUNT(*) FILTER (WHERE ${cash} AND d.total_system_currency IS NULL) AS collected_unconverted,
				SUM(p.amount) FILTER (WHERE NOT ${cash}) AS non_cash_adjustments,
				SUM(p.amount * d.total_system_currency / NULLIF(d.total_due, 0)) FILTER (WHERE NOT ${cash}) AS non_cash_adjustments_system
			FROM invoice_payments p JOIN d ON d.id = p.invoice_id
			WHERE p.holding_id = $1 AND p.confirmed = true AND UPPER(p.currency) = d.invoice_currency
				AND p.payment_date >= ${start}::date AND p.payment_date < ${end}::date${conditions.map((condition) => ` AND ${condition}`).join('')}
			GROUP BY 1`,
			params.values
		)) as Row[];
	}

	// ---------------------------------------------------------------- cola Por emitir

	/**
	 * Por Emitir activas (no NC) con sus bloqueos: los del envío del 360 (`planSendNow` = `commonBlockers` + envío), borrador en el ERP y período
	 * cerrado; sin ERP (contrato que no envía o compañía sin integración) se quitan los del envío (`issue_path = external`, `mark-issued`).
	 */
	async queue(
		holdingId: string,
		filters: BillingFiltersDto,
		today: string,
		options: { until?: string | null; ids?: string[]; sortBy?: InvoiceSortField; sortOrder?: 'asc' | 'desc' }
	): Promise<{ entries: QueueEntry[]; truncated: boolean }> {
		const params = new SqlParams();
		const { cte, conditions } = invoicesCte(holdingId, { ...filters, blocked: undefined }, params, { today, ids: options.ids ?? null });
		const until = options.until ? ` AND COALESCE(d.issue_date, d.scheduled_at)::date <= ${params.add(options.until)}::date` : '';
		const rows = (await this.dataSource.query(
			`${cte} SELECT d.id, d.contract_id, d.invoice_currency, d.total_due FROM d
			WHERE d.status = 'Por Emitir' AND d.is_active AND d.document_kind = 'invoice'${until}${conditions.map((condition) => ` AND ${condition}`).join('')}
			${options.sortBy ? orderBySql(options.sortBy, options.sortOrder) : 'ORDER BY COALESCE(d.issue_date, d.scheduled_at) NULLS LAST, d.id'} LIMIT ${QUEUE_MAX + 1}`,
			params.values
		)) as Row[];
		const truncated = rows.length > QUEUE_MAX;
		const kept = rows.slice(0, QUEUE_MAX);
		const ids = kept.map((row) => String(row.id));
		const amounts = new Map(kept.map((row) => [String(row.id), { currency: text(row.invoice_currency), amount: num(row.total_due) }]));
		const entries = (await this.queueEntries(holdingId, ids, today)).map((entry) => ({
			...entry,
			...(amounts.get(entry.id) ?? { currency: null, amount: null }),
		}));

		return { entries, truncated };
	}

	async queueEntries(holdingId: string, ids: string[], today: string): Promise<QueueEntry[]> {
		if (!ids.length) return [];
		const invoiceRows = (await this.dataSource.query(`${CONTRACT_INVOICE_SELECT} WHERE i.holding_id = $1 AND i.id = ANY($2::uuid[])`, [
			holdingId,
			ids,
		])) as Row[];
		const contractIds = [...new Set(invoiceRows.map((row) => text(row.contract_id)).filter((id): id is string => !!id))];
		const contextRows = contractIds.length
			? ((await this.dataSource.query(
					`${CONTRACT_CONTEXT_SELECT} WHERE c.holding_id = $1 AND c.id = ANY($2::uuid[]) AND c.deleted_at IS NULL`,
					[holdingId, contractIds]
				)) as Row[])
			: [];
		const contexts = new Map(contextRows.map((row) => [String(row.id), contractInvoiceContextOf(row, today)]));
		const byId = new Map(invoiceRows.map((row) => [String(row.id), row]));

		return ids
			.filter((id) => byId.has(id))
			.map((id) => {
				const row = byId.get(id)!;
				const invoice = contractInvoiceRowOf(row);
				const contractId = text(row.contract_id);
				const context = contractId ? contexts.get(contractId) : undefined;

				// Sin contexto solo si la factura no tiene contrato o este fue borrado / es de otro holding. El estado del contrato (vigente,
				// por renovar, vencido…) no filtra: sus bloqueos son los de `planSendNow`, los mismos del 360.
				if (!context) {
					const blocked = [
						{
							code: 'no_contract',
							message: contractId
								? 'El contrato de la factura no existe en el holding o fue eliminado'
								: 'La factura no pertenece a un contrato',
							next_step: null,
						},
					];

					return {
						id,
						contract_id: contractId,
						group: toIssueGroupOf(invoice, blocked, today),
						issue_path: 'external' as IssuePath,
						blocked_reasons: queueBlockers(blocked, 'external'),
						warnings: [],
					};
				}
				const plan = planSendNow(invoice, context);
				const issuePath: IssuePath = context.auto_send_to_erp && context.has_erp_integration ? 'erp' : 'external';
				// Sin `period_closed`: el cierre de períodos protege contratos e ítems, no facturas (Domi 03-10).
				const blockers = queueBlockers(
					[...plan.blockers, erpDraftBlocker(invoice)].filter((blocker): blocker is NonNullable<typeof blocker> => !!blocker),
					issuePath
				);

				return {
					id,
					contract_id: contractId,
					group: toIssueGroupOf(invoice, blockers, today),
					issue_path: issuePath,
					blocked_reasons: blockers,
					warnings: plan.warnings,
				};
			});
	}

	private async blockedIds(holdingId: string, filters: BillingFiltersDto, today: string): Promise<string[]> {
		const { entries } = await this.queue(holdingId, { ...filters, document_kind: undefined, payment_state: undefined }, today, {});

		return entries.filter((entry) => entry.blocked_reasons.length > 0).map((entry) => entry.id);
	}

	async toIssue(holdingId: string, query: BillingToIssueQueryDto, now = new Date()) {
		const today = await this.today(now, holdingId);
		const until = query.until ?? monthEndOf(today);
		const page = query.page ?? 1;
		const limit = query.limit ?? 50;
		// Con `sortBy` la página sale en ese orden (lista blanca de la lista); sin él, el de la cola (emisión ascendente).
		const { entries, truncated } = await this.queue(holdingId, query, today, { until, sortBy: query.sortBy, sortOrder: query.sortOrder });
		const groups = countGroups(entries);
		const selected = entries.filter(
			(entry) =>
				(!query.group || entry.group === query.group) &&
				(!query.blocker_code || entry.blocked_reasons.some((blocker) => blocker.code === query.blocker_code))
		);
		const pageEntries = selected.slice((page - 1) * limit, page * limit);
		const rows = pageEntries.length
			? await this.rowsByIds(
					holdingId,
					pageEntries.map((entry) => entry.id),
					today
				)
			: [];
		const byId = new Map(rows.map((row) => [String(row.id), row]));
		const data = pageEntries
			.filter((entry) => byId.has(entry.id))
			.map((entry) => ({
				...mapInvoiceRow(byId.get(entry.id)!),
				group: entry.group,
				issue_path: entry.issue_path,
				blocked_reasons: entry.blocked_reasons,
				warnings: entry.warnings,
			}));

		return { ...paginated(data, selected.length, page, limit), until, groups, truncated };
	}

	/** Filas de `d` de unas facturas (incluye Canceladas e inactivas). */
	async rowsByIds(holdingId: string, ids: string[], today: string): Promise<Row[]> {
		const params = new SqlParams();
		const { cte } = invoicesCte(holdingId, { include_inactive: true, include_cancelled: true }, params, { today, ids });

		return (await this.dataSource.query(`${cte} SELECT d.* FROM d`, params.values)) as Row[];
	}

	// ---------------------------------------------------------------- notas de crédito

	async creditNotes(holdingId: string, query: BillingCreditNotesQueryDto, now = new Date()) {
		const today = await this.today(now, holdingId);
		const page = query.page ?? 1;
		const limit = query.limit ?? 50;
		const params = new SqlParams();
		const creditTypes = splitList(query.credit_type).filter((value) => (CREDIT_TYPES as readonly string[]).includes(value));
		const { cte, where } = invoicesCte(holdingId, query, params, { today, creditNotes: { creditTypes } });
		const countParams = [...params.values];
		const [rows, [count]] = await Promise.all([
			this.dataSource.query(
				`${cte} SELECT d.* FROM d ${where} ${orderBySql(query.sortBy, query.sortOrder)} LIMIT ${Number(limit)} OFFSET ${(page - 1) * Number(limit)}`,
				params.values
			) as Promise<Row[]>,
			this.dataSource.query(
				`${cte} SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE d.electronic_state = 'pending_emission') AS pending_emission FROM d ${where}`,
				countParams
			) as Promise<Row[]>,
		]);

		return {
			...paginated(
				rows.map((row) => ({
					...mapInvoiceRow(row),
					credited_invoice: row.related_invoice_id
						? {
								id: String(row.related_invoice_id),
								invoice_number: text(row.related_invoice_number),
								status: text(row.related_invoice_status),
								issue_date: text(row.related_invoice_issue_date),
							}
						: null,
				})),
				int(count?.total),
				page,
				limit
			),
			counts: { pending_emission: int(count?.pending_emission) },
		};
	}

	// ---------------------------------------------------------------- pagos y ajustes (Cobranza)

	/**
	 * Pagos confirmados del holding (Cobranza › Pagos y ajustes): uno por fila con su factura, cliente, compañía y, si vino de una cartola, el
	 * monto y la moneda originales. `from`/`to` (YYYY-MM) acotan por **fecha de pago**; los demás filtros van sobre la factura (incluye anuladas e
	 * inactivas: el pago existió). `kind` separa pagos monetarios (Cobrado) de ajustes no monetarios (`settlement_reason`). `totals` por moneda.
	 */
	async paymentsList(holdingId: string, query: BillingPaymentsListQueryDto, now = new Date()) {
		const today = await this.today(now, holdingId);
		const page = query.page ?? 1;
		const limit = query.limit ?? 50;
		const params = new SqlParams();
		const { cte } = invoicesCte(
			holdingId,
			{ ...query, from: undefined, to: undefined, blocked: undefined, include_inactive: true, include_cancelled: true },
			params,
			{ today, applyPeriod: false }
		);
		const conditions = ['p.confirmed = true', `p.holding_id = ${params.add(holdingId)}`];

		if (query.from) conditions.push(`p.payment_date >= ${params.add(`${query.from}-01`)}::date`);
		if (query.to) conditions.push(`p.payment_date < ${params.add(nextMonthStart(query.to))}::date`);
		if (query.kind === 'cash') conditions.push('p.settlement_reason IS NULL');
		if (query.kind === 'adjustment') conditions.push('p.settlement_reason IS NOT NULL');
		const from = `FROM invoice_payments p JOIN d ON d.id = p.invoice_id
			LEFT JOIN users u ON u.id = p.created_by
			LEFT JOIN bank_movements bm ON bm.id = p.bank_movement_id AND bm.holding_id = p.holding_id
			WHERE ${conditions.join(' AND ')}`;
		const [rows, totals] = await Promise.all([
			this.dataSource.query(
				`${cte} SELECT p.id, p.invoice_id, d.invoice_number, d.client_id, d.client_name, d.client_entity_name, d.company_id, d.company_name,
					d.contract_id, d.contract_number, p.amount, UPPER(p.currency) AS currency, p.payment_date::text AS payment_date, p.method, p.reference,
					p.notes, p.settlement_reason, p.bank_movement_id, p.original_amount, p.fx_rate,
					CASE WHEN p.original_amount IS NOT NULL THEN UPPER(bm.currency) END AS original_currency,
					COALESCE(u.name, u.email) AS created_by_name, p.created_at
				${from}
				ORDER BY p.payment_date DESC, p.created_at DESC, p.id LIMIT ${Number(limit)} OFFSET ${(page - 1) * Number(limit)}`,
				params.values
			) as Promise<Row[]>,
			this.dataSource.query(
				`${cte} SELECT UPPER(p.currency) AS currency, COUNT(*) AS payments,
					COALESCE(SUM(p.amount) FILTER (WHERE p.settlement_reason IS NULL), 0) AS cash,
					COUNT(*) FILTER (WHERE p.settlement_reason IS NULL) AS cash_count,
					COALESCE(SUM(p.amount) FILTER (WHERE p.settlement_reason IS NOT NULL), 0) AS adjustments,
					COUNT(*) FILTER (WHERE p.settlement_reason IS NOT NULL) AS adjustments_count
				${from} GROUP BY 1 ORDER BY 1`,
				params.values
			) as Promise<Row[]>,
		]);
		const total = totals.reduce((sum, row) => sum + int(row.payments), 0);

		return {
			...paginated(
				rows.map((row) => ({
					id: String(row.id),
					invoice_id: String(row.invoice_id),
					invoice_number: text(row.invoice_number),
					client_id: text(row.client_id),
					client_name: text(row.client_name),
					client_entity_name: text(row.client_entity_name),
					company_id: text(row.company_id),
					company_name: text(row.company_name),
					contract_id: text(row.contract_id),
					contract_number: text(row.contract_number),
					kind: row.settlement_reason ? 'adjustment' : 'cash',
					amount: money(row.amount),
					currency: text(row.currency),
					payment_date: text(row.payment_date),
					method: text(row.method),
					reference: text(row.reference),
					notes: text(row.notes),
					settlement_reason: text(row.settlement_reason),
					bank_movement_id: text(row.bank_movement_id),
					original_amount: num(row.original_amount),
					original_currency: text(row.original_currency),
					fx_rate: num(row.fx_rate),
					created_by_name: text(row.created_by_name),
					created_at: row.created_at instanceof Date ? row.created_at.toISOString() : text(row.created_at),
				})),
				total,
				page,
				limit
			),
			totals: totals.map((row) => ({
				currency: text(row.currency),
				cash: money(row.cash),
				cash_count: int(row.cash_count),
				adjustments: money(row.adjustments),
				adjustments_count: int(row.adjustments_count),
			})),
		};
	}

	// ---------------------------------------------------------------- facturas de suscripción (Stripe)

	/**
	 * Facturas de suscripciones (`subscription_id`, Stripe), solo lectura: plan o productos (líneas), período, estado del cobro y el enlace al
	 * documento de Stripe (`stripe_invoices_stg.raw_data`: `hosted_invoice_url` o `invoice_pdf`). Estado del cobro: `refunded` (nota de crédito
	 * posterior al pago en Stripe o una NC activa en Sapira) · `void` · `paid` · `failed` (incobrable o con intentos de cobro fallidos) · `open`.
	 * `counts` por estado sobre todo el filtro.
	 */
	async subscriptionInvoices(holdingId: string, query: BillingSubscriptionInvoicesQueryDto, now = new Date()) {
		const today = await this.today(now, holdingId);
		const page = query.page ?? 1;
		const limit = query.limit ?? 50;
		const params = new SqlParams();
		const { cte, where } = invoicesCte(holdingId, { ...query, source: 'subscription', blocked: undefined }, params, {
			today,
			excludeCancelledByDefault: false,
		});
		const holding = params.add(holdingId);
		const states = splitList(query.charge_state).filter((value) => (CHARGE_STATES as readonly string[]).includes(value));
		const statesParam = states.length ? params.add(states) : null;
		const stateFilter = statesParam ? `s.charge_state = ANY(${statesParam}::text[])` : 'TRUE';
		const attempts = `COALESCE(NULLIF(st.raw_data->>'attempt_count', '')::int, 0)`;
		const sub = `, s AS (
			SELECT d.*, sb.external_id AS subscription_external_id, sb.status AS subscription_status,
				COALESCE(st.raw_data->>'hosted_invoice_url', st.raw_data->>'invoice_pdf') AS document_url,
				st.raw_data->>'status' AS stripe_status, ${attempts} AS charge_attempts, it.plan, it.period_start, it.period_end,
				COALESCE(NULLIF(TRIM(sb.source), ''), 'stripe') AS source_provider, sc.id AS source_connection_id,
				COALESCE(NULLIF(TRIM(sc.name), ''), NULLIF(TRIM(st.raw_data->>'account_name'), '')) AS source_account,
				COALESCE(NULLIF(st.raw_data->>'livemode', '')::boolean, CASE WHEN sc.mode IS NULL THEN NULL ELSE sc.mode = 'live' END) AS source_livemode,
				CASE
					WHEN COALESCE(NULLIF(st.raw_data->>'post_payment_credit_notes_amount', '')::numeric, 0) > 0
						OR EXISTS (SELECT 1 FROM invoices nc WHERE nc.related_invoice_id = d.id AND nc.holding_id = ${holding} AND nc.is_active
							AND nc.status IS DISTINCT FROM 'Cancelada') THEN 'refunded'
					WHEN st.raw_data->>'status' = 'void' OR d.status = 'Cancelada' THEN 'void'
					WHEN d.status = 'Por Emitir' OR st.raw_data->>'status' = 'draft' THEN 'open'
					WHEN st.raw_data->>'status' = 'paid' OR d.payment_state = 'paid' THEN 'paid'
					WHEN st.raw_data->>'status' = 'uncollectible' OR ${attempts} > 0 THEN 'failed'
					ELSE 'open' END AS charge_state
			FROM d
			LEFT JOIN subscriptions sb ON sb.id = d.subscription_id AND sb.holding_id = ${holding}
			LEFT JOIN stripe_invoices_stg st ON st.holding_id = ${holding} AND st.stripe_id = d.stripe_id
			LEFT JOIN stripe_connections sc ON sc.holding_id = ${holding} AND sc.id = COALESCE(sb.connection_id, st.connection_id)
			LEFT JOIN LATERAL (
				SELECT string_agg(DISTINCT COALESCE(p.name, ii.description), ' · ') AS plan,
					MIN(ii.billing_period_start)::text AS period_start, MAX(ii.billing_period_end)::text AS period_end
				FROM invoice_items ii LEFT JOIN products p ON p.id = ii.product_id
				WHERE ii.invoice_id = d.id AND ii.holding_id = ${holding}
			) it ON true
			${where}
		)`;
		const order = orderBySql(query.sortBy, query.sortOrder).replace(/\bd\./g, 's.');
		const [rows, [count]] = await Promise.all([
			this.dataSource.query(
				`${cte}${sub} SELECT s.* FROM s WHERE ${stateFilter} ${order} LIMIT ${Number(limit)} OFFSET ${(page - 1) * Number(limit)}`,
				params.values
			) as Promise<Row[]>,
			this.dataSource.query(
				`${cte}${sub} SELECT COUNT(*) FILTER (WHERE ${stateFilter}) AS total,
					${CHARGE_STATES.map((state) => `COUNT(*) FILTER (WHERE s.charge_state = '${state}') AS ${state}`).join(', ')}
				FROM s`,
				params.values
			) as Promise<Row[]>,
		]);

		return {
			...paginated(
				rows.map((row) => ({
					...mapInvoiceRow(row),
					subscription_id: text(row.subscription_id),
					subscription_external_id: text(row.subscription_external_id),
					subscription_status: text(row.subscription_status),
					stripe_id: text(row.stripe_id),
					stripe_status: text(row.stripe_status),
					document_url: text(row.document_url),
					plan: text(row.plan),
					period_start: text(row.period_start),
					period_end: text(row.period_end),
					charge_state: text(row.charge_state),
					charge_attempts: int(row.charge_attempts),
					/** Fuente: proveedor (`subscriptions.source`) + cuenta conectada (`stripe_connections.name`, o `account_name` del JSON de Stripe). */
					source_provider: text(row.source_provider),
					source_account: text(row.source_account),
					source_connection_id: text(row.source_connection_id),
					source_livemode: row.source_livemode === null || row.source_livemode === undefined ? null : row.source_livemode === true,
				})),
				int(count?.total),
				page,
				limit
			),
			counts: Object.fromEntries(CHARGE_STATES.map((state) => [state, int(count?.[state])])),
		};
	}

	// ---------------------------------------------------------------- antigüedad AR

	/**
	 * Filas de la antigüedad al corte `asOf`: una por factura emitida (no NC, no anulada, valorizada) con saldo = total − pagos confirmados hasta
	 * el corte, su saldo en moneda de sistema y el último pago. La usan la antigüedad, la proyección y la meta.
	 */
	private async agingRows(
		holdingId: string,
		query: ReceivableFilters,
		asOf: string
	): Promise<{ rows: AgingRow[]; paidWithoutFullPayments: number }> {
		const params = new SqlParams();
		const { cte } = invoicesCte(holdingId, receivableFiltersOf(query), params, { today: asOf, paymentsAsOf: asOf });
		const cut = params.add(asOf);
		const holding = params.add(holdingId);
		const balance = balanceSql('d');
		const rows = (await this.dataSource.query(
			`${cte} SELECT d.client_id, d.client_name, d.invoice_currency AS currency, d.due_date,
				${balance} AS balance, ${paidWithoutFullPaymentsSql('d')} AS paid_without_full_payments,
				d.id, d.invoice_number, d.company_id, d.company_name, d.company_country, d.contract_id, d.contract_number, d.status,
				COALESCE(d.issue_date, d.scheduled_at) AS issue_date,
				(${balance}) * d.total_system_currency / NULLIF(d.total_due, 0) AS balance_system,
				lp.last_payment_date
			FROM d
			LEFT JOIN LATERAL (
				SELECT MAX(p.payment_date)::text AS last_payment_date FROM invoice_payments p
				WHERE p.invoice_id = d.id AND p.holding_id = ${holding} AND p.confirmed = true AND p.payment_date <= ${cut}::date
			) lp ON true
			WHERE d.is_active AND NOT d.voided AND d.document_kind = 'invoice' AND d.total_due IS NOT NULL
				AND d.status IN (${RECEIVABLE_STATUSES.map((status) => `'${status}'`).join(', ')})
				AND COALESCE(d.issue_date, d.scheduled_at)::date <= ${cut}::date`,
			params.values
		)) as Row[];

		return {
			rows: rows.map((row) => ({
				client_id: text(row.client_id),
				client_name: text(row.client_name),
				currency: text(row.currency),
				due_date: text(row.due_date),
				balance: Number(row.balance ?? 0) || 0,
				id: text(row.id),
				invoice_number: text(row.invoice_number),
				company_id: text(row.company_id),
				company_name: text(row.company_name),
				company_country: text(row.company_country),
				contract_id: text(row.contract_id),
				contract_number: text(row.contract_number),
				status: text(row.status),
				issue_date: text(row.issue_date)?.slice(0, 10) ?? null,
				balance_system: num(row.balance_system),
				last_payment_date: text(row.last_payment_date),
			})),
			paidWithoutFullPayments: rows.filter((row) => row.paid_without_full_payments === true).length,
		};
	}

	/**
	 * Antigüedad AR al corte, por moneda de factura y cliente (nunca suma monedas) + el total en sistema. Las facturas CLF/UF no son moneda de
	 * facturación: van en `review` (conteo por compañía), nunca como tramo. `group=company` agrega `by_company`.
	 */
	async aging(holdingId: string, query: BillingAgingQueryDto, now = new Date()) {
		const today = await this.today(now, holdingId);
		const asOf = query.as_of ?? today;
		const [{ rows, paidWithoutFullPayments }, systemCurrency, [dso], dataChecks] = await Promise.all([
			this.agingRows(holdingId, query, asOf),
			this.systemCurrency(holdingId),
			this.dsoAt(holdingId, receivableFiltersOf(query), [asOf]),
			this.systemAmountChecks(holdingId, receivableFiltersOf(query), asOf),
		]);
		const aging = buildAging(rows, asOf);
		const single = query.currency ? aging.by_currency.find((entry) => entry.currency === query.currency!.toUpperCase()) : undefined;

		return {
			as_of: asOf,
			currency: query.currency?.toUpperCase() ?? null,
			system_currency: systemCurrency,
			buckets: query.currency ? (single?.buckets ?? emptyBuckets()) : null,
			bucket_counts: query.currency ? (single?.bucket_counts ?? emptyBuckets()) : null,
			by_currency: aging.by_currency,
			clients: aging.clients,
			system: { currency: systemCurrency, ...aging.system },
			...(query.group === 'company' ? { by_company: aging.by_company } : {}),
			review: aging.review,
			...(query.detail === 'invoices' ? { invoices: aging.invoices } : {}),
			dso,
			data_checks: dataChecks,
			warnings: paidWithoutFullPaymentsWarnings(paidWithoutFullPayments),
		};
	}

	/**
	 * DSO en cada corte (`billing-receivables.ts`: Por cobrar ÷ Facturado de los últimos 90 días × 90, en moneda de sistema; histórico
	 * reconstruido con fechas de emisión y pago). Mismos filtros que la antigüedad.
	 */
	async dsoAt(holdingId: string, filters: BillingFiltersDto, cuts: string[]): Promise<DsoPoint[]> {
		const params = new SqlParams();
		const { cte } = invoicesCte(holdingId, dsoFiltersOf(filters), params, { today: cuts[cuts.length - 1], applyPeriod: false });
		const holding = params.add(holdingId);
		const cutList = params.add(cuts);
		const rows = (await this.dataSource.query(dsoSql(cte, holding, cutList), params.values)) as Row[];
		const byCut = new Map(rows.map((row) => [String(row.cut).slice(0, 10), row]));

		return cuts.map((cut) => {
			const row = byCut.get(cut) ?? {};
			const ar = money(row.ar_system);
			const billed = money(row.billed_system);

			return {
				as_of: cut,
				days: dsoOf(ar, billed),
				receivable_system: ar,
				billed_system: billed,
				window_days: DSO_WINDOW_DAYS,
				unconverted: int(row.unconverted),
			};
		});
	}

	/**
	 * Tendencia de DSO (`GET /billing/receivables/dso-trend`): un punto por mes (fin de mes; el mes en curso, al corte) de los últimos `months`
	 * meses (default 12, máximo 24), en moneda de sistema, con los filtros de la antigüedad.
	 */
	async dsoTrend(holdingId: string, query: ReceivableFilters & { as_of?: string; months?: number }, now = new Date()) {
		const asOf = query.as_of ?? (await this.today(now, holdingId));
		const months = Math.min(Math.max(query.months ?? 12, 1), DSO_TREND_MAX_MONTHS);
		const [points, systemCurrency] = await Promise.all([
			this.dsoAt(holdingId, receivableFiltersOf(query), dsoTrendCuts(asOf, months)),
			this.systemCurrency(holdingId),
		]);

		return {
			as_of: asOf,
			currency: systemCurrency,
			window_days: DSO_WINDOW_DAYS,
			method: 'cut_by_dates',
			points: points.map((point) => ({ month: monthOfCut(point.as_of), ...point })),
		};
	}

	/** Chequeo `system_amount_inconsistent` (`billing-receivables.ts`) sobre las facturas con saldo al corte, con los filtros de la vista. */
	async systemAmountChecks(holdingId: string, filters: BillingFiltersDto, asOf: string): Promise<DataCheck[]> {
		const params = new SqlParams();
		const { cte } = invoicesCte(holdingId, dsoFiltersOf(filters), params, { today: asOf, paymentsAsOf: asOf, applyPeriod: false });
		const holding = params.add(holdingId);
		const cut = params.add(asOf);
		const rows = (await this.dataSource.query(systemAmountChecksSql(cte, holding, cut), params.values)) as Row[];

		return systemAmountDataChecks(rows);
	}

	/**
	 * Comportamiento de pago por cliente (últimos 12 meses al corte): días promedio entre emisión y el último pago, y entre vencimiento y el
	 * último pago, de sus facturas pagadas con pagos registrados. Se expone para Insights; no ajusta la proyección.
	 */
	async paymentBehaviour(
		holdingId: string,
		asOf: string,
		query: Pick<BillingAgingQueryDto, 'company_id' | 'client_id' | 'source' | 'segment' | 'market'>
	): Promise<PaymentBehaviour[]> {
		const params = new SqlParams();
		const { cte } = invoicesCte(
			holdingId,
			{ company_id: query.company_id, client_id: query.client_id, source: query.source, segment: query.segment, market: query.market },
			params,
			{ today: asOf, applyPeriod: false }
		);
		const cut = params.add(asOf);
		const holding = params.add(holdingId);
		const rows = (await this.dataSource.query(
			`${cte} SELECT d.client_id, ROUND(AVG(lp.last_date - d.issue_date::date)) AS avg_days_to_pay,
				ROUND(AVG(lp.last_date - d.due_date::date) FILTER (WHERE d.due_date IS NOT NULL)) AS avg_days_late, COUNT(*) AS paid_invoices
			FROM d
			JOIN LATERAL (
				SELECT MAX(p.payment_date) AS last_date FROM invoice_payments p
				WHERE p.invoice_id = d.id AND p.holding_id = ${holding} AND p.confirmed = true AND p.payment_date <= ${cut}::date
			) lp ON lp.last_date IS NOT NULL
			WHERE d.status = 'Pagada' AND d.document_kind = 'invoice' AND d.issue_date IS NOT NULL
				AND lp.last_date > ${cut}::date - 365
			GROUP BY d.client_id`,
			params.values
		)) as Row[];

		return rows.map((row) => ({
			client_id: text(row.client_id),
			avg_days_to_pay: num(row.avg_days_to_pay),
			avg_days_late: num(row.avg_days_late),
			paid_invoices: int(row.paid_invoices),
		}));
	}

	/**
	 * Proyección de cobros por vencimiento (`GET /billing/receivables/forecast`): saldo abierto al corte en la columna de su vencimiento (mes,
	 * semana o día), "Vencido por cobrar" aparte, sin vencimiento aparte y "Posteriores" fuera del rango; por cliente (moneda de sistema) con su
	 * comportamiento de pago (`avg_days_to_pay`, `avg_days_late`). Las facturas CLF/UF no entran (`review_invoices`).
	 */
	async forecast(holdingId: string, query: BillingForecastQueryDto, now = new Date()) {
		const today = await this.today(now, holdingId);
		const asOf = query.as_of ?? today;
		const granularity = query.granularity ?? 'month';
		let periods: ReturnType<typeof calendarPeriods>;

		try {
			periods = calendarPeriods(query.from ?? asOf, query.to, granularity);
		} catch (error) {
			throw new BadRequestException(error instanceof Error ? error.message : 'Rango de la proyección inválido');
		}
		const [{ rows }, systemCurrency, behaviour] = await Promise.all([
			this.agingRows(holdingId, query, asOf),
			this.systemCurrency(holdingId),
			this.paymentBehaviour(holdingId, asOf, query),
		]);
		const known = behaviour.filter((entry) => entry.avg_days_to_pay !== null);
		const weighted = (key: 'avg_days_to_pay' | 'avg_days_late') => {
			const items = known.filter((entry) => entry[key] !== null);
			const count = items.reduce((sum, entry) => sum + entry.paid_invoices, 0);

			return count ? Math.round(items.reduce((sum, entry) => sum + (entry[key] as number) * entry.paid_invoices, 0) / count) : null;
		};

		return {
			as_of: asOf,
			granularity,
			start: periods[0].start,
			end: periods[periods.length - 1].end,
			currency: systemCurrency,
			...buildForecast(rows, { asOf, periods, granularity, behaviour }),
			payment_behaviour: { avg_days_to_pay: weighted('avg_days_to_pay'), avg_days_late: weighted('avg_days_late'), clients: known.length },
		};
	}

	/** Cobrado por mes `YYYY-MM` de un año (pagos monetarios confirmados en la moneda de la factura, convertidos a sistema). */
	async collectedByMonth(holdingId: string, year: number, query: Pick<BillingGoalQueryDto, 'company_id' | 'source'>, today: string) {
		const { byKey, unconverted } = await this.collectedBetween(holdingId, `${year}-01-01`, `${year + 1}-01-01`, query, today, 'month');

		return { byMonth: byKey, unconverted };
	}

	/**
	 * Cobrado (pagos monetarios confirmados en la moneda de la factura, convertidos a sistema con la razón de la factura) por mes `YYYY-MM` o
	 * por día `YYYY-MM-DD`, con `payment_date` en [`from`, `until`) y los filtros de la antigüedad.
	 */
	async collectedBetween(holdingId: string, from: string, until: string, query: ReceivableFilters, today: string, groupBy: 'month' | 'day') {
		const params = new SqlParams();
		const { cte, conditions } = invoicesCte(holdingId, receivableFiltersOf(query), params, { today, applyPeriod: false });
		const start = params.add(from);
		const end = params.add(until);
		const rows = (await this.dataSource.query(
			`${cte} SELECT to_char(p.payment_date, '${groupBy === 'month' ? 'YYYY-MM' : 'YYYY-MM-DD'}') AS month,
				SUM(p.amount * d.total_system_currency / NULLIF(d.total_due, 0)) AS collected,
				COUNT(*) FILTER (WHERE d.total_system_currency IS NULL) AS unconverted
			FROM invoice_payments p JOIN d ON d.id = p.invoice_id
			WHERE p.holding_id = $1 AND p.confirmed = true AND p.settlement_reason IS NULL AND UPPER(p.currency) = d.invoice_currency
				AND p.payment_date >= ${start}::date AND p.payment_date < ${end}::date${conditions.map((condition) => ` AND ${condition}`).join('')}
			GROUP BY 1`,
			params.values
		)) as Row[];

		return {
			byKey: Object.fromEntries(rows.map((row) => [String(row.month), money(row.collected)])) as Record<string, number>,
			unconverted: rows.reduce((sum, row) => sum + int(row.unconverted), 0),
		};
	}

	/** Meta vs cobrado vs proyectado de un año (la meta la lee `BillingCollectionsService`). */
	async goalProgress(holdingId: string, query: BillingGoalQueryDto, budgetByMonth: Record<string, number> | null, now = new Date()) {
		const today = await this.today(now, holdingId);
		const year = query.year ?? Number(today.slice(0, 4));
		const [{ rows }, collected, systemCurrency] = await Promise.all([
			this.agingRows(holdingId, { company_id: query.company_id, source: query.source }, today),
			this.collectedByMonth(holdingId, year, query, today),
			this.systemCurrency(holdingId),
		]);

		return {
			as_of: today,
			...buildGoal({ year, currency: systemCurrency, budgetByMonth, asOf: today, rows, collectedByMonth: collected.byMonth }),
			unconverted_payments: collected.unconverted,
		};
	}

	// ---------------------------------------------------------------- calendario

	/**
	 * Calendario de facturación: filas = clientes (o contratos) × columnas = meses, semanas o días. `scope=invoices` agrupa por fecha de emisión
	 * (o vencimiento con `date_field=due`) todas las facturas de los filtros (sin Canceladas por defecto); `scope=to_issue` es la cola Por emitir
	 * (estado = grupo de la cola, las atrasadas anteriores al rango en la columna `before`). Agrega en la API, sin el tope de 200 de la lista.
	 */
	async calendar(holdingId: string, query: BillingCalendarQueryDto, now = new Date()) {
		const today = await this.today(now, holdingId);
		const granularity = query.granularity ?? 'month';
		const scope: CalendarScope = query.scope ?? 'invoices';
		const groupBy = query.group_by ?? 'client';
		let periods: ReturnType<typeof calendarPeriods>;

		try {
			periods = calendarPeriods(query.start ?? today, query.end, granularity);
		} catch (error) {
			throw new BadRequestException(error instanceof Error ? error.message : 'Rango del calendario inválido');
		}
		const rangeStart = periods[0].start;
		const rangeEnd = periods[periods.length - 1].end;
		const toIssue = scope === 'to_issue';
		const filters: BillingFiltersDto = {
			...query,
			from: undefined,
			to: undefined,
			blocked: undefined,
			...(toIssue
				? { status: undefined, document_kind: undefined, payment_state: undefined, electronic_state: undefined, include_cancelled: undefined }
				: {}),
		};
		const params = new SqlParams();
		const { cte, conditions } = invoicesCte(holdingId, filters, params, { today, applyPeriod: false, excludeCancelledByDefault: !toIssue });
		const dateColumn = !toIssue && query.date_field === 'due' ? 'd.due_date' : 'COALESCE(d.issue_date, d.scheduled_at)';
		const lower = toIssue ? '' : ` AND ${dateColumn}::date >= ${params.add(rangeStart)}::date`;
		const upper = ` AND ${dateColumn}::date <= ${params.add(rangeEnd)}::date`;
		// Solo facturas vivas por defecto (misma regla que la pestaña Facturas): sin NC/ND salvo que el filtro de tipo las pida; las Canceladas
		// ya salen de la CTE salvo `status`/`include_cancelled`.
		const scopeSql = toIssue
			? ` AND d.status = 'Por Emitir' AND d.is_active AND d.document_kind = 'invoice'`
			: query.document_kind
				? ''
				: ` AND d.document_kind = 'invoice'`;
		const max = toIssue ? QUEUE_MAX : CALENDAR_MAX_ROWS;
		const [rows, systemCurrency] = await Promise.all([
			this.dataSource.query(
				`${cte} SELECT d.id, d.invoice_number, d.client_id, d.client_name, d.contract_id, d.contract_number, d.status, d.document_kind,
					d.payment_state, d.is_overdue, LEFT(${dateColumn}, 10) AS cal_date, d.invoice_currency AS currency, d.total_due, d.total_system_currency,
					UPPER(d.contract_currency) AS contract_currency, d.amount_contract_currency, d.vat, d.fx_contract_to_invoice
				FROM d WHERE ${dateColumn} IS NOT NULL${scopeSql}${lower}${upper}${conditions.map((condition) => ` AND ${condition}`).join('')}
				ORDER BY cal_date, d.id LIMIT ${max + 1}`,
				params.values
			) as Promise<Row[]>,
			this.systemCurrency(holdingId),
		]);
		const truncated = rows.length > max;
		const kept = rows.slice(0, max);
		const groups = toIssue
			? new Map(
					(
						await this.queueEntries(
							holdingId,
							kept.map((row) => String(row.id)),
							today
						)
					).map((entry) => [entry.id, entry.group])
				)
			: null;
		const invoices: CalendarInvoiceRow[] = kept.map((row) => ({
			id: String(row.id),
			invoice_number: text(row.invoice_number),
			client_id: text(row.client_id),
			client_name: text(row.client_name),
			contract_id: text(row.contract_id),
			contract_number: text(row.contract_number),
			date: String(row.cal_date),
			...calendarAmountOf({
				status: text(row.status),
				invoice_currency: text(row.currency),
				total_due: num(row.total_due),
				contract_currency: text(row.contract_currency),
				amount_contract: num(row.amount_contract_currency),
				total_contract: contractCurrencyTotals({ ...row, invoice_currency: row.currency }).total_contract_currency,
			}),
			invoice_currency: text(row.currency),
			amount_system: num(row.total_system_currency),
			state: groups
				? (groups.get(String(row.id)) ?? 'blocked')
				: calendarStateOf({
						status: text(row.status),
						document_kind: text(row.document_kind),
						payment_state: text(row.payment_state),
						is_overdue: row.is_overdue === true,
					}),
		}));

		return {
			granularity,
			scope,
			group_by: groupBy,
			start: rangeStart,
			end: rangeEnd,
			today,
			currency: systemCurrency,
			date_field: toIssue ? 'issue' : (query.date_field ?? 'issue'),
			...buildCalendar(invoices, periods, { granularity, groupBy }),
			truncated,
		};
	}

	// ---------------------------------------------------------------- una factura: pagos y correos

	async invoiceSnapshot(holdingId: string, invoiceId: string, now = new Date()) {
		const today = await this.today(now, holdingId);
		const [row] = await this.rowsByIds(holdingId, [invoiceId], today);

		if (!row) throw new NotFoundException('Factura no encontrada');

		return mapInvoiceRow(row);
	}

	/**
	 * Una factura (deep link `/facturacion?invoice=<id>`): misma fila que la lista (decorada con `blocked_reasons`, grupo de la cola,
	 * `related_documents` y unificadas) + `payments_summary` (pagos confirmados en la moneda de la factura, anulados aparte). 404 si no es
	 * del holding. Incluye Canceladas e inactivas.
	 */
	async invoice(holdingId: string, invoiceId: string, now = new Date()) {
		const today = await this.today(now, holdingId);
		const rows = await this.rowsByIds(holdingId, [invoiceId], today);

		if (!rows.length) throw new NotFoundException('Factura no encontrada');
		const [[row], [payments]] = await Promise.all([
			this.decorate(holdingId, rows, today),
			this.dataSource.query(
				`SELECT COUNT(*) FILTER (WHERE p.confirmed = true AND UPPER(p.currency) = UPPER($3)) AS confirmed_count,
					COUNT(*) FILTER (WHERE p.confirmed = false) AS voided_count,
					COUNT(*) FILTER (WHERE p.confirmed = true AND UPPER(p.currency) IS DISTINCT FROM UPPER($3)) AS other_currency_count,
					MAX(p.payment_date) FILTER (WHERE p.confirmed = true)::text AS last_payment_date
				FROM invoice_payments p WHERE p.invoice_id = $1 AND p.holding_id = $2`,
				[invoiceId, holdingId, text(rows[0].invoice_currency) ?? '']
			) as Promise<Row[]>,
		]);

		return { ...row, payments_summary: paymentsSummaryOf(row, payments) };
	}

	async invoicePayments(holdingId: string, invoiceId: string, now = new Date()) {
		const invoice = await this.invoiceSnapshot(holdingId, invoiceId, now);
		const rows = (await this.dataSource.query(
			`SELECT p.id, p.amount, p.currency, p.payment_date::text AS payment_date, p.method, p.reference, p.notes, p.confirmed, p.created_by,
				COALESCE(u.name, u.email) AS created_by_name, p.created_at, p.bank_movement_id,
				p.settlement_reason, p.original_amount, p.fx_rate,
				CASE WHEN p.original_amount IS NOT NULL THEN UPPER(bm.currency) END AS original_currency,
				v.created_at AS voided_at, v.metadata->>'reason' AS void_reason
			FROM invoice_payments p
			LEFT JOIN users u ON u.id = p.created_by
			LEFT JOIN bank_movements bm ON bm.id = p.bank_movement_id AND bm.holding_id = p.holding_id
			LEFT JOIN LATERAL (
				SELECT e.created_at, e.metadata FROM contract_lifecycle_events e
				WHERE e.holding_id = p.holding_id AND e.event_type = 'INVOICE_PAYMENT_VOIDED' AND e.metadata->>'payment_id' = p.id::text
				ORDER BY e.created_at DESC FETCH FIRST 1 ROW ONLY
			) v ON true
			WHERE p.invoice_id = $1 AND p.holding_id = $2
			ORDER BY p.payment_date DESC, p.created_at DESC, p.id`,
			[invoiceId, holdingId]
		)) as Row[];

		return {
			invoice: {
				id: invoice.id,
				invoice_number: invoice.invoice_number,
				status: invoice.status,
				currency: invoice.invoice_currency,
				total: invoice.total_invoice_currency,
				paid: invoice.paid_amount,
				balance: invoice.balance,
				payment_state: invoice.payment_state,
				due_date: invoice.due_date,
			},
			payments: rows.map((row) => ({
				id: String(row.id),
				amount: money(row.amount),
				currency: text(row.currency)?.toUpperCase() ?? null,
				payment_date: text(row.payment_date),
				method: text(row.method),
				reference: text(row.reference),
				notes: text(row.notes),
				confirmed: row.confirmed === true,
				counts: row.confirmed === true && text(row.currency)?.toUpperCase() === invoice.invoice_currency,
				created_by: row.created_by ? { id: String(row.created_by), name: text(row.created_by_name) } : null,
				created_at: iso(row.created_at),
				bank_movement_id: text(row.bank_movement_id),
				settlement_reason: text(row.settlement_reason),
				original_amount: num(row.original_amount),
				original_currency: text(row.original_currency),
				fx_rate: num(row.fx_rate),
				voided_at: iso(row.voided_at),
				void_reason: text(row.void_reason),
			})),
		};
	}

	async invoiceEmails(holdingId: string, invoiceId: string) {
		const [exists] = (await this.dataSource.query(`SELECT 1 FROM invoices WHERE id = $1 AND holding_id = $2`, [invoiceId, holdingId])) as Row[];

		if (!exists) throw new NotFoundException('Factura no encontrada');
		const rows = (await this.dataSource.query(
			`SELECT x.* FROM (
				SELECT e.id, e.template AS kind, ARRAY[e.recipient]::text[] AS recipients, e.subject, e.sent_by, COALESCE(u.name, u.email) AS sent_by_name,
					e.sent_at, 'sent' AS status, 'invoice_emails' AS source
				FROM invoice_emails e LEFT JOIN users u ON u.id = e.sent_by
				WHERE e.invoice_id = $1 AND e.holding_id = $2
				UNION ALL
				SELECT l.id, CASE WHEN l.metadata->>'kind' = 'reminder' THEN 'reminder' ELSE 'collection' END AS kind, l.recipients, l.subject, l.sent_by,
					COALESCE(u.name, u.email) AS sent_by_name, l.sent_at, l.status, 'invoice_collection_logs' AS source
				FROM invoice_collection_logs l LEFT JOIN users u ON u.id = l.sent_by
				WHERE l.invoice_id = $1 AND l.holding_id = $2
			) x ORDER BY x.sent_at DESC, x.id`,
			[invoiceId, holdingId]
		)) as Row[];

		return rows.map((row) => ({
			id: String(row.id),
			kind: text(row.kind),
			recipients: Array.isArray(row.recipients) ? row.recipients.map(String) : [],
			subject: text(row.subject),
			sent_by: row.sent_by ? { id: String(row.sent_by), name: text(row.sent_by_name) } : null,
			sent_at: iso(row.sent_at),
			status: normalizeEmailStatus(text(row.status)),
		}));
	}

	// ---------------------------------------------------------------- catálogos

	async filters(holdingId: string) {
		const [companies, clients, entities, currencies, contracts, clientValues] = (await Promise.all([
			this.dataSource.query(
				`SELECT DISTINCT co.id, co.legal_name AS name, NULLIF(TRIM(co.country), '') AS country FROM invoices i
				JOIN companies co ON co.id = i.company_id AND co.holding_id = i.holding_id
				WHERE i.holding_id = $1 ORDER BY 2 NULLS LAST`,
				[holdingId]
			),
			this.dataSource.query(
				`SELECT DISTINCT cl.id, cl.name_commercial AS name FROM invoices i LEFT JOIN contracts c ON c.id = i.contract_id AND c.holding_id = i.holding_id
				JOIN clients cl ON cl.id = COALESCE(i.client_id, c.client_id) AND cl.holding_id = i.holding_id
				WHERE i.holding_id = $1 ORDER BY 2 NULLS LAST`,
				[holdingId]
			),
			this.dataSource.query(
				`SELECT DISTINCT ce.id, ce.legal_name AS name FROM invoices i JOIN client_entities ce ON ce.id = i.client_entity_id AND ce.holding_id = i.holding_id
				WHERE i.holding_id = $1 ORDER BY 2 NULLS LAST`,
				[holdingId]
			),
			this.dataSource.query(
				`SELECT DISTINCT UPPER(COALESCE(i.invoice_currency, i.contract_currency)) AS code FROM invoices i
				WHERE i.holding_id = $1 AND COALESCE(i.invoice_currency, i.contract_currency) IS NOT NULL ORDER BY 1`,
				[holdingId]
			),
			this.dataSource.query(
				`SELECT DISTINCT c.id, c.contract_number, c.client_id FROM invoices i JOIN contracts c ON c.id = i.contract_id AND c.holding_id = i.holding_id
				WHERE i.holding_id = $1 AND c.deleted_at IS NULL ORDER BY 2 NULLS LAST`,
				[holdingId]
			),
			// Segmentos y mercados de los clientes con facturas (texto libre de `clients`, filtros del reporte AR).
			this.dataSource.query(
				`SELECT DISTINCT 'segment' AS kind, TRIM(cl.segment) AS value FROM invoices i LEFT JOIN contracts c ON c.id = i.contract_id AND c.holding_id = i.holding_id
				JOIN clients cl ON cl.id = COALESCE(i.client_id, c.client_id) AND cl.holding_id = i.holding_id
				WHERE i.holding_id = $1 AND NULLIF(TRIM(cl.segment), '') IS NOT NULL
				UNION
				SELECT DISTINCT 'market' AS kind, TRIM(cl.market) AS value FROM invoices i LEFT JOIN contracts c ON c.id = i.contract_id AND c.holding_id = i.holding_id
				JOIN clients cl ON cl.id = COALESCE(i.client_id, c.client_id) AND cl.holding_id = i.holding_id
				WHERE i.holding_id = $1 AND NULLIF(TRIM(cl.market), '') IS NOT NULL
				ORDER BY 1, 2`,
				[holdingId]
			),
		])) as Row[][];
		const valuesOf = (kind: string) =>
			clientValues
				.filter((row) => row.kind === kind)
				.map((row) => String(row.value))
				.sort((a, b) => a.localeCompare(b, 'es'));

		return {
			companies: companies.map((row) => ({ id: String(row.id), name: text(row.name), country: text(row.country) })),
			clients: clients.map((row) => ({ id: String(row.id), name: text(row.name) })),
			client_entities: entities.map((row) => ({ id: String(row.id), name: text(row.name) })),
			currencies: currencies.map((row) => String(row.code)),
			segments: valuesOf('segment'),
			markets: valuesOf('market'),
			contracts: contracts.map((row) => ({ id: String(row.id), contract_number: text(row.contract_number), client_id: text(row.client_id) })),
			statuses: [...INVOICE_STATUSES],
			document_kinds: [...DOCUMENT_KINDS],
			erp_states: [...ERP_STATES],
			electronic_states: [...ELECTRONIC_STATES],
			payment_states: [...PAYMENT_STATES],
			credit_types: [...CREDIT_TYPES],
		};
	}

	// ---------------------------------------------------------------- exportación (lotes)

	/** Recorre la vista filtrada por lotes de `EXPORT_BATCH` (sin corte) para el XLSX; `onBatch` recibe filas mapeadas. */
	async exportBatches(
		holdingId: string,
		query: BillingFiltersDto & { sortBy?: InvoiceSortField; sortOrder?: 'asc' | 'desc' },
		onBatch: (rows: ReturnType<typeof mapInvoiceRow>[]) => Promise<void>,
		now = new Date()
	): Promise<number> {
		const today = await this.today(now, holdingId);
		const blockedIds = query.blocked !== undefined ? await this.blockedIds(holdingId, query, today) : null;
		let offset = 0;
		let total = 0;

		for (;;) {
			const params = new SqlParams();
			const { cte, where } = invoicesCte(holdingId, query, params, { today, excludeCancelledByDefault: true, blockedIds });
			const rows = (await this.dataSource.query(
				`${cte} SELECT d.* FROM d ${where} ${orderBySql(query.sortBy, query.sortOrder)} LIMIT ${EXPORT_BATCH} OFFSET ${offset}`,
				params.values
			)) as Row[];

			if (!rows.length) break;
			await onBatch(rows.map((row) => mapInvoiceRow(row)));
			total += rows.length;
			offset += rows.length;
			if (rows.length < EXPORT_BATCH) break;
		}

		return total;
	}

	async exportLines(holdingId: string, invoiceIds: string[]): Promise<Row[]> {
		if (!invoiceIds.length) return [];

		return (await this.dataSource.query(
			`SELECT ii.invoice_id, ii.description, p.name AS product_name, ii.quantity, ii.unit_of_measure, ii.discount_pct,
				ii.billing_period_start::text AS billing_period_start, ii.billing_period_end::text AS billing_period_end,
				COALESCE(ii.contract_currency, i.contract_currency) AS line_currency, ii.unit_price_contract_currency, ii.subtotal_contract_currency,
				ii.invoice_currency, ii.fx_contract_to_invoice, ii.unit_price_invoice_currency, ii.subtotal_invoice_currency, ii.tax_amount_invoice_currency,
				ii.total_invoice_currency, (ii.visible_line_id IS NULL AND ii.quantity <> 0) AS visible
			FROM invoice_items ii
			JOIN invoices i ON i.id = ii.invoice_id AND i.holding_id = ii.holding_id
			LEFT JOIN products p ON p.id = ii.product_id
			WHERE ii.holding_id = $1 AND ii.invoice_id = ANY($2::uuid[])
			ORDER BY ii.invoice_id, ii.billing_period_start NULLS LAST, ii.created_at, ii.id`,
			[holdingId, invoiceIds]
		)) as Row[];
	}
}

/** Resumen de cobro de una factura para la vista rápida (`GET /billing/invoices/:id`). */
export function paymentsSummaryOf(invoice: ReturnType<typeof mapInvoiceRow>, row: Row | undefined) {
	return {
		currency: invoice.invoice_currency,
		total: invoice.total_invoice_currency,
		paid: invoice.paid_amount,
		balance: invoice.balance,
		payment_state: invoice.payment_state,
		payments_count: int(row?.confirmed_count),
		voided_count: int(row?.voided_count),
		other_currency_count: int(row?.other_currency_count),
		last_payment_date: text(row?.last_payment_date),
	};
}

/** Punto de DSO en un corte (moneda de sistema). */
export interface DsoPoint {
	as_of: string;
	days: number | null;
	receivable_system: number;
	billed_system: number;
	window_days: number;
	unconverted: number;
}

/** Filtros de la antigüedad → filtros de la CTE (`currency` es la moneda de la factura). */
export function receivableFiltersOf(query: ReceivableFilters): BillingFiltersDto {
	return {
		company_id: query.company_id,
		client_id: query.client_id,
		invoice_currency: query.currency,
		source: query.source,
		q: query.q,
		segment: query.segment,
		market: query.market,
	};
}

/**
 * Filtros que aplican a los saldos (DSO, chequeos de datos): los de la vista menos los de estado y período, que no cambian qué se debe (el DSO
 * y los chequeos miran todo el AR, como el Por cobrar del resumen).
 */
export function dsoFiltersOf(filters: BillingFiltersDto): BillingFiltersDto {
	const { company_id, client_id, client_entity_id, contract_id, invoice_currency, source, q, segment, market } = filters;

	return { company_id, client_id, client_entity_id, contract_id, invoice_currency, source, q, segment, market };
}

/**
 * IVA y total en la moneda del contrato (la factura guarda el neto en contrato, `amount_contract_currency`, y el IVA en la moneda de la
 * factura): misma moneda ⇒ el IVA de la factura; otra ⇒ IVA ÷ `fx_contract_to_invoice`. Sin tipo de cambio (spot sin valorizar) ⇒ `null`.
 */
export function contractCurrencyTotals(row: Row): { vat_contract_currency: number | null; total_contract_currency: number | null } {
	const net = num(row.amount_contract_currency);
	const vat = num(row.vat);
	const fx = num(row.fx_contract_to_invoice);
	const contract = text(row.contract_currency)?.toUpperCase() ?? null;
	const invoice = text(row.invoice_currency)?.toUpperCase() ?? null;
	const vatContract = vat === null ? null : !contract || contract === invoice ? vat : fx && fx > 0 ? money(vat / fx) : null;

	return { vat_contract_currency: vatContract, total_contract_currency: net === null || vatContract === null ? null : money(net + vatContract) };
}

/** Fila de la lista (spec §5.1) desde `d`. */
export function mapInvoiceRow(row: Row) {
	return {
		id: String(row.id),
		contract_id: text(row.contract_id),
		contract_number: text(row.contract_number),
		client_id: text(row.client_id),
		client_name: text(row.client_name),
		client_entity_id: text(row.client_entity_id),
		client_entity_name: text(row.client_entity_name),
		company_id: text(row.company_id),
		company_name: text(row.company_name),
		invoice_number: text(row.invoice_number),
		document_type: text(row.document_type),
		document_kind: text(row.document_kind),
		export_type: num(row.export_type),
		/** Documento tributario del contrato (catálogo `tax_document_types`): nombre real ("Factura exenta", "Factura de exportación"…). */
		tax_document_name: text(row.tax_document_name),
		tax_document_kind: text(row.tax_document_kind),
		credit_type: text(row.credit_type),
		credit_reason: text(row.credit_reason),
		nc_revenue_treatment: text(row.nc_revenue_treatment),
		invoice_type: text(row.invoice_type),
		invoice_series: text(row.invoice_series),
		status: text(row.status),
		issue_date: text(row.issue_date),
		scheduled_at: text(row.scheduled_at),
		due_date: text(row.due_date),
		contract_currency: text(row.contract_currency),
		invoice_currency: text(row.invoice_currency),
		fx_contract_to_invoice: num(row.fx_contract_to_invoice),
		amount_contract_currency: num(row.amount_contract_currency),
		amount_invoice_currency: num(row.amount_invoice_currency),
		vat: num(row.vat),
		...contractCurrencyTotals(row),
		total_invoice_currency: num(row.total_due),
		total_system_currency: num(row.total_system_currency),
		paid_amount: money(row.paid_amount),
		balance: num(row.balance),
		payment_state: text(row.payment_state),
		is_overdue: row.is_overdue === true,
		days_overdue: int(row.days_overdue),
		erp_state: text(row.erp_state),
		electronic_state: text(row.electronic_state),
		plan_deviation: ContractsService.deviationOf(row),
		voided: row.voided === true,
		issued_externally: row.issued_externally === true,
		related_invoice_id: text(row.related_invoice_id),
		related_invoice_number: text(row.related_invoice_number),
		consolidated_into_invoice_id: text(row.consolidated_into_invoice_id),
		is_active: row.is_active !== false,
		is_legacy: row.is_legacy === true,
		auto_invoice: row.auto_invoice === true,
		odoo_invoice_id: num(row.odoo_invoice_id),
		has_contract: !!row.contract_id,
	};
}
