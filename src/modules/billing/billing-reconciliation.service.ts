import { BadRequestException, ConflictException, HttpException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, type QueryRunner } from 'typeorm';

import { holdingTimezone } from '@/core/utils/holding-preferences';
import { rowsOf } from '@/core/utils/query-rows';
import { withApiWriter } from '@/modules/contracts/api-writer';
import { todayFor } from '@/modules/contracts/business-date';
import { resolveUserId } from '@/modules/contracts/contract-drafts.service';

import { BillingPaymentsService } from './billing-payments.service';
import {
	DEFAULT_FEE_THRESHOLD_PCT,
	type EngineContext,
	type EngineInvoice,
	type EngineMovement,
	extractRut,
	learnAliases,
	MATCH_EPSILON,
	type MatchConfidence,
	type MatchPlan,
	type MatchSuggestion,
	MOVEMENT_STATUS,
	type MovementState,
	persistedMatch,
	planMatch,
	relatedMovements,
	remainingOf,
	round2,
	SETTLEMENT_REASON_LABELS,
	suggestMatches,
	tierOf,
} from './billing-reconciliation-match';
import {
	parseStatement,
	type StatementAccount,
	type StatementLine,
	type StatementMapping,
	validateMapping,
} from './billing-reconciliation-statement';
import { invoicesCte, monthEndOf, splitList, SqlParams } from './billing-sql';

import type { BillingBlocker, PaymentPlan, SettlementReason } from './billing-states';
import type {
	IgnoreMovementDto,
	MatchesDto,
	MatchItemDto,
	ReconciliationCandidatesQueryDto,
	ReconciliationMovementsQueryDto,
	ReconciliationSuggestionsQueryDto,
	ReconciliationSummaryQueryDto,
	ReconciliationTemplateDto,
	RefreshSuggestionsDto,
	ReopenMovementDto,
	RevertStatementDto,
	StatementImportDto,
	StatementPreviewDto,
	StatementsListQueryDto,
	UndoMatchDto,
} from './dtos/billing-reconciliation.dto';

type Row = Record<string, unknown>;
type Queryable = Pick<DataSource, 'query'> | QueryRunner;

const text = (value: unknown) => (value === null || value === undefined ? null : String(value));
const num = (value: unknown) => (value === null || value === undefined ? null : Number(value));
const int = (value: unknown) => Number(value ?? 0) || 0;
const money = (value: unknown) => Math.round((Number(value ?? 0) || 0) * 100) / 100;
const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : text(value));
const json = (value: unknown): Row => {
	if (value && typeof value === 'object') return value as Row;
	if (typeof value === 'string') {
		try {
			return JSON.parse(value) as Row;
		} catch {
			return {};
		}
	}

	return {};
};
const userOf = (id: unknown, name: unknown) => (id ? { id: String(id), name: text(name) } : null);

const paginated = <T>(data: T[], total: number, page: number, limit: number) => ({
	data,
	total,
	items: total,
	currentPage: page,
	pages: Math.max(1, Math.ceil(total / limit)),
	limit,
});

/** Tope de facturas candidatas que el motor evalúa por holding y de movimientos que refresca de una vez. */
export const ENGINE_MAX_INVOICES = 3000;
export const REFRESH_MAX_MOVEMENTS = 2000;
const INSERT_CHUNK = 500;

/** Monto aplicado de un movimiento (en su moneda): pagos monetarios confirmados; los ajustes no consumen el movimiento. */
const APPLIED_LATERAL = `LEFT JOIN LATERAL (
		SELECT SUM(COALESCE(p.original_amount, p.amount)) FILTER (WHERE p.settlement_reason IS NULL) AS applied,
			SUM(p.amount) FILTER (WHERE p.settlement_reason IS NOT NULL) AS adjustments,
			COUNT(*) AS payments
		FROM invoice_payments p WHERE p.bank_movement_id = m.id AND p.holding_id = m.holding_id AND p.confirmed = true
	) ap ON true`;

/** Gemelo SQL de `movementStateOf`. */
const STATE_SQL = `CASE WHEN m.status = '${MOVEMENT_STATUS.ignored}' THEN 'ignored'
		WHEN COALESCE(m.amount, 0) <= 0 THEN 'debit'
		WHEN m.status = '${MOVEMENT_STATUS.reconciled}' THEN 'reconciled'
		WHEN COALESCE(ap.applied, 0) > ${MATCH_EPSILON} THEN 'partial'
		ELSE 'pending' END`;

/** `WITH mv AS (…)`: movimientos del holding con cuenta (vía lote), aplicado, ajustes y estado derivado. */
const movementsCte = (holding: string) => `WITH mv AS (
	SELECT m.id, m.company_id, m.movement_date::text AS date, m.description, m.amount, UPPER(m.currency) AS currency, m.status,
		COALESCE(ba.bank_name, m.bank_name) AS bank_name, COALESCE(ba.account_number, m.bank_account) AS account_number, m.bank_account,
		m.batch_id, b.bank_account_id, m.reconciled_invoice_id, m.reconciled_at, m.reconciled_by, COALESCE(ru.name, ru.email) AS reconciled_by_name,
		m.match_confidence, m.match_score, m.suggested_invoice_id, m.ignore_reason, m.original_row_data, m.created_at,
		COALESCE(ap.applied, 0) AS applied, COALESCE(ap.adjustments, 0) AS adjustments, COALESCE(ap.payments, 0) AS payments_count,
		${STATE_SQL} AS state
	FROM bank_movements m
	LEFT JOIN bank_upload_batches b ON b.id = m.batch_id AND b.holding_id = m.holding_id
	LEFT JOIN company_bank_accounts ba ON ba.id = b.bank_account_id AND ba.holding_id = m.holding_id
	LEFT JOIN users ru ON ru.auth_id = m.reconciled_by
	${APPLIED_LATERAL}
	WHERE m.holding_id = ${holding}
)`;

/** Datos mínimos de las facturas de un ítem (moneda, folio, cliente, contrato) para validar antes del plan de pagos. */
const INVOICE_INFO_SQL = `SELECT i.id, i.invoice_number, UPPER(COALESCE(i.invoice_currency, i.contract_currency)) AS currency,
		COALESCE(i.client_id, c.client_id) AS client_id, cl.name_commercial AS client_name, i.contract_id
	FROM invoices i
	LEFT JOIN contracts c ON c.id = i.contract_id AND c.holding_id = i.holding_id
	LEFT JOIN clients cl ON cl.id = COALESCE(i.client_id, c.client_id) AND cl.holding_id = i.holding_id
	WHERE i.holding_id = $1 AND i.id = ANY($2::uuid[])`;

/** Pagos (y ajustes) de una página de movimientos. */
const MOVEMENT_PAYMENTS_SQL = `SELECT p.id, p.bank_movement_id, p.invoice_id, i.invoice_number, cl.name_commercial AS client_name, p.amount,
		UPPER(p.currency) AS currency, p.original_amount, p.fx_rate, p.settlement_reason, p.confirmed, p.payment_date::text AS payment_date
	FROM invoice_payments p
	JOIN invoices i ON i.id = p.invoice_id AND i.holding_id = p.holding_id
	LEFT JOIN contracts c ON c.id = i.contract_id AND c.holding_id = i.holding_id
	LEFT JOIN clients cl ON cl.id = COALESCE(i.client_id, c.client_id) AND cl.holding_id = i.holding_id
	WHERE p.holding_id = $1 AND p.bank_movement_id = ANY($2::uuid[])
	ORDER BY p.created_at, p.id`;

const ACCOUNT_SQL = `SELECT ba.id, ba.company_id, co.legal_name AS company_name, ba.bank_name, ba.account_number, UPPER(ba.currency) AS currency
	FROM company_bank_accounts ba LEFT JOIN companies co ON co.id = ba.company_id
	WHERE ba.id = $1 AND ba.holding_id = $2`;

type PaymentRow = ReturnType<typeof paymentOf>;

const paymentOf = (row: Row) => ({
	id: String(row.id),
	invoice_id: String(row.invoice_id),
	invoice_number: text(row.invoice_number),
	client_name: text(row.client_name),
	amount: money(row.amount),
	currency: text(row.currency),
	original_amount: num(row.original_amount),
	fx_rate: num(row.fx_rate),
	settlement_reason: text(row.settlement_reason),
	confirmed: row.confirmed === true,
	payment_date: text(row.payment_date),
});

/** Movimiento de la base → movimiento del motor (RUT de la glosa para cargas viejas sin `counterparty_tax_id`). */
export function engineMovementOf(row: Row): EngineMovement {
	const original = json(row.original_row_data);
	const amount = money(row.amount);

	return {
		id: String(row.id),
		date: text(row.date) ?? '',
		description: text(row.description),
		reference: text(original.reference),
		amount,
		currency: (text(row.currency) ?? '').toUpperCase(),
		remaining: remainingOf({ amount, applied: money(row.applied) }),
		counterparty_tax_id: text(original.counterparty_tax_id) ?? extractRut(text(row.description)),
	};
}

/** Fila de la cola (spec §4 `GET /billing/reconciliation/movements`). */
export function movementRowOf(row: Row, best: MatchSuggestion | null, payments: PaymentRow[]) {
	const original = json(row.original_row_data);
	const amount = money(row.amount);
	const applied = money(row.applied);

	return {
		id: String(row.id),
		date: text(row.date),
		description: text(row.description),
		reference: text(original.reference),
		counterparty_name: text(original.counterparty_name),
		counterparty_tax_id: text(original.counterparty_tax_id) ?? extractRut(text(row.description)),
		amount,
		currency: text(row.currency),
		bank_account_id: text(row.bank_account_id),
		bank_name: text(row.bank_name),
		account_number: text(row.account_number),
		batch_id: text(row.batch_id),
		state: text(row.state) as MovementState,
		applied,
		remaining: amount > 0 ? remainingOf({ amount, applied }) : 0,
		adjustments: money(row.adjustments),
		ignore_reason: text(row.ignore_reason),
		reconciled_at: iso(row.reconciled_at),
		reconciled_by: userOf(row.reconciled_by, row.reconciled_by_name),
		best,
		payments,
	};
}

const engineInvoiceOf = (row: Row): EngineInvoice => ({
	id: String(row.id),
	invoice_number: text(row.invoice_number),
	client_id: text(row.client_id),
	client_name: text(row.client_name),
	client_entity_name: text(row.client_entity_name),
	tax_id: text(row.tax_id),
	currency: (text(row.invoice_currency) ?? '').toUpperCase(),
	balance: money(row.balance),
	due_date: text(row.due_date),
	contract_id: text(row.contract_id),
});

const emptyTiers = () => ({ exact: 0, high: 0, medium: 0, none: 0 });

/**
 * Conciliación bancaria v2 (`docs/v2-rediseno/spec-conciliacion-v2.md` §3–§6): importación de cartolas con deduplicación por línea, cola de
 * abonos con estado derivado, motor de sugerencias (puro, `billing-reconciliation-match.ts`), conciliar con vista previa (todo o nada por
 * ítem), deshacer, ignorar/reabrir y plantillas. Todo pago pasa por `BillingPaymentsService.register` y se deshace con `void` (single path);
 * toda escritura es `withApiWriter` (`setApiWriter` primera sentencia) y todo SQL filtra `holding_id`.
 */
@Injectable()
export class BillingReconciliationService {
	constructor(
		private readonly dataSource: DataSource,
		private readonly payments: BillingPaymentsService
	) {}

	/** "Hoy" del holding en su zona horaria (`holding_settings.timezone`, ronda 4 de Configuración; default America/Santiago). */
	async today(now = new Date(), holdingId?: string | null): Promise<string> {
		return todayFor(await holdingTimezone(this.dataSource, holdingId), now);
	}

	// ---------------------------------------------------------------- lecturas

	/** KPIs de la pestaña (montos por moneda, nunca sumados) + cuentas, fuente y último lote. */
	async summary(holdingId: string, query: ReconciliationSummaryQueryDto, now = new Date()) {
		const today = await this.today(now, holdingId);
		const period = { from: query.from ?? `${today.slice(0, 7)}-01`, to: query.to ?? monthEndOf(query.from ?? today) };
		const params = new SqlParams();
		const holding = params.add(holdingId);
		const scope: string[] = [];

		if (query.bank_account_id) scope.push(`mv.bank_account_id = ${params.add(query.bank_account_id)}::uuid`);
		const dates: string[] = [];

		if (query.from) dates.push(`mv.date >= ${params.add(query.from)}::text`);
		if (query.to) dates.push(`mv.date <= ${params.add(query.to)}::text`);
		const inDates = dates.length ? dates.join(' AND ') : 'true';
		const start = params.add(period.from);
		const end = params.add(period.to);
		const open = `mv.state IN ('pending', 'partial') AND ${inDates}`;
		const reconciled = `mv.state = 'reconciled' AND mv.reconciled_at >= ${start}::date AND mv.reconciled_at < (${end}::date + 1)`;
		const differences = `(mv.state = 'partial' OR (mv.adjustments > 0 AND mv.state <> 'ignored')) AND ${inDates}`;
		const unidentified = `mv.state = 'pending' AND mv.suggested_invoice_id IS NULL AND ${inDates}`;
		const [rows, accounts, [meta]] = (await Promise.all([
			this.dataSource.query(
				`${movementsCte(holding)} SELECT mv.currency,
					COUNT(*) FILTER (WHERE ${open}) AS pending_count,
					COALESCE(SUM(mv.amount - mv.applied) FILTER (WHERE ${open}), 0) AS pending_amount,
					COUNT(*) FILTER (WHERE ${reconciled}) AS reconciled_count,
					COALESCE(SUM(mv.amount) FILTER (WHERE ${reconciled}), 0) AS reconciled_amount,
					COUNT(*) FILTER (WHERE ${differences}) AS differences_count,
					COALESCE(SUM((CASE WHEN mv.state = 'partial' THEN mv.amount - mv.applied ELSE 0 END) + mv.adjustments) FILTER (WHERE ${differences}), 0) AS differences_amount,
					COUNT(*) FILTER (WHERE ${unidentified}) AS unidentified_count,
					COALESCE(SUM(mv.amount) FILTER (WHERE ${unidentified}), 0) AS unidentified_amount,
					COUNT(*) FILTER (WHERE mv.state = 'ignored' AND ${inDates}) AS ignored_count,
					COUNT(*) FILTER (WHERE ${open} AND mv.match_confidence = 'high' AND mv.match_score >= 100) AS tier_exact,
					COUNT(*) FILTER (WHERE ${open} AND mv.match_confidence = 'high' AND COALESCE(mv.match_score, 0) < 100) AS tier_high,
					COUNT(*) FILTER (WHERE ${open} AND mv.match_confidence = 'medium') AS tier_medium,
					COUNT(*) FILTER (WHERE ${open} AND mv.match_confidence IS NULL) AS tier_none
				FROM mv ${scope.length ? `WHERE ${scope.join(' AND ')}` : ''} GROUP BY 1 ORDER BY 1`,
				params.values
			),
			this.dataSource.query(
				`SELECT ba.id, ba.company_id, co.legal_name AS company_name, ba.bank_name, ba.account_number, UPPER(ba.currency) AS currency,
					COUNT(m.id) AS movements, MAX(m.movement_date)::text AS last_movement_date
				FROM company_bank_accounts ba
				LEFT JOIN companies co ON co.id = ba.company_id
				LEFT JOIN bank_upload_batches b ON b.bank_account_id = ba.id AND b.holding_id = ba.holding_id
				LEFT JOIN bank_movements m ON m.batch_id = b.id AND m.holding_id = ba.holding_id
				WHERE ba.holding_id = $1
				GROUP BY ba.id, ba.company_id, co.legal_name, ba.bank_name, ba.account_number, ba.currency
				ORDER BY co.legal_name NULLS LAST, ba.bank_name, ba.account_number`,
				[holdingId]
			),
			this.dataSource.query(
				`SELECT EXISTS (SELECT 1 FROM bank_movements WHERE holding_id = $1) AS has_source,
					(SELECT jsonb_build_object('id', b.id, 'file_name', b.file_name, 'created_at', b.created_at, 'status', b.status, 'row_count', b.row_count)
						FROM bank_upload_batches b WHERE b.holding_id = $1 ORDER BY b.created_at DESC LIMIT 1) AS last_batch`,
				[holdingId]
			),
		])) as Row[][];
		const block = (prefix: string) => ({
			count: rows.reduce((total, row) => total + int(row[`${prefix}_count`]), 0),
			by_currency: rows
				.filter((row) => int(row[`${prefix}_count`]) > 0)
				.map((row) => ({ currency: text(row.currency), amount: money(row[`${prefix}_amount`]) })),
		});
		const tiers = emptyTiers();

		for (const row of rows) {
			tiers.exact += int(row.tier_exact);
			tiers.high += int(row.tier_high);
			tiers.medium += int(row.tier_medium);
			tiers.none += int(row.tier_none);
		}

		return {
			period,
			pending: block('pending'),
			reconciled_period: block('reconciled'),
			differences: block('differences'),
			unidentified: block('unidentified'),
			ignored: { count: rows.reduce((total, row) => total + int(row.ignored_count), 0) },
			by_confidence: tiers,
			accounts: accounts.map((row) => ({
				id: String(row.id),
				company_id: text(row.company_id),
				company_name: text(row.company_name),
				bank_name: text(row.bank_name),
				account_number: text(row.account_number),
				currency: text(row.currency),
				movements: int(row.movements),
				last_movement_date: text(row.last_movement_date),
			})),
			has_source: meta?.has_source === true,
			last_batch: meta?.last_batch ? json(meta.last_batch) : null,
		};
	}

	/** Cola paginada (abonos por defecto) con la mejor sugerencia calculada en vivo para la página y los pagos de cada movimiento. */
	async movements(holdingId: string, query: ReconciliationMovementsQueryDto, now = new Date()) {
		const today = await this.today(now, holdingId);
		const page = query.page ?? 1;
		const limit = query.limit ?? 50;
		const params = new SqlParams();
		const holding = params.add(holdingId);
		const where: string[] = [];
		const states = splitList(query.state);

		if (query.kpi === 'pending') where.push(`mv.state IN ('pending', 'partial')`);
		else if (query.kpi === 'reconciled') {
			const from = query.from ?? `${today.slice(0, 7)}-01`;
			const to = query.to ?? monthEndOf(query.from ?? today);

			where.push(
				`mv.state = 'reconciled' AND mv.reconciled_at >= ${params.add(from)}::date AND mv.reconciled_at < (${params.add(to)}::date + 1)`
			);
		} else if (query.kpi === 'differences') where.push(`(mv.state = 'partial' OR (mv.adjustments > 0 AND mv.state <> 'ignored'))`);
		else if (query.kpi === 'unidentified') where.push(`mv.state = 'pending' AND mv.suggested_invoice_id IS NULL`);
		if (!query.kpi) {
			const wanted = states.length ? states : ['pending', 'partial', ...(query.include_debits ? ['debit'] : [])];

			where.push(`mv.state = ANY(${params.add(wanted)}::text[])`);
		} else if (states.length) where.push(`mv.state = ANY(${params.add(states)}::text[])`);
		if (query.kpi !== 'reconciled') {
			if (query.from) where.push(`mv.date >= ${params.add(query.from)}::text`);
			if (query.to) where.push(`mv.date <= ${params.add(query.to)}::text`);
		}
		if (!query.include_debits && !states.includes('debit')) where.push(`mv.state <> 'debit'`);
		if (query.bank_account_id) where.push(`mv.bank_account_id = ${params.add(query.bank_account_id)}::uuid`);
		const confidences = splitList(query.confidence);

		if (confidences.length) {
			const rules: Record<string, string> = {
				exact: `(mv.match_confidence = 'high' AND mv.match_score >= 100)`,
				high: `(mv.match_confidence = 'high' AND COALESCE(mv.match_score, 0) < 100)`,
				medium: `(mv.match_confidence = 'medium')`,
				none: `(mv.match_confidence IS NULL)`,
			};

			where.push(
				`(${confidences
					.map((value) => rules[value])
					.filter(Boolean)
					.join(' OR ')})`
			);
		}
		if (query.q) {
			const like = params.add(`%${query.q.replace(/[\\%_]/g, (char) => `\\${char}`)}%`);

			where.push(
				`(mv.description ILIKE ${like} OR mv.original_row_data->>'reference' ILIKE ${like} OR mv.original_row_data->>'counterparty_name' ILIKE ${like}
					OR mv.original_row_data->>'counterparty_tax_id' ILIKE ${like} OR mv.amount::text ILIKE ${like})`
			);
		}
		const condition = where.length ? `WHERE ${where.join(' AND ')}` : '';
		const countParams = [...params.values];
		const direction = query.sortOrder === 'asc' ? 'ASC' : 'DESC';
		const column = query.sortBy === 'amount' ? 'mv.amount' : 'mv.date';
		const [rows, [count]] = (await Promise.all([
			this.dataSource.query(
				`${movementsCte(holding)} SELECT mv.* FROM mv ${condition} ORDER BY ${column} ${direction} NULLS LAST, mv.created_at ${direction}, mv.id
				LIMIT ${Number(limit)} OFFSET ${(page - 1) * Number(limit)}`,
				params.values
			),
			this.dataSource.query(`${movementsCte(holding)} SELECT COUNT(*) AS total FROM mv ${condition}`, countParams),
		])) as Row[][];
		const data = await this.decorateRows(holdingId, rows, today, query.fee_threshold_pct);

		return paginated(data, int(count?.total), page, limit);
	}

	/** Detalle de un movimiento: hasta 5 sugerencias (incluye muchos-a-1) y movimientos relacionados del mismo pagador. */
	async suggestions(holdingId: string, movementId: string, query: ReconciliationSuggestionsQueryDto, now = new Date()) {
		const today = await this.today(now, holdingId);
		const [row] = (await this.dataSource.query(`${movementsCte('$1')} SELECT mv.* FROM mv WHERE mv.id = $2`, [holdingId, movementId])) as Row[];

		if (!row) throw new NotFoundException('Movimiento no encontrado');
		const movement = engineMovementOf(row);
		const open = row.state === 'pending' || row.state === 'partial';
		const around = open
			? ((await this.dataSource.query(
					`${movementsCte('$1')} SELECT mv.* FROM mv WHERE mv.state IN ('pending', 'partial') AND mv.currency = $2 AND mv.id <> $3
						AND mv.date::date BETWEEN ($4::date - 10) AND ($4::date + 10) ORDER BY mv.date, mv.id LIMIT 200`,
					[holdingId, movement.currency, movementId, movement.date]
				)) as Row[])
			: [];
		const aroundEngine = around.map(engineMovementOf);
		const related = relatedMovements(movement, aroundEngine);
		const relatedIds = new Set(related.map((entry) => entry.id));
		const ctx = open ? await this.context(holdingId, today, [movement.currency], query.fee_threshold_pct) : null;
		const suggestions = ctx ? suggestMatches(movement, ctx, aroundEngine) : [];
		const relatedRows = around.filter((entry) => relatedIds.has(String(entry.id)));
		const payments = await this.paymentsFor(holdingId, [movementId, ...relatedRows.map((entry) => String(entry.id))]);

		return {
			movement: movementRowOf(row, suggestions.find((entry) => entry.shape !== 'many_to_one') ?? null, payments.get(movementId) ?? []),
			suggestions,
			related_movements: relatedRows.map((entry) => movementRowOf(entry, null, payments.get(String(entry.id)) ?? [])),
		};
	}

	/** Facturas cobrables con saldo > 0 (regla única `balanceSql`), vencimiento más antiguo primero; las sin contrato van `read_only`. */
	async candidates(holdingId: string, query: ReconciliationCandidatesQueryDto, now = new Date()) {
		const rows = await this.candidateRows(holdingId, await this.today(now, holdingId), {
			currencies: query.currency ? [query.currency.toUpperCase()] : [],
			clientId: query.client_id,
			q: query.q,
			limit: query.limit ?? 20,
			contractOnly: false,
		});

		return {
			data: rows.map((row) => ({
				invoice_id: String(row.id),
				invoice_number: text(row.invoice_number),
				client_id: text(row.client_id),
				client_name: text(row.client_name),
				client_entity_name: text(row.client_entity_name),
				tax_id: text(row.tax_id),
				contract_id: text(row.contract_id),
				read_only: !row.contract_id,
				currency: text(row.invoice_currency),
				total: num(row.total_due),
				balance: money(row.balance),
				due_date: text(row.due_date),
				issue_date: text(row.issue_date),
				status: text(row.status),
				payment_state: text(row.payment_state),
			})),
		};
	}

	// ---------------------------------------------------------------- cartolas

	async previewStatement(holdingId: string, dto: StatementPreviewDto) {
		const prepared = await this.prepareStatement(this.dataSource, holdingId, dto);

		return { account: prepared.account, lines: prepared.lines, summary: prepared.summary, warnings: prepared.warnings };
	}

	/**
	 * Importa una cartola: lock por holding (`pg_advisory_xact_lock`), cuenta del holding (404), líneas nuevas por huella (las ya existentes se
	 * omiten), lote + movimientos (`ON CONFLICT DO NOTHING`), plantilla opcional; 409 `nothing_to_import` si no hay nada nuevo. Después
	 * refresca las sugerencias persistidas de los abonos nuevos (aparte, sin bloquear la importación).
	 */
	async importStatement(holdingId: string, dto: StatementImportDto, authId: string, now = new Date()) {
		await resolveUserId(this.dataSource, authId);
		const result = await withApiWriter(this.dataSource, async (runner) => {
			await runner.query(`SELECT pg_advisory_xact_lock(hashtext('bank_movements:' || $1))`, [holdingId]);
			const prepared = await this.prepareStatement(runner, holdingId, dto);
			const fresh = prepared.parsed.filter((line, index) => prepared.lines[index].status === 'new');

			if (!fresh.length) {
				throw new ConflictException({
					message: 'No hay líneas nuevas para importar',
					code: 'blocked',
					blockers: [
						{
							code: 'nothing_to_import',
							message: `Las ${prepared.summary.total} líneas ya estaban importadas o tienen errores`,
							next_step: 'Revisa el archivo o el mapeo',
						},
					],
					preview: { summary: prepared.summary, warnings: prepared.warnings },
				});
			}
			const [batch] = (await runner.query(
				`INSERT INTO bank_upload_batches (holding_id, company_id, bank_account_id, file_name, file_hash, row_count, column_mapping, status, uploaded_by)
				VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, 'Procesado', $8) RETURNING id`,
				[
					holdingId,
					prepared.account.company_id,
					prepared.account.id,
					dto.file_name,
					dto.file_hash,
					fresh.length,
					JSON.stringify({
						...dto.mapping,
						format: dto.format,
						source: 'file',
						skipped_duplicates: prepared.summary.duplicates,
						errors: prepared.summary.errors,
					}),
					// uploaded_by / reconciled_by apuntan a auth.users: van con el authId, no con el id de `users`.
					authId,
				]
			)) as Row[];
			const batchId = String(batch.id);
			const insertedIds: string[] = [];
			const bankName = dto.mapping.bank_name || prepared.account.bank_name;

			for (let start = 0; start < fresh.length; start += INSERT_CHUNK) {
				const chunk = fresh.slice(start, start + INSERT_CHUNK).map((line) => ({
					movement_date: line.date,
					description: line.description,
					amount: line.amount,
					currency: line.currency ?? prepared.account.currency,
					original_row_data: {
						raw: line.raw,
						row: line.row,
						fingerprint: line.fingerprint,
						reference: line.reference,
						counterparty_tax_id: line.counterparty_tax_id,
						counterparty_name: line.counterparty_name,
						balance: line.balance,
						bank_account_id: prepared.account.id,
					},
				}));
				// Sin conflict target: funciona antes y después del índice único de huella (migración 1790740000000).
				const inserted = (await runner.query(
					`INSERT INTO bank_movements (holding_id, company_id, bank_name, bank_account, movement_date, description, amount, currency, status, batch_id, original_row_data)
					SELECT $1, $2, $3, $4, x.movement_date, x.description, x.amount, x.currency, '${MOVEMENT_STATUS.pending}', $5, x.original_row_data
					FROM jsonb_to_recordset($6::jsonb) AS x(movement_date date, description text, amount numeric, currency text, original_row_data jsonb)
					ON CONFLICT DO NOTHING RETURNING id`,
					[holdingId, prepared.account.company_id, bankName, prepared.account.account_number, batchId, JSON.stringify(chunk)]
				)) as Row[];

				insertedIds.push(...inserted.map((row) => String(row.id)));
			}
			if (insertedIds.length !== fresh.length) {
				await runner.query(`UPDATE bank_upload_batches SET row_count = $3 WHERE id = $1 AND holding_id = $2`, [
					batchId,
					holdingId,
					insertedIds.length,
				]);
			}
			let templateId: string | null = null;

			if (dto.save_template) templateId = await this.insertTemplate(runner, holdingId, { ...dto.save_template, column_mapping: dto.mapping });

			return {
				batch_id: batchId,
				inserted: insertedIds.length,
				skipped_duplicates: prepared.summary.duplicates + (fresh.length - insertedIds.length),
				errors: prepared.summary.errors,
				template_id: templateId,
				warnings: prepared.warnings,
				insertedIds,
			};
		});
		const credits = result.insertedIds;
		let suggestions = emptyTiers();

		try {
			suggestions = (await this.refreshPersisted(holdingId, await this.today(now, holdingId), DEFAULT_FEE_THRESHOLD_PCT, credits))
				.by_confidence;
		} catch {
			// Best effort: la importación ya quedó; las sugerencias se recalculan con "Actualizar sugerencias".
		}
		return {
			batch_id: result.batch_id,
			inserted: result.inserted,
			skipped_duplicates: result.skipped_duplicates,
			errors: result.errors,
			template_id: result.template_id,
			warnings: result.warnings,
			suggestions,
		};
	}

	/** Lotes importados (paginado) con conteos y si se pueden revertir. */
	async statements(holdingId: string, query: StatementsListQueryDto) {
		const page = query.page ?? 1;
		const limit = query.limit ?? 20;
		const [rows, [count]] = (await Promise.all([
			this.dataSource.query(
				`SELECT b.id, b.file_name, b.created_at, b.uploaded_by, COALESCE(u.name, u.email) AS uploaded_by_name, b.bank_account_id, ba.bank_name,
					ba.account_number, UPPER(ba.currency) AS currency, b.row_count, b.status,
					(SELECT COUNT(*) FROM bank_movements m WHERE m.batch_id = b.id AND m.holding_id = b.holding_id) AS movements,
					(SELECT COUNT(*) FROM bank_movements m WHERE m.batch_id = b.id AND m.holding_id = b.holding_id AND m.status = '${MOVEMENT_STATUS.reconciled}') AS reconciled,
					EXISTS (SELECT 1 FROM invoice_payments p JOIN bank_movements m ON m.id = p.bank_movement_id AND m.holding_id = p.holding_id
						WHERE m.batch_id = b.id AND p.holding_id = b.holding_id) AS has_payments
				FROM bank_upload_batches b
				LEFT JOIN users u ON u.auth_id = b.uploaded_by
				LEFT JOIN company_bank_accounts ba ON ba.id = b.bank_account_id AND ba.holding_id = b.holding_id
				WHERE b.holding_id = $1
				ORDER BY b.created_at DESC, b.id LIMIT ${Number(limit)} OFFSET ${(page - 1) * Number(limit)}`,
				[holdingId]
			),
			this.dataSource.query(`SELECT COUNT(*) AS total FROM bank_upload_batches WHERE holding_id = $1`, [holdingId]),
		])) as Row[][];

		return paginated(
			rows.map((row) => {
				const reverted = row.status === 'Revertido';
				const blocker = reverted ? 'already_reverted' : row.has_payments === true ? 'batch_has_payments' : null;

				return {
					id: String(row.id),
					file_name: text(row.file_name),
					created_at: iso(row.created_at),
					uploaded_by: userOf(row.uploaded_by, row.uploaded_by_name),
					bank_account: row.bank_account_id
						? {
								id: String(row.bank_account_id),
								bank_name: text(row.bank_name),
								account_number: text(row.account_number),
								currency: text(row.currency),
							}
						: null,
					row_count: int(row.row_count),
					status: text(row.status),
					movements: int(row.movements),
					reconciled: int(row.reconciled),
					can_revert: blocker === null,
					revert_blocker: blocker,
				};
			}),
			int(count?.total),
			page,
			limit
		);
	}

	/** Revierte un lote sin efecto financiero: borra sus líneas y lo marca `Revertido` con el motivo en `column_mapping.revert`. */
	async revertStatement(holdingId: string, batchId: string, dto: RevertStatementDto, authId: string) {
		const userId = await resolveUserId(this.dataSource, authId);

		return await withApiWriter(this.dataSource, async (runner) => {
			const [batch] = (await runner.query(`SELECT id, status FROM bank_upload_batches WHERE id = $1 AND holding_id = $2 FOR UPDATE`, [
				batchId,
				holdingId,
			])) as Row[];

			if (!batch) throw new NotFoundException('Importación no encontrada');
			if (batch.status === 'Revertido') {
				throw this.blocked([{ code: 'already_reverted', message: 'La importación ya está revertida', next_step: null }]);
			}
			const [usage] = (await runner.query(
				`SELECT COUNT(*) AS payments FROM invoice_payments p JOIN bank_movements m ON m.id = p.bank_movement_id AND m.holding_id = p.holding_id
				WHERE m.batch_id = $1 AND p.holding_id = $2`,
				[batchId, holdingId]
			)) as Row[];

			if (int(usage?.payments) > 0) {
				throw this.blocked([
					{
						code: 'batch_has_payments',
						message: `Hay ${int(usage.payments)} pago(s) registrados desde movimientos de esta importación`,
						next_step: 'Deshaz esas conciliaciones antes de revertir',
					},
				]);
			}
			const removed = rowsOf<Row>(
				await runner.query(`DELETE FROM bank_movements WHERE batch_id = $1 AND holding_id = $2 RETURNING id`, [batchId, holdingId])
			);

			await runner.query(
				`UPDATE bank_upload_batches SET status = 'Revertido',
					column_mapping = column_mapping || jsonb_build_object('revert', jsonb_build_object('reason', $3::text, 'by', $4::text, 'at', now()))
				WHERE id = $1 AND holding_id = $2`,
				[batchId, holdingId, dto.reason, userId]
			);

			return { batch_id: batchId, removed: removed.length };
		});
	}

	// ---------------------------------------------------------------- plantillas

	async templates(holdingId: string) {
		const rows = (await this.dataSource.query(
			`SELECT id, bank_name, mapping_name, column_mapping, is_default, created_at FROM bank_column_mappings WHERE holding_id = $1
			ORDER BY bank_name, is_default DESC NULLS LAST, mapping_name`,
			[holdingId]
		)) as Row[];

		return rows.map(templateOf);
	}

	async createTemplate(holdingId: string, dto: ReconciliationTemplateDto) {
		return await withApiWriter(this.dataSource, async (runner) => {
			const id = await this.insertTemplate(runner, holdingId, dto);
			const [row] = (await runner.query(`SELECT * FROM bank_column_mappings WHERE id = $1 AND holding_id = $2`, [id, holdingId])) as Row[];

			return templateOf(row);
		});
	}

	async updateTemplate(holdingId: string, templateId: string, dto: ReconciliationTemplateDto) {
		return await withApiWriter(this.dataSource, async (runner) => {
			const [current] = (await runner.query(`SELECT id FROM bank_column_mappings WHERE id = $1 AND holding_id = $2 FOR UPDATE`, [
				templateId,
				holdingId,
			])) as Row[];

			if (!current) throw new NotFoundException('Plantilla no encontrada');
			if (dto.is_default) {
				await runner.query(`UPDATE bank_column_mappings SET is_default = false WHERE holding_id = $1 AND bank_name = $2 AND id <> $3`, [
					holdingId,
					dto.bank_name,
					templateId,
				]);
			}
			const [row] = rowsOf<Row>(
				await runner.query(
					`UPDATE bank_column_mappings SET bank_name = $3, mapping_name = $4, column_mapping = $5::jsonb, is_default = $6
					WHERE id = $1 AND holding_id = $2 RETURNING *`,
					[templateId, holdingId, dto.bank_name, dto.mapping_name, JSON.stringify(dto.column_mapping), dto.is_default === true]
				)
			);

			return templateOf(row);
		});
	}

	async deleteTemplate(holdingId: string, templateId: string) {
		return await withApiWriter(this.dataSource, async (runner) => {
			const removed = rowsOf<Row>(
				await runner.query(`DELETE FROM bank_column_mappings WHERE id = $1 AND holding_id = $2 RETURNING id`, [templateId, holdingId])
			);

			if (!removed.length) throw new NotFoundException('Plantilla no encontrada');

			return { id: templateId, deleted: true };
		});
	}

	// ---------------------------------------------------------------- conciliar

	/** Vista previa: por ítem, bloqueos del movimiento (`planMatch`) + los del plan de pagos (`planPayments`), antes/después. No escribe. */
	async previewMatches(holdingId: string, dto: MatchesDto, now = new Date()) {
		const today = await this.today(now, holdingId);
		const items = [];

		for (const item of dto.items) items.push((await this.evaluate(this.dataSource, holdingId, item, today, false)).result);

		return { items, summary: summaryOf(items) };
	}

	/**
	 * Aplica cada ítem en su propia transacción `withApiWriter` (todo o nada por ítem; los demás siguen): movimientos `FOR UPDATE`, efectivo por
	 * `register` (uno por movimiento), ajustes por motivo (`register` con `settlementReason`) y estado de los movimientos.
	 */
	async applyMatches(holdingId: string, dto: MatchesDto, authId: string, now = new Date()) {
		const userId = await resolveUserId(this.dataSource, authId);
		const today = await this.today(now, holdingId);
		const items: Array<ItemResult & { applied: boolean; payment_ids: string[]; event_ids: string[]; error?: string | null }> = [];
		const touched = new Set<string>();

		for (const item of dto.items) {
			let evaluated: ItemResult | null = null;

			try {
				const applied = await withApiWriter(this.dataSource, async (runner) => {
					const evaluation = await this.evaluate(runner, holdingId, item, today, true);

					evaluated = evaluation.result;
					if (!evaluation.result.ok) throw this.blocked(evaluation.result.blockers, evaluation.result);

					return await this.applyItem(runner, holdingId, item, evaluation, authId, userId, now);
				});

				for (const id of item.movement_ids) touched.add(id);
				items.push({ ...applied.result, applied: true, payment_ids: applied.payment_ids, event_ids: applied.event_ids, error: null });
			} catch (error) {
				items.push(failureOf(item, evaluated, error));
			}
		}
		if (touched.size) {
			try {
				await this.refreshPersisted(holdingId, today, DEFAULT_FEE_THRESHOLD_PCT, [...touched]);
			} catch {
				// Best effort: la conciliación ya quedó confirmada.
			}
		}

		return { items, summary: summaryOf(items) };
	}

	/** Deshacer: `void` de todos los pagos y ajustes del movimiento (misma transacción) y movimiento a Pendiente. Nunca DELETE. */
	async undo(holdingId: string, movementId: string, dto: UndoMatchDto, authId: string, now = new Date()) {
		const result = await withApiWriter(this.dataSource, async (runner) => {
			await this.lockMovement(runner, holdingId, movementId);
			const payments = (await runner.query(
				`SELECT id FROM invoice_payments WHERE bank_movement_id = $1 AND holding_id = $2 AND confirmed = true ORDER BY created_at DESC, id`,
				[movementId, holdingId]
			)) as Row[];

			if (!payments.length) {
				throw this.blocked([
					{ code: 'movement_has_no_payments', message: 'El movimiento no tiene pagos ni ajustes para deshacer', next_step: null },
				]);
			}
			const voided: string[] = [];

			for (const payment of payments) {
				await this.payments.void(holdingId, String(payment.id), { reason: dto.reason }, authId, now, { runner });
				voided.push(String(payment.id));
			}
			await runner.query(
				`UPDATE bank_movements SET status = '${MOVEMENT_STATUS.pending}', reconciled_invoice_id = NULL, reconciled_at = NULL, reconciled_by = NULL
				WHERE id = $1 AND holding_id = $2`,
				[movementId, holdingId]
			);

			return { movement_id: movementId, voided_payment_ids: voided, state: 'pending' as MovementState };
		});

		await this.refreshQuietly(holdingId, now, [movementId]);

		return result;
	}

	/** Ignorar / "No es una factura" (motivo obligatorio): solo un abono o cargo pendiente sin pagos. */
	async ignore(holdingId: string, movementId: string, dto: IgnoreMovementDto, authId: string) {
		await resolveUserId(this.dataSource, authId);

		return await withApiWriter(this.dataSource, async (runner) => {
			const movement = await this.lockMovement(runner, holdingId, movementId);

			if (movement.status === MOVEMENT_STATUS.ignored || movement.status === MOVEMENT_STATUS.reconciled) {
				throw this.blocked([
					{
						code: 'movement_not_pending',
						message: movement.status === MOVEMENT_STATUS.ignored ? 'El movimiento ya está ignorado' : 'El movimiento está conciliado',
						next_step: movement.status === MOVEMENT_STATUS.reconciled ? 'Deshaz la conciliación primero' : null,
					},
				]);
			}
			if (int(movement.payments) > 0) {
				throw this.blocked([
					{ code: 'movement_has_payments', message: 'El movimiento tiene pagos registrados', next_step: 'Deshaz la conciliación primero' },
				]);
			}
			await runner.query(
				`UPDATE bank_movements SET status = '${MOVEMENT_STATUS.ignored}', ignore_reason = $3, reconciled_by = $4, reconciled_at = now(),
					suggested_invoice_id = NULL, match_confidence = NULL, match_score = NULL
				WHERE id = $1 AND holding_id = $2`,
				[movementId, holdingId, dto.reason, authId]
			);

			return { movement_id: movementId, state: 'ignored' as MovementState };
		});
	}

	/** Reabrir un ignorado: vuelve a Por conciliar; el motivo anterior y el de reapertura quedan en `original_row_data.reopened`. */
	async reopen(holdingId: string, movementId: string, dto: ReopenMovementDto, authId: string, now = new Date()) {
		const userId = await resolveUserId(this.dataSource, authId);
		const result = await withApiWriter(this.dataSource, async (runner) => {
			const movement = await this.lockMovement(runner, holdingId, movementId);

			if (movement.status !== MOVEMENT_STATUS.ignored) {
				throw this.blocked([{ code: 'movement_not_ignored', message: 'El movimiento no está ignorado', next_step: null }]);
			}
			await runner.query(
				`UPDATE bank_movements SET status = '${MOVEMENT_STATUS.pending}', ignore_reason = NULL, reconciled_by = NULL, reconciled_at = NULL,
					original_row_data = COALESCE(original_row_data, '{}'::jsonb) || jsonb_build_object('reopened',
						jsonb_build_object('reason', $3::text, 'previous_reason', ignore_reason, 'by', $4::text, 'at', now()))
				WHERE id = $1 AND holding_id = $2`,
				[movementId, holdingId, dto.reason ?? null, userId]
			);

			return { movement_id: movementId, state: (Number(movement.amount) > 0 ? 'pending' : 'debit') as MovementState };
		});

		await this.refreshQuietly(holdingId, now, [movementId]);

		return result;
	}

	/** Recalcula y persiste la mejor sugerencia de los abonos abiertos del holding (filtro por confianza y KPI "Sin identificar"). */
	async refreshSuggestions(holdingId: string, dto: RefreshSuggestionsDto, now = new Date()) {
		return await this.refreshPersisted(holdingId, await this.today(now, holdingId), dto.fee_threshold_pct ?? DEFAULT_FEE_THRESHOLD_PCT, null);
	}

	// ---------------------------------------------------------------- internos

	private async decorateRows(holdingId: string, rows: Row[], today: string, feeThresholdPct?: number) {
		const open = rows.filter((row) => (row.state === 'pending' || row.state === 'partial') && money(row.amount) > 0);
		const currencies = [...new Set(open.map((row) => (text(row.currency) ?? '').toUpperCase()))];
		const [ctx, payments] = await Promise.all([
			open.length ? this.context(holdingId, today, currencies, feeThresholdPct) : Promise.resolve(null),
			this.paymentsFor(
				holdingId,
				rows.map((row) => String(row.id))
			),
		]);

		return rows.map((row) => {
			const isOpen = ctx && open.includes(row);
			const best = isOpen ? (suggestMatches(engineMovementOf(row), ctx)[0] ?? null) : null;

			return movementRowOf(row, best, payments.get(String(row.id)) ?? []);
		});
	}

	private async paymentsFor(holdingId: string, ids: string[]): Promise<Map<string, PaymentRow[]>> {
		const map = new Map<string, PaymentRow[]>();

		if (!ids.length) return map;
		const rows = (await this.dataSource.query(MOVEMENT_PAYMENTS_SQL, [holdingId, ids])) as Row[];

		for (const row of rows) {
			const key = String(row.bank_movement_id);

			map.set(key, [...(map.get(key) ?? []), paymentOf(row)]);
		}

		return map;
	}

	/** Facturas con saldo > 0 desde `invoicesCte` (+ RUT de la razón social), vencimiento más antiguo primero. */
	private async candidateRows(
		holdingId: string,
		today: string,
		options: { currencies: string[]; clientId?: string; q?: string; limit: number; contractOnly: boolean }
	): Promise<Row[]> {
		const params = new SqlParams();
		const { cte } = invoicesCte(
			holdingId,
			{ client_id: options.clientId, invoice_currency: options.currencies.length ? options.currencies.join(',') : undefined },
			params,
			{ today, applyPeriod: false }
		);
		const holding = params.add(holdingId);
		const where = ['d.balance > 0'];

		if (options.contractOnly) where.push('d.contract_id IS NOT NULL');
		if (options.q) {
			const like = params.add(`%${options.q.replace(/[\\%_]/g, (char) => `\\${char}`)}%`);

			where.push(
				`(d.invoice_number ILIKE ${like} OR d.client_name ILIKE ${like} OR d.client_entity_name ILIKE ${like} OR ce2.tax_id ILIKE ${like})`
			);
		}

		return (await this.dataSource.query(
			`${cte} SELECT d.id, d.invoice_number, d.client_id, d.client_name, d.client_entity_name, ce2.tax_id, d.contract_id, d.invoice_currency,
				d.total_due, d.balance, d.due_date, d.issue_date, d.status, d.payment_state
			FROM d LEFT JOIN client_entities ce2 ON ce2.id = d.client_entity_id AND ce2.holding_id = ${holding}
			WHERE ${where.join(' AND ')}
			ORDER BY d.due_date ASC NULLS LAST, d.id LIMIT ${Number(options.limit)}`,
			params.values
		)) as Row[];
	}

	/** Contexto del motor: facturas con contrato y saldo (de las monedas pedidas) + alias aprendidos del historial de pagos desde cartola. */
	private async context(holdingId: string, today: string, currencies: string[], feeThresholdPct?: number): Promise<EngineContext> {
		const [invoices, history] = await Promise.all([
			this.candidateRows(holdingId, today, { currencies, limit: ENGINE_MAX_INVOICES, contractOnly: true }),
			this.dataSource.query(
				`SELECT m.description, m.original_row_data->>'counterparty_tax_id' AS tax_id, COALESCE(i.client_id, c.client_id) AS client_id
				FROM invoice_payments p
				JOIN bank_movements m ON m.id = p.bank_movement_id AND m.holding_id = p.holding_id
				JOIN invoices i ON i.id = p.invoice_id AND i.holding_id = p.holding_id
				LEFT JOIN contracts c ON c.id = i.contract_id AND c.holding_id = i.holding_id
				WHERE p.holding_id = $1 AND p.confirmed = true AND p.settlement_reason IS NULL
				ORDER BY p.created_at DESC LIMIT 5000`,
				[holdingId]
			) as Promise<Row[]>,
		]);
		const learned = learnAliases(
			history.map((row) => ({ description: text(row.description), tax_id: text(row.tax_id), client_id: text(row.client_id) }))
		);

		return {
			invoices: invoices.map(engineInvoiceOf),
			aliases: learned.aliases,
			recurrentClients: learned.recurrentClients,
			feeThresholdPct: feeThresholdPct ?? DEFAULT_FEE_THRESHOLD_PCT,
		};
	}

	/** Persiste la mejor sugerencia (`suggested_invoice_id`, `match_confidence`, `match_score`) de los abonos abiertos (o de `ids`). */
	private async refreshPersisted(holdingId: string, today: string, feeThresholdPct: number, ids: string[] | null) {
		const tiers = emptyTiers();

		if (ids && !ids.length) return { updated: 0, by_confidence: tiers };
		const rows = (await this.dataSource.query(
			`${movementsCte('$1')} SELECT mv.* FROM mv WHERE mv.state IN ('pending', 'partial')${ids ? ' AND mv.id = ANY($2::uuid[])' : ''}
			ORDER BY mv.date DESC, mv.id LIMIT ${REFRESH_MAX_MOVEMENTS}`,
			ids ? [holdingId, ids] : [holdingId]
		)) as Row[];

		if (!rows.length) return { updated: 0, by_confidence: tiers };
		const ctx = await this.context(holdingId, today, [...new Set(rows.map((row) => (text(row.currency) ?? '').toUpperCase()))], feeThresholdPct);
		const computed = rows.map((row) => ({ id: String(row.id), ...persistedMatch(suggestMatches(engineMovementOf(row), ctx)[0] ?? null) }));

		for (const entry of computed) tiers[tierOf(entry.match_confidence, entry.match_score)] += 1;
		await withApiWriter(this.dataSource, async (runner) => {
			await runner.query(
				`UPDATE bank_movements m SET suggested_invoice_id = x.invoice_id, match_confidence = x.confidence, match_score = x.score
				FROM unnest($2::uuid[], $3::uuid[], $4::text[], $5::numeric[]) AS x(id, invoice_id, confidence, score)
				WHERE m.id = x.id AND m.holding_id = $1 AND m.status = '${MOVEMENT_STATUS.pending}'`,
				[
					holdingId,
					computed.map((entry) => entry.id),
					computed.map((entry) => entry.suggested_invoice_id),
					computed.map((entry) => entry.match_confidence),
					computed.map((entry) => entry.match_score),
				]
			);
		});

		return { updated: computed.length, by_confidence: tiers };
	}

	private async refreshQuietly(holdingId: string, now: Date, ids: string[]) {
		try {
			await this.refreshPersisted(holdingId, await this.today(now, holdingId), DEFAULT_FEE_THRESHOLD_PCT, ids);
		} catch {
			// Best effort.
		}
	}

	private async lockMovement(runner: QueryRunner, holdingId: string, movementId: string): Promise<Row> {
		const [locked] = (await runner.query(`SELECT id FROM bank_movements WHERE id = $1 AND holding_id = $2 FOR UPDATE`, [
			movementId,
			holdingId,
		])) as Row[];

		if (!locked) throw new NotFoundException('Movimiento no encontrado');
		const [movement] = (await runner.query(
			`SELECT m.id, m.status, m.amount, COALESCE(ap.payments, 0) AS payments FROM bank_movements m ${APPLIED_LATERAL} WHERE m.id = $1 AND m.holding_id = $2`,
			[movementId, holdingId]
		)) as Row[];

		return movement ?? locked;
	}

	/** Cuenta (404 `no_bank_account`), normalización, huellas ya importadas, estado por línea, resumen y aviso de archivo repetido. */
	private async prepareStatement(db: Queryable, holdingId: string, dto: StatementPreviewDto) {
		const [accountRow] = (await db.query(ACCOUNT_SQL, [dto.bank_account_id, holdingId])) as Row[];

		if (!accountRow) {
			throw new NotFoundException({ message: 'Cuenta bancaria no encontrada en el holding', code: 'no_bank_account' });
		}
		const account = {
			id: String(accountRow.id),
			company_id: text(accountRow.company_id),
			company_name: text(accountRow.company_name),
			bank_name: text(accountRow.bank_name),
			account_number: text(accountRow.account_number),
			currency: text(accountRow.currency),
		};
		const mapping = dto.mapping as StatementMapping;
		const mappingBlockers = validateMapping(dto.headers, mapping);

		if (mappingBlockers.length) {
			throw new BadRequestException({
				message: mappingBlockers.map((blocker) => blocker.message).join('; '),
				code: 'invalid_mapping',
				blockers: mappingBlockers,
			});
		}
		const parsed = parseStatement(dto.headers, dto.rows, mapping, account as StatementAccount);
		const fingerprints = parsed.map((line) => line.fingerprint).filter((value): value is string => !!value);
		const [existing, previous] = (await Promise.all([
			fingerprints.length
				? db.query(
						`SELECT id, original_row_data->>'fingerprint' AS fingerprint FROM bank_movements
						WHERE holding_id = $1 AND original_row_data->>'fingerprint' = ANY($2::text[])`,
						[holdingId, fingerprints]
					)
				: Promise.resolve([]),
			dto.file_hash
				? db.query(
						`SELECT id, file_name, created_at FROM bank_upload_batches WHERE holding_id = $1 AND file_hash = $2 AND status <> 'Revertido'
						ORDER BY created_at DESC LIMIT 1`,
						[holdingId, dto.file_hash]
					)
				: Promise.resolve([]),
		])) as Row[][];
		const known = new Map(existing.map((row) => [String(row.fingerprint), String(row.id)]));
		const lines = parsed.map((line) => lineOf(line, known));
		const byCurrency = new Map<string, { currency: string; credits: number; debits: number; count: number }>();

		for (const line of lines) {
			if (line.status === 'error' || line.amount === null) continue;
			const currency = line.currency ?? account.currency ?? '—';
			const entry = byCurrency.get(currency) ?? { currency, credits: 0, debits: 0, count: 0 };

			if (line.amount > 0) entry.credits = round2(entry.credits + line.amount);
			else entry.debits = round2(entry.debits + Math.abs(line.amount));
			entry.count += 1;
			byCurrency.set(currency, entry);
		}
		const valid = lines.filter((line) => line.status !== 'error');

		return {
			account,
			parsed,
			lines,
			summary: {
				total: lines.length,
				new: lines.filter((line) => line.status === 'new').length,
				duplicates: lines.filter((line) => line.status === 'duplicate').length,
				errors: lines.filter((line) => line.status === 'error').length,
				credits: valid.filter((line) => line.kind === 'credit').length,
				debits: valid.filter((line) => line.kind === 'debit').length,
				by_currency: [...byCurrency.values()].sort((a, b) => a.currency.localeCompare(b.currency)),
			},
			warnings: previous.length
				? [
						{
							code: 'file_already_imported',
							message: `Este archivo ya se importó (${text(previous[0].file_name)}); solo se cargarán las líneas nuevas`,
							batch_id: String(previous[0].id),
						},
					]
				: [],
		};
	}

	private async insertTemplate(
		runner: QueryRunner,
		holdingId: string,
		dto: { bank_name: string; mapping_name: string; is_default?: boolean; column_mapping: unknown }
	): Promise<string> {
		if (dto.is_default) {
			await runner.query(`UPDATE bank_column_mappings SET is_default = false WHERE holding_id = $1 AND bank_name = $2`, [
				holdingId,
				dto.bank_name,
			]);
		}
		const [row] = (await runner.query(
			`INSERT INTO bank_column_mappings (holding_id, bank_name, mapping_name, column_mapping, is_default) VALUES ($1, $2, $3, $4::jsonb, $5) RETURNING id`,
			[holdingId, dto.bank_name, dto.mapping_name, JSON.stringify(dto.column_mapping), dto.is_default === true]
		)) as Row[];

		return String(row.id);
	}

	/**
	 * Evalúa un ítem: movimientos (con `FOR UPDATE` al aplicar), facturas, `planMatch` y el plan de pagos de `register` (efectivo + ajustes,
	 * misma moneda de factura) para los bloqueos y el antes/después.
	 */
	private async evaluate(db: Queryable, holdingId: string, item: MatchItemDto, today: string, lock: boolean): Promise<Evaluation> {
		const ids = [...new Set(item.movement_ids)];

		if (lock)
			await db.query(`SELECT id FROM bank_movements WHERE holding_id = $1 AND id = ANY($2::uuid[]) ORDER BY id FOR UPDATE`, [holdingId, ids]);
		const movementRows = (await db.query(
			`SELECT m.id, m.amount, UPPER(m.currency) AS currency, m.status, m.movement_date::text AS date, m.description, m.bank_name, m.bank_account,
				COALESCE(ap.applied, 0) AS applied
			FROM bank_movements m ${APPLIED_LATERAL}
			WHERE m.holding_id = $1 AND m.id = ANY($2::uuid[])`,
			[holdingId, ids]
		)) as Row[];
		const movements = new Map(
			movementRows.map((row) => [
				String(row.id),
				{
					id: String(row.id),
					amount: money(row.amount),
					currency: (text(row.currency) ?? '').toUpperCase(),
					status: text(row.status),
					applied: money(row.applied),
					date: text(row.date) ?? today,
					description: text(row.description),
					bank_name: text(row.bank_name),
					bank_account: text(row.bank_account),
				},
			])
		);
		const adjustments = item.adjustments ?? [];
		const invoiceIds = [...new Set([...item.allocations.map((entry) => entry.invoice_id), ...adjustments.map((entry) => entry.invoice_id)])];
		const infoRows = invoiceIds.length ? ((await db.query(INVOICE_INFO_SQL, [holdingId, invoiceIds])) as Row[]) : [];
		const infos = new Map(infoRows.map((row) => [String(row.id), row]));
		const blockers: BillingBlocker[] = invoiceIds
			.filter((id) => !infos.has(id))
			.map((id) => ({ code: 'invoice_not_found', message: `Factura ${id} no encontrada en el holding`, next_step: null }));
		const match = planMatch(
			{ ...item, movement_ids: ids },
			ids.map((id) => movements.get(id)).filter(Boolean),
			new Map(infoRows.map((row) => [String(row.id), text(row.currency)]))
		);
		const invoiceCurrency = match.invoice_currency ?? text(infoRows[0]?.currency);
		const paymentDate = [...movements.values()].map((movement) => movement.date).sort()[0] ?? today;
		const entries = [
			...item.allocations.map((entry) => ({ invoice_id: entry.invoice_id, amount: entry.amount })),
			...adjustments.map((entry) => ({ invoice_id: entry.invoice_id, amount: entry.amount })),
		];
		let plan: PaymentPlan | null = null;

		blockers.push(...match.blockers);
		if (!blockers.some((blocker) => blocker.code === 'invoice_not_found') && entries.length && invoiceCurrency) {
			try {
				({ plan } = await this.payments.plan(
					db,
					holdingId,
					{ allocations: entries, currency: invoiceCurrency, payment_date: paymentDate },
					today,
					{
						allowMultipleClients: item.allow_multiple_clients === true,
						lock,
					}
				));
				blockers.push(...plan.blockers, ...plan.allocations.flatMap((allocation) => allocation.blockers));
			} catch (error) {
				if (!(error instanceof NotFoundException)) throw error;
				blockers.push({ code: 'invoice_not_found', message: error.message, next_step: null });
			}
		}
		const unique = dedupeBlockers(blockers);
		const invoices = invoiceIds
			.filter((id) => infos.has(id))
			.map((id) => {
				const info = infos.get(id);
				const steps = plan?.allocations.filter((allocation) => allocation.invoice_id === id) ?? [];
				const reasons = [...new Set(adjustments.filter((entry) => entry.invoice_id === id).map((entry) => entry.reason))];

				return {
					invoice_id: id,
					invoice_number: text(info.invoice_number),
					client_name: text(info.client_name),
					contract_id: text(info.contract_id),
					cash_amount: round2(item.allocations.filter((entry) => entry.invoice_id === id).reduce((sum, entry) => sum + entry.amount, 0)),
					adjustment_amount: round2(adjustments.filter((entry) => entry.invoice_id === id).reduce((sum, entry) => sum + entry.amount, 0)),
					adjustment_reason: reasons.length ? reasons.join(',') : null,
					before: steps[0]?.before ?? null,
					after: steps.length ? steps[steps.length - 1].after : null,
				};
			});

		return {
			match,
			movements,
			invoiceCurrency,
			result: {
				key: item.key ?? ids.join('+'),
				ok: unique.length === 0,
				movement_ids: ids,
				currency: match.currency,
				invoice_currency: invoiceCurrency,
				fx_rate: match.fx_rate,
				movements: match.movements,
				invoices,
				blockers: unique,
				warnings: plan?.warnings ?? [],
			},
		};
	}

	/** Escribe un ítem ya validado dentro de su transacción: efectivo por movimiento, ajustes por motivo y estado de los movimientos. */
	private async applyItem(
		runner: QueryRunner,
		holdingId: string,
		item: MatchItemDto,
		evaluation: Evaluation,
		authId: string,
		userId: string,
		now: Date
	) {
		const { match, movements, invoiceCurrency } = evaluation;
		const paymentIds: string[] = [];
		const eventIds: string[] = [];
		const allowMultipleClients = item.allow_multiple_clients === true;
		const notesOf = (movement: { bank_name: string | null; bank_account: string | null }) =>
			`Conciliado desde cartola ${movement.bank_name ?? ''} ${movement.bank_account ?? ''}`.replace(/\s+/g, ' ').trim();

		for (const entry of match.distribution) {
			const movement = movements.get(entry.movement_id);
			const grouped = new Map<string, { invoice_id: string; amount: number; original_amount: number | null }>();

			for (const allocation of entry.allocations) {
				const current = grouped.get(allocation.invoice_id);

				grouped.set(allocation.invoice_id, {
					invoice_id: allocation.invoice_id,
					amount: round2((current?.amount ?? 0) + allocation.amount),
					original_amount:
						allocation.original_amount === null ? null : round2((current?.original_amount ?? 0) + allocation.original_amount),
				});
			}
			const list = [...grouped.values()];
			const crossCurrency = match.fx_rate !== null;
			const response = await this.payments.register(
				holdingId,
				{
					allocations: list.map(({ invoice_id, amount }) => ({ invoice_id, amount })),
					currency: invoiceCurrency,
					payment_date: movement.date,
					method: 'transfer',
					reference: (movement.description ?? '').slice(0, 200) || undefined,
					notes: notesOf(movement),
				},
				authId,
				now,
				{
					runner,
					bankMovementId: movement.id,
					originalAmounts: crossCurrency ? Object.fromEntries(list.map((entry) => [entry.invoice_id, entry.original_amount])) : undefined,
					fxRate: crossCurrency ? match.fx_rate : undefined,
					originalCurrency: crossCurrency ? movement.currency : undefined,
					allowMultipleClients,
				}
			);

			paymentIds.push(...response.payment_ids);
			eventIds.push(...response.event_ids);
		}
		const first = movements.get(item.movement_ids[0]);
		const byReason = new Map<SettlementReason, NonNullable<MatchItemDto['adjustments']>>();

		for (const adjustment of item.adjustments ?? []) byReason.set(adjustment.reason, [...(byReason.get(adjustment.reason) ?? []), adjustment]);
		for (const [reason, list] of byReason) {
			const notes = [...new Set(list.map((entry) => (entry.note ?? '').trim()).filter(Boolean))].join('; ') || SETTLEMENT_REASON_LABELS[reason];
			const response = await this.payments.register(
				holdingId,
				{
					allocations: list.map(({ invoice_id, amount }) => ({ invoice_id, amount })),
					currency: invoiceCurrency,
					payment_date: first.date,
					method: 'adjustment',
					reference: (first.description ?? '').slice(0, 200) || undefined,
					notes,
				},
				authId,
				now,
				{ runner, bankMovementId: first.id, settlementReason: reason, allowMultipleClients }
			);

			paymentIds.push(...response.payment_ids);
			eventIds.push(...response.event_ids);
		}
		const firstInvoice = item.allocations[0]?.invoice_id ?? item.adjustments?.[0]?.invoice_id ?? null;
		const persisted = persistedOfItem(item.confidence, item.score);

		for (const movement of match.movements) {
			if (movement.state_after === 'reconciled') {
				await runner.query(
					`UPDATE bank_movements SET status = '${MOVEMENT_STATUS.reconciled}', reconciled_invoice_id = $3, reconciled_at = now(), reconciled_by = $4,
						match_confidence = COALESCE($5, match_confidence), match_score = COALESCE($6::numeric, match_score)
					WHERE id = $1 AND holding_id = $2`,
					[movement.id, holdingId, firstInvoice, authId, persisted.confidence, persisted.score]
				);
			} else {
				await runner.query(
					`UPDATE bank_movements SET reconciled_invoice_id = COALESCE(reconciled_invoice_id, $3) WHERE id = $1 AND holding_id = $2`,
					[movement.id, holdingId, firstInvoice]
				);
			}
		}

		return { result: evaluation.result, payment_ids: paymentIds, event_ids: eventIds };
	}

	private blocked(blockers: BillingBlocker[], preview?: unknown): ConflictException {
		return new ConflictException({
			message: `No se puede aplicar: ${blockers.map((blocker) => blocker.message).join('; ')}`,
			code: 'blocked',
			blockers,
			...(preview === undefined ? {} : { preview }),
		});
	}
}

// ---------------------------------------------------------------- tipos y helpers del servicio

interface EvaluatedMovement {
	id: string;
	amount: number;
	currency: string;
	status: string | null;
	applied: number;
	date: string;
	description: string | null;
	bank_name: string | null;
	bank_account: string | null;
}

export interface ItemResult {
	key: string;
	ok: boolean;
	movement_ids: string[];
	currency: string | null;
	invoice_currency: string | null;
	fx_rate: number | null;
	movements: MatchPlan['movements'];
	invoices: Array<{
		invoice_id: string;
		invoice_number: string | null;
		client_name: string | null;
		contract_id: string | null;
		cash_amount: number;
		adjustment_amount: number;
		adjustment_reason: string | null;
		before: unknown;
		after: unknown;
	}>;
	blockers: BillingBlocker[];
	warnings: BillingBlocker[];
}

interface Evaluation {
	match: MatchPlan;
	movements: Map<string, EvaluatedMovement>;
	invoiceCurrency: string | null;
	result: ItemResult;
}

const dedupeBlockers = (blockers: BillingBlocker[]) => {
	const seen = new Set<string>();

	return blockers.filter((blocker) => {
		const key = `${blocker.code}|${blocker.message}`;

		if (seen.has(key)) return false;
		seen.add(key);

		return true;
	});
};

/** exact → `high` + 100; high → `high` + score (< 100); medium → `medium` + score; sin confianza → no toca las columnas. */
export function persistedOfItem(
	confidence: MatchConfidence | undefined,
	score: number | undefined
): { confidence: string | null; score: number | null } {
	if (!confidence) return { confidence: null, score: null };
	if (confidence === 'exact') return { confidence: 'high', score: 100 };

	return { confidence: confidence === 'medium' ? 'medium' : 'high', score: score === undefined || score === null ? null : Math.min(score, 99) };
}

function failureOf(item: MatchItemDto, evaluated: ItemResult | null, error: unknown) {
	const response = error instanceof HttpException ? (error.getResponse() as Record<string, unknown>) : null;
	const blockers = Array.isArray(response?.blockers)
		? (response.blockers as BillingBlocker[])
		: [{ code: 'apply_failed', message: error instanceof Error ? error.message : 'Error al aplicar', next_step: null }];
	const ids = [...new Set(item.movement_ids)];
	const base: ItemResult = evaluated ?? {
		key: item.key ?? ids.join('+'),
		ok: false,
		movement_ids: ids,
		currency: null,
		invoice_currency: null,
		fx_rate: null,
		movements: [],
		invoices: [],
		blockers: [],
		warnings: [],
	};

	return {
		...base,
		ok: false,
		blockers: dedupeBlockers(blockers),
		applied: false,
		payment_ids: [] as string[],
		event_ids: [] as string[],
		error: error instanceof Error ? error.message : String(error),
	};
}

function summaryOf(items: ItemResult[]) {
	const byCurrency = new Map<string, { currency: string; cash: number; adjustments: number; items: number }>();

	for (const item of items) {
		if (!item.ok) continue;
		const currency = item.invoice_currency ?? '—';
		const entry = byCurrency.get(currency) ?? { currency, cash: 0, adjustments: 0, items: 0 };

		entry.cash = round2(entry.cash + item.invoices.reduce((sum, invoice) => sum + invoice.cash_amount, 0));
		entry.adjustments = round2(entry.adjustments + item.invoices.reduce((sum, invoice) => sum + invoice.adjustment_amount, 0));
		entry.items += 1;
		byCurrency.set(currency, entry);
	}

	return {
		ok: items.filter((item) => item.ok).length,
		blocked: items.filter((item) => !item.ok).length,
		by_currency: [...byCurrency.values()].sort((a, b) => a.currency.localeCompare(b.currency)),
	};
}

const lineOf = (line: StatementLine, known: Map<string, string>) => {
	const duplicateOf = line.fingerprint ? (known.get(line.fingerprint) ?? null) : null;

	return {
		row: line.row,
		date: line.date,
		description: line.description,
		amount: line.amount,
		currency: line.currency,
		reference: line.reference,
		counterparty_tax_id: line.counterparty_tax_id,
		counterparty_name: line.counterparty_name,
		fingerprint: line.fingerprint,
		kind: (line.amount !== null && line.amount > 0 ? 'credit' : 'debit') as 'credit' | 'debit',
		status: (line.errors.length ? 'error' : duplicateOf ? 'duplicate' : 'new') as 'new' | 'duplicate' | 'error',
		duplicate_of: duplicateOf,
		errors: line.errors,
	};
};

const templateOf = (row: Row) => ({
	id: String(row.id),
	bank_name: text(row.bank_name),
	mapping_name: text(row.mapping_name),
	column_mapping: json(row.column_mapping),
	is_default: row.is_default === true,
	created_at: iso(row.created_at),
});
