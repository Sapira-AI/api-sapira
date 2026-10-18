import { randomUUID } from 'crypto';

import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { loadHoldingPreferences } from '@/core/utils/holding-preferences';
import { validationException } from '@/core/utils/validation-errors';
import { withApiWriter } from '@/modules/contracts/api-writer';
import { ContractDraftsService } from '@/modules/contracts/contract-drafts.service';
import type { CreateContractDto } from '@/modules/contracts/dtos/create-contract.dto';
import { currentMonth, type Month } from '@/modules/metrics/metrics-period';
import { LEGACY_FIRST_RSM_JOIN, legacyCountedConditions, legacyFirstRsmCte, legacySkipCodeSql } from '@/modules/metrics/mrr-historico';
import { legacyFxKey, legacySystemAmount, loadLegacySystemFx } from '@/modules/metrics/mrr-historico-fx';

import {
	conflict,
	decodeLineKey,
	encodeLineKey,
	eventDto,
	firstDay,
	HISTORY_ITEM_CATEGORY,
	insertOnboardingEvent,
	isoDate,
	type LineKeyParts,
	nextMonthStart,
	num,
	numOrNull,
	omitKey,
	type OnboardingActor,
	paginated,
	parseRawLineKey,
	type Queryable,
	queryEvents,
	rawLineKey,
	round2,
	round6,
	type Row,
	str,
} from './onboarding-common';
import {
	diffEntries,
	entryTotals,
	generatedRows,
	invoiceRegistration,
	isRemovedRow,
	type LineEditRow,
	lineInvoiceAmount,
} from './onboarding-line-edit';
import { candidateScore, LINE_JOINS, lineCtes, lineDto, lineSelect, type Splice, spliceOf, STATUS_PRIORITY_SQL } from './onboarding-lines';
import { OnboardingRegisterService, type RegisterPlan, type ReplaceOptions } from './onboarding-register.service';

import type {
	CloseHistoryLineDto,
	EditHistoryLineDto,
	HistoryLinesQueryDto,
	LinkHistoryLineDto,
	OnboardingContractDto,
	RemoveHistoryLineDto,
} from './dtos/onboarding.dto';
import type { QueryRunner } from 'typeorm';

const ACTIVE = 'Activo';
const SORT_COLUMNS: Record<string, string> = {
	client: 'cl.name_commercial',
	product: 'st.product_name',
	last_month: 'st.last_date',
	mrr: 'st.mrr_last_system',
	status: STATUS_PRIORITY_SQL,
};

/** Textos de los avisos y errores del motor de Registrar histórico en "Editar línea" (sin marcas). */
const REGISTER_WARNING_MESSAGES: Record<string, string> = {
	sum_mismatch: 'La suma de los productos no cuadra con el monto (±1 %)',
	fx_one_with_different_currencies: 'Monedas distintas con tipo de cambio cercano a 1: revisa el monto en moneda de contrato',
	fx_outlier: 'El tipo de cambio implícito se aleja del habitual del holding para ese par de monedas',
	no_client: 'La factura no tiene cliente comercial',
};
const REGISTER_ERROR_MESSAGES: Record<string, string> = {
	not_found: 'La factura no existe',
	invoice_without_items: 'La factura no tiene líneas',
	invalid_period: 'Período inválido (hasta antes de desde o más de 36 meses)',
	invalid_amount: 'El monto en moneda de contrato no es válido',
	product_not_found: 'Un producto no está en el catálogo',
	duplicate_product: 'Un producto está repetido',
	currency_not_enabled: 'La moneda no está habilitada',
	no_client: 'La factura no tiene cliente comercial',
	already_registered: 'La factura ya tiene MRR histórico',
	sum_mismatch: 'La suma de los productos no cuadra con el monto (±1 %)',
};

/** Lo que conserva una fila reemplazada (empalme y cierre o quita). */
interface EditCarry {
	migrated_at: unknown;
	migrated_by: string | null;
	skip_reason: string | null;
	skip_at: unknown;
	skip_by: string | null;
}

/** Contexto de una edición de línea. */
interface LineEditContext {
	rows: Array<LineEditRow & EditCarry>;
	replaced: Array<LineEditRow & EditCarry>;
	remaining: Array<LineEditRow & EditCarry>;
	plans: RegisterPlan[];
	generated: LineEditRow[];
	replace: ReplaceOptions;
	/** Una factura con meses empalmados cambia de producto o moneda. */
	linkedRekey: boolean;
	/** Clave cruda de destino si toda la línea se mueve a otra. */
	rekeyTo: string | null;
	/** Claves crudas tocadas (la propia y las de destino). */
	linesTouched: string[];
}

/** Fila de una línea leída para escribir (con su motivo efectivo). */
interface LineRow {
	id: string;
	period: Month;
	contract_id: string | null;
	skip: boolean;
	skip_code: string | null;
	invoice_id: string | null;
}

const pendingRows = (rows: LineRow[]) => rows.filter((row) => !row.contract_id && !row.skip);

/**
 * Bandeja de MRR histórico (§3.1, §4.2, §5): lista y detalle de líneas, editar línea (volver a registrar sus facturas), empalmar/desvincular, cerrar (fue baja),
 * quitar (duplicado o error), reabrir y crear el contrato desde la línea con el generador común de Contratos. Toda escritura va en
 * una transacción con la marca `sapira.writer` (`withApiWriter`) y deja su evento en `onboarding_events`; ninguna dispara
 * notificaciones, correos ni sincronizaciones. `link` y `contract` recalculan el devengo del contrato si ya está Activo (un borrador no
 * tiene devengo: se arma al activarse).
 */
@Injectable()
export class OnboardingHistoryService {
	constructor(
		private readonly dataSource: DataSource,
		private readonly contractDrafts: ContractDraftsService,
		private readonly register: OnboardingRegisterService
	) {}

	/** Primer día del mes en curso en la zona del holding. */
	async todayStart(holdingId: string, now = new Date()): Promise<string> {
		const { timezone } = await loadHoldingPreferences(this.dataSource, holdingId);

		return firstDay(currentMonth(now, timezone));
	}

	// ---------------------------------------------------------------- lecturas

	async list(holdingId: string, query: HistoryLinesQueryDto, now = new Date()) {
		const page = query.page ?? 1;
		const limit = query.limit ?? 25;
		const params: unknown[] = [holdingId, await this.todayStart(holdingId, now)];
		const add = (value: unknown) => `$${params.push(value)}`;
		const rowWhere: string[] = [];

		if (query.clientId) rowWhere.push(`m.client_id = ${add(query.clientId)}`);
		if (query.product) rowWhere.push(`m.product_name = ${add(query.product)}`);
		const where: string[] = [];
		const statuses = (query.status ?? '')
			.split(',')
			.map((part) => part.trim())
			.filter(Boolean);

		if (statuses.length) where.push(`st.status = ANY(${add(statuses)}::text[])`);
		// "Terminó sin resolver" (Domi 14-10): filtro sobre las pendientes, no un estado aparte.
		if (query.ended === 'true') where.push(`st.status = 'pending' AND st.ended`);
		if (query.ended === 'false') where.push(`st.status = 'pending' AND NOT st.ended`);
		if (query.batchId) where.push(`${add(query.batchId)}::uuid = ANY(st.batch_ids)`);
		if (query.search) {
			const term = add(`%${query.search}%`);

			where.push(`(cl.name_commercial ILIKE ${term} OR st.product_name ILIKE ${term} OR array_to_string(st.legal_names, ' ') ILIKE ${term})`);
		}
		// Sin `sortBy`: prioridad de estado (pendiente → empalmada → cerrada → quitada) y luego cliente (Domi 14-10).
		const order = query.sortBy ? (SORT_COLUMNS[query.sortBy] ?? SORT_COLUMNS.client) : STATUS_PRIORITY_SQL;
		const direction = query.sortOrder === 'desc' ? 'DESC' : 'ASC';
		const rows = (await this.dataSource.query(
			`${lineCtes({ holding: '$1', today: '$2', rowWhere })}
			SELECT ${lineSelect('$1')}, COUNT(*) OVER () AS total_count
			FROM st ${LINE_JOINS}
			${where.length ? `WHERE ${where.join(' AND ')}` : ''}
			ORDER BY ${order} ${direction} NULLS LAST, cl.name_commercial, st.product_name, st.contract_currency
			LIMIT ${Number(limit)} OFFSET ${Number((page - 1) * limit)}`,
			params
		)) as Row[];

		return paginated(rows.map(lineDto), num(rows[0]?.total_count), page, limit);
	}

	/** Línea por clave (404 si no tiene filas en el holding). */
	async line(holdingId: string, key: string, now = new Date()) {
		return lineDto(await this.lineRow(this.dataSource, holdingId, decodeLineKey(key), now));
	}

	private async lineRow(db: Queryable, holdingId: string, parts: LineKeyParts, now = new Date()): Promise<Row> {
		const [row] = (await db.query(
			`${lineCtes({ holding: '$1', today: '$2', rowWhere: ['m.client_id = $3', 'm.product_name = $4', 'm.contract_currency = $5'] })}
			SELECT ${lineSelect('$1')} FROM st ${LINE_JOINS}`,
			[holdingId, await this.todayStart(holdingId, now), parts.client_id, parts.product_name, parts.contract_currency]
		)) as Row[];

		if (!row) throw new NotFoundException('Línea de MRR histórico no encontrada');

		return row;
	}

	async detail(holdingId: string, key: string, now = new Date()) {
		const parts = decodeLineKey(key);
		const row = await this.lineRow(this.dataSource, holdingId, parts, now);
		const line = lineDto(row);
		const keyParams = [holdingId, parts.client_id, parts.product_name, parts.contract_currency];
		const [months, invoices, candidates, events] = await Promise.all([
			this.dataSource.query(
				`WITH ${legacyFirstRsmCte('$1')}
				SELECT m.id, to_char(m.period_month, 'YYYY-MM') AS period_month, m.subtotal_contract_currency, m.mrr_legacy,
					m.mrr_legacy_system_currency, m.term, m.is_recurring, m.invoice_number, m.invoice_legacy_id, m.migrated_to_contract_id,
					m.invoice_currency, m.allocated_invoice_currency, m.fx_contract_to_invoice, m.fx_contract_to_system,
					m.skip_activation, ${legacySkipCodeSql('m')} AS skip_code,
					(${legacyCountedConditions().join(' AND ')}) AS counted
				FROM mrr_legacy m ${LEGACY_FIRST_RSM_JOIN}
				WHERE m.holding_id = $1 AND m.client_id = $2 AND m.product_name = $3 AND m.contract_currency = $4
				ORDER BY m.period_month, m.invoice_number, m.id`,
				keyParams
			) as Promise<Row[]>,
			this.dataSource.query(
				`SELECT il.id, il.invoice_number, il.issue_date, il.invoice_currency, il.total_invoice_currency, il.status, il.contract_id
				FROM invoices_legacy il
				WHERE il.holding_id = $1 AND il.id IN (
					SELECT m.invoice_legacy_id FROM mrr_legacy m
					WHERE m.holding_id = $1 AND m.client_id = $2 AND m.product_name = $3 AND m.contract_currency = $4)
				ORDER BY il.issue_date, il.invoice_number`,
				keyParams
			) as Promise<Row[]>,
			this.candidateRows(holdingId, parts.client_id),
			queryEvents(
				this.dataSource,
				`SELECT e.*, u.name AS actor_name FROM onboarding_events e LEFT JOIN users u ON u.id = e.actor_id
				WHERE e.holding_id = $1 AND e.line_key = $2 ORDER BY e.created_at DESC LIMIT 50`,
				[holdingId, rawLineKey(parts)]
			),
		]);
		const monthDtos = months.map((month) => ({
			id: String(month.id),
			period_month: String(month.period_month),
			subtotal_contract_currency: num(month.subtotal_contract_currency),
			mrr_legacy: numOrNull(month.mrr_legacy),
			mrr_legacy_system_currency: numOrNull(month.mrr_legacy_system_currency),
			term: num(month.term),
			is_recurring: month.is_recurring === true,
			invoice_number: str(month.invoice_number),
			invoice_legacy_id: str(month.invoice_legacy_id),
			// Tipo de cambio visible (Domi 14-10): monto asignado en moneda de factura (misma base que el subtotal: todo el plazo).
			invoice_currency: str(month.invoice_currency),
			amount_invoice_currency: numOrNull(month.allocated_invoice_currency),
			fx_contract_to_invoice: numOrNull(month.fx_contract_to_invoice),
			fx_contract_to_system: numOrNull(month.fx_contract_to_system),
			counted: month.counted === true,
			state: month.migrated_to_contract_id
				? 'linked'
				: month.skip_activation
					? month.skip_code === 'churn'
						? 'closed'
						: 'removed'
					: 'pending',
			contract_id: str(month.migrated_to_contract_id),
		}));
		const contractFirst = line.contract ? await this.contractFirstMonth(this.dataSource, line.contract.id) : null;
		const splice = spliceOf(
			str(row.live_last_month),
			contractFirst,
			monthDtos.filter((month) => month.contract_id === line.contract?.id && month.state !== 'removed').map((month) => month.period_month)
		);

		return {
			...line,
			months: monthDtos,
			invoices: invoices.map((invoice) => {
				const own = months
					.filter((month) => String(month.invoice_legacy_id) === String(invoice.id))
					.map((month) => ({
						period: String(month.period_month),
						subtotal: num(month.subtotal_contract_currency),
						term: num(month.term) || 1,
						is_recurring: month.is_recurring === true,
						skip_code: str(month.skip_code),
					}));
				const registration = invoiceRegistration(own);

				return {
					id: String(invoice.id),
					invoice_number: str(invoice.invoice_number),
					issue_date: isoDate(invoice.issue_date),
					currency: str(invoice.invoice_currency),
					total: num(invoice.total_invoice_currency),
					status: str(invoice.status),
					contract_id: str(invoice.contract_id),
					// Registro actual de la factura en esta línea, para prellenar "Editar línea" (Domi 14-10).
					registration: {
						...registration,
						contract_currency: line.currency,
						products: [
							{
								product_id: line.product_id,
								product_name: line.product_name,
								amount_contract_currency: registration.amount_contract_currency,
							},
						],
					},
				};
			}),
			splice,
			candidates: candidates
				.map((candidate) => ({
					...candidate,
					score: candidateScore(
						{ product_name: line.product_name, currency: line.currency, last_month: str(row.live_last_month) },
						{ products: candidate.products, currency: candidate.currency, first_month: candidate.start_date?.slice(0, 7) ?? null }
					),
				}))
				.sort((a, b) => b.score - a.score || String(b.start_date).localeCompare(String(a.start_date)))
				.slice(0, 10),
			events: events.map(eventDto),
		};
	}

	/** Contratos del mismo cliente comercial (no borrados ni cancelados) para empalmar. */
	private async candidateRows(holdingId: string, clientId: string) {
		const rows = (await this.dataSource.query(
			`SELECT c.id, c.contract_number, c.status, c.contract_currency, c.contract_end_date,
				(SELECT MIN(ci.start_date) FROM contract_items ci WHERE ci.contract_id = c.id) AS start_date,
				COALESCE((SELECT array_agg(DISTINCT ci.product_name) FROM contract_items ci WHERE ci.contract_id = c.id AND ci.product_name IS NOT NULL), '{}') AS products
			FROM contracts c
			WHERE c.holding_id = $1 AND c.client_id = $2 AND c.deleted_at IS NULL AND c.status <> 'Cancelado'`,
			[holdingId, clientId]
		)) as Row[];

		return rows.map((row) => ({
			id: String(row.id),
			contract_number: str(row.contract_number),
			status: str(row.status),
			products: Array.isArray(row.products) ? row.products.map(String) : [],
			currency: str(row.contract_currency),
			start_date: isoDate(row.start_date),
			end_date: isoDate(row.contract_end_date),
		}));
	}

	/** Primer mes con MRR del contrato en el devengo (corte U14); sin devengo (borrador), el mes del primer inicio recurrente. */
	private async contractFirstMonth(db: Queryable, contractId: string): Promise<Month | null> {
		const [row] = (await db.query(
			`SELECT COALESCE(
				(SELECT to_char(MIN(r.period_month), 'YYYY-MM') FROM revenue_schedule_monthly r
					WHERE r.contract_id = $1 AND r.mrr_period_contracted_contract_ccy > 0),
				(SELECT to_char(MIN(ci.start_date), 'YYYY-MM') FROM contract_items ci WHERE ci.contract_id = $1 AND COALESCE(ci.is_recurring, true))
			) AS first_month`,
			[contractId]
		)) as Row[];

		return str(row?.first_month);
	}

	// ---------------------------------------------------------------- escrituras

	/** Filas de la línea con lock (404 si no existe). */
	private async lockLine(runner: Queryable, holdingId: string, parts: LineKeyParts, lock = true): Promise<LineRow[]> {
		const rows = (await runner.query(
			`SELECT m.id, to_char(m.period_month, 'YYYY-MM') AS period, m.migrated_to_contract_id, m.skip_activation, m.invoice_legacy_id,
				${legacySkipCodeSql('m')} AS skip_code
			FROM mrr_legacy m
			WHERE m.holding_id = $1 AND m.client_id = $2 AND m.product_name = $3 AND m.contract_currency = $4
			ORDER BY m.period_month${lock ? '\n\t\t\tFOR UPDATE' : ''}`,
			[holdingId, parts.client_id, parts.product_name, parts.contract_currency]
		)) as Row[];

		if (!rows.length) throw new NotFoundException('Línea de MRR histórico no encontrada');

		return rows.map((row) => ({
			id: String(row.id),
			period: String(row.period),
			contract_id: str(row.migrated_to_contract_id),
			skip: row.skip_activation === true,
			skip_code: str(row.skip_code),
			invoice_id: str(row.invoice_legacy_id),
		}));
	}

	// ---------------------------------------------------------------- editar línea = volver a registrar sus facturas (Domi 14-10)

	/** Filas de una línea con lo que necesita la edición (vacío si la línea no tiene filas). */
	private async editRows(db: Queryable, holdingId: string, parts: LineKeyParts, lock: boolean): Promise<Array<LineEditRow & EditCarry>> {
		const rows = (await db.query(
			`SELECT m.id, m.invoice_legacy_id, m.invoice_number, to_char(m.period_month, 'YYYY-MM') AS period, m.subtotal_contract_currency, m.term,
				m.is_recurring, m.mrr_legacy, m.mrr_legacy_system_currency, m.fx_contract_to_system, m.allocated_invoice_currency,
				m.fx_contract_to_invoice, m.invoice_currency, m.migrated_to_contract_id, m.migrated_at, m.migrated_by, m.skip_activation_reason,
				m.skip_activation_at, m.skip_activation_by, ${legacySkipCodeSql('m')} AS skip_code
			FROM mrr_legacy m
			WHERE m.holding_id = $1 AND m.client_id = $2 AND m.product_name = $3 AND m.contract_currency = $4
			ORDER BY m.period_month, m.created_at, m.id${lock ? '\n\t\t\tFOR UPDATE' : ''}`,
			[holdingId, parts.client_id, parts.product_name, parts.contract_currency]
		)) as Row[];
		const lineKey = rawLineKey(parts);

		return rows.map((row) => ({
			id: String(row.id),
			invoice_id: String(row.invoice_legacy_id),
			invoice_number: str(row.invoice_number),
			period: String(row.period),
			subtotal: num(row.subtotal_contract_currency),
			term: num(row.term) || 1,
			is_recurring: row.is_recurring === true,
			mrr: numOrNull(row.mrr_legacy),
			mrr_system: numOrNull(row.mrr_legacy_system_currency),
			fx_system: numOrNull(row.fx_contract_to_system),
			allocated: num(row.allocated_invoice_currency),
			fx_invoice: num(row.fx_contract_to_invoice),
			invoice_currency: str(row.invoice_currency),
			contract_id: str(row.migrated_to_contract_id),
			skip_code: str(row.skip_code),
			line_key: lineKey,
			migrated_at: row.migrated_at ?? null,
			migrated_by: str(row.migrated_by),
			skip_reason: str(row.skip_activation_reason),
			skip_at: row.skip_activation_at ?? null,
			skip_by: str(row.skip_activation_by),
		}));
	}

	/**
	 * Valida el body y arma la edición: filas que se reemplazan (las de cada factura listada en esta línea), plan del motor de Registrar
	 * histórico en modo `replace` (cliente de la línea, sin `already_registered`, sin contar como cubiertos los meses que se reemplazan, tipo
	 * de cambio desde el monto en moneda de factura que la línea tenía asignado) y las filas que se generarían. 400 si una factura no es de la
	 * línea, está repetida o el motor la rechaza.
	 */
	private async editContext(
		db: Queryable,
		holdingId: string,
		parts: LineKeyParts,
		dto: EditHistoryLineDto,
		lock: boolean
	): Promise<LineEditContext> {
		const rows = await this.editRows(db, holdingId, parts, lock);

		if (!rows.length) throw new NotFoundException('Línea de MRR histórico no encontrada');
		const lineInvoices = new Set(rows.map((row) => row.invoice_id));
		const errors: Array<{ field: string; message: string }> = [];
		const seen = new Set<string>();

		dto.invoices.forEach((input, index) => {
			if (seen.has(input.invoice_id)) errors.push({ field: `invoices.${index}.invoice_id`, message: 'La factura está repetida' });
			else if (!lineInvoices.has(input.invoice_id))
				errors.push({ field: `invoices.${index}.invoice_id`, message: 'La factura no es de esta línea' });
			seen.add(input.invoice_id);
		});
		if (errors.length) throw validationException(errors);
		const replaced = rows.filter((row) => seen.has(row.invoice_id));
		const invoiceAmounts = new Map<string, number>();

		for (const invoiceId of seen) {
			const amount = lineInvoiceAmount(replaced.filter((row) => row.invoice_id === invoiceId));

			if (amount !== 0) invoiceAmounts.set(invoiceId, amount);
		}
		const replace = { clientId: parts.client_id, excludeRowIds: replaced.map((row) => row.id!), invoiceAmounts };
		const plans = await this.register.plan(db, holdingId, dto.invoices, lock, replace);

		plans.forEach((plan, index) => {
			const error = plan.errors[0];

			if (error) errors.push({ field: `invoices.${index}`, message: REGISTER_ERROR_MESSAGES[error] ?? error });
		});
		if (errors.length) throw validationException(errors);
		const keyOf = (productName: string, currency: string) =>
			rawLineKey({ client_id: parts.client_id, product_name: productName, contract_currency: currency });
		const generated = plans.flatMap((plan) => generatedRows(plan, (name) => keyOf(name, plan.input.contract_currency)));
		const ownKey = rawLineKey(parts);
		// Empalmadas: período y montos sí; producto o moneda distintos (las filas caerían en otra línea) no.
		const linkedRekey = plans.some(
			(plan) =>
				replaced.some((row) => row.invoice_id === plan.invoice_id && row.contract_id) &&
				plan.products.some((product) => keyOf(product.product_name ?? '', plan.input.contract_currency) !== ownKey)
		);
		const remaining = rows.filter((row) => !seen.has(row.invoice_id));
		const targets = [...new Set(generated.map((row) => row.line_key))];
		const rekeyTo = !remaining.length && targets.length === 1 && targets[0] !== ownKey ? targets[0] : null;

		return {
			rows,
			replaced,
			remaining,
			plans,
			generated,
			replace,
			linkedRekey,
			rekeyTo,
			linesTouched: [...new Set([ownKey, ...targets])],
		};
	}

	/**
	 * Vista previa de "Editar línea": la línea resultante (la de destino si toda la línea se mueve) por factura × mes (`kept | changed |
	 * added | removed`) con MRR en moneda de contrato y de sistema (la de sistema de lo nuevo con la regla del trigger del MRR histórico,
	 * `loadLegacySystemFx`; lo existente, lo guardado), tipo de cambio a factura, avisos del motor de Registrar histórico, `rekey` y
	 * `lines_touched`. No escribe.
	 */
	async editPreview(holdingId: string, key: string, dto: EditHistoryLineDto) {
		const parts = decodeLineKey(key);
		const ctx = await this.editContext(this.dataSource, holdingId, parts, dto, false);
		const resultKey = ctx.rekeyTo ?? rawLineKey(parts);
		const resultParts = parseRawLineKey(resultKey)!;
		const live = (rows: LineEditRow[]) => rows.filter((row) => !isRemovedRow(row));
		const targetRows = ctx.rekeyTo ? await this.editRows(this.dataSource, holdingId, resultParts, false) : [];
		const before = live([...ctx.rows, ...targetRows]);
		const after = live([...(ctx.rekeyTo ? targetRows : ctx.remaining), ...ctx.generated.filter((row) => row.line_key === resultKey)]);
		const [fx, product] = await Promise.all([
			loadLegacySystemFx(
				this.dataSource,
				holdingId,
				after.filter((row) => row.generated).map((row) => ({ currency: resultParts.contract_currency, month: row.period }))
			),
			this.dataSource.query(
				`SELECT id FROM products WHERE holding_id = $1 AND lower(btrim(name)) = lower(btrim($2)) ORDER BY created_at LIMIT 1`,
				[holdingId, resultParts.product_name]
			) as Promise<Row[]>,
		]);

		for (const row of after.filter((value) => value.generated)) {
			const rate = fx.rates.get(legacyFxKey(resultParts.contract_currency, row.period)) ?? 1;

			row.fx_system = rate;
			row.mrr_system = legacySystemAmount(row.is_recurring ? row.mrr : null, rate);
		}
		const months = diffEntries(before, after).map((entry) => {
			const totals = entryTotals(entry.rows);

			return {
				period_month: entry.period,
				subtotal_contract_currency: totals.subtotal,
				mrr_contract_ccy: totals.mrr,
				mrr_system_ccy: round2(entry.rows.reduce((sum, row) => sum + (row.is_recurring ? (row.mrr_system ?? 0) : 0), 0)),
				fx_contract_to_system: entry.rows.find((row) => row.fx_system !== null)?.fx_system ?? null,
				invoice_id: entry.invoice_id,
				invoice_number: entry.invoice_number,
				invoice_currency: totals.invoice_currency,
				amount_invoice_currency: totals.amount_invoice,
				fx_contract_to_invoice: totals.fx_invoice,
				is_recurring: totals.is_recurring,
				status: entry.status,
			};
		});
		const warnings: Array<{ code: string; invoice_id?: string; period_month?: string; message: string }> = [];

		for (const plan of ctx.plans) {
			for (const code of plan.warnings) {
				if (code === 'month_already_covered') {
					for (const period of [...new Set(plan.products.flatMap((value) => value.covered))].sort()) {
						warnings.push({
							code,
							invoice_id: plan.invoice_id,
							period_month: period,
							message: `${period} ya está cubierto por otra factura de la línea`,
						});
					}
				} else warnings.push({ code, invoice_id: plan.invoice_id, message: REGISTER_WARNING_MESSAGES[code] ?? code });
			}
		}
		if (ctx.linkedRekey) {
			warnings.push({
				code: 'line_linked_rekey_blocked',
				message:
					'Hay meses empalmados con un contrato: solo se cambian período y montos (desvincula la línea para cambiar producto o moneda)',
			});
		}
		const afterPeriods = [...new Set(after.map((row) => row.period))].sort();
		const last = afterPeriods[afterPeriods.length - 1] ?? null;
		const lastRows = after.filter((row) => row.period === last && row.is_recurring);

		return {
			line: {
				key: encodeLineKey(resultParts),
				product_name: resultParts.product_name,
				product_id: str(product[0]?.id),
				currency: resultParts.contract_currency,
				first_month: afterPeriods[0] ?? null,
				last_month: last,
				months_count: afterPeriods.length,
			},
			months,
			totals: {
				mrr_last_contract_ccy: round2(lastRows.reduce((sum, row) => sum + (row.mrr ?? 0), 0)),
				mrr_last_system_ccy: last ? round2(lastRows.reduce((sum, row) => sum + (row.mrr_system ?? 0), 0)) : null,
				system_currency: fx.system_currency,
			},
			warnings,
			rekey: ctx.rekeyTo ? { from: key, to: encodeLineKey(resultParts) } : null,
			lines_touched: ctx.linesTouched.map((raw) => encodeLineKey(parseRawLineKey(raw)!)),
		};
	}

	/**
	 * Aplica "Editar línea" en una transacción con la marca de la API: borra las filas de cada factura listada **en esta línea** y las
	 * vuelve a registrar con el motor de Registrar histórico (`registerInTx` en modo `replace`, un lote por edición). Las filas nuevas
	 * conservan el empalme (`migrated_to_contract_id/_at/_by`) y el cierre o la quita que tenían las reemplazadas; una factura que queda sin
	 * filas vuelve a `reconciliation_status = 'pending'`. Bloquean (400) los errores del motor y la suma de productos que no cuadra; 409
	 * `line_linked_rekey` si una factura con meses empalmados cambia de producto o moneda. Evento `history_line_edited`.
	 */
	async editLine(holdingId: string, key: string, dto: EditHistoryLineDto, actor: OnboardingActor) {
		const parts = decodeLineKey(key);
		const result = await withApiWriter(this.dataSource, async (runner) => {
			const ctx = await this.editContext(runner, holdingId, parts, dto, true);

			if (ctx.linkedRekey) {
				throw conflict('line_linked_rekey', 'Hay meses empalmados con un contrato: solo se pueden cambiar período y montos');
			}
			const mismatch = ctx.plans.map((plan, index) => ({ plan, index })).filter(({ plan }) => plan.warnings.includes('sum_mismatch'));

			if (mismatch.length) {
				throw validationException(
					mismatch.map(({ index }) => ({ field: `invoices.${index}.products`, message: REGISTER_ERROR_MESSAGES.sum_mismatch }))
				);
			}
			const batchId = randomUUID();

			await runner.query(`DELETE FROM mrr_legacy WHERE holding_id = $1 AND id = ANY($2::uuid[])`, [holdingId, ctx.replace.excludeRowIds]);
			const registered = await this.register.registerInTx(runner, holdingId, dto.invoices, actor, { batchId, replace: ctx.replace });

			for (const invoiceId of new Set(ctx.replaced.map((row) => row.invoice_id))) {
				const previous = ctx.replaced.filter((row) => row.invoice_id === invoiceId);
				const linked = previous.find((row) => row.contract_id);

				if (linked) {
					await runner.query(
						`UPDATE mrr_legacy SET migrated_to_contract_id = $4, migrated_at = COALESCE($5::timestamptz, now()), migrated_by = $6
						WHERE holding_id = $1 AND batch_id = $2 AND invoice_legacy_id = $3`,
						[holdingId, batchId, invoiceId, linked.contract_id, linked.migrated_at, linked.migrated_by]
					);
				}
				const codes = new Set(previous.map((row) => row.skip_code));

				if (codes.size === 1 && previous[0].skip_code) {
					await runner.query(
						`UPDATE mrr_legacy SET skip_activation = true, skip_reason_code = $4, skip_activation_reason = $5,
							skip_activation_at = COALESCE($6::timestamptz, now()), skip_activation_by = $7
						WHERE holding_id = $1 AND batch_id = $2 AND invoice_legacy_id = $3`,
						[holdingId, batchId, invoiceId, previous[0].skip_code, previous[0].skip_reason, previous[0].skip_at, previous[0].skip_by]
					);
				}
			}
			await runner.query(
				`UPDATE invoices_legacy il SET reconciliation_status = 'pending'
				WHERE il.holding_id = $1 AND il.id = ANY($2::uuid[]) AND il.reconciliation_status = 'mrr_legacy'
					AND NOT EXISTS (SELECT 1 FROM mrr_legacy m WHERE m.invoice_legacy_id = il.id)`,
				[holdingId, [...new Set(ctx.replaced.map((row) => row.invoice_id))]]
			);
			const summary = (rows: LineEditRow[]) => {
				const periods = [...new Set(rows.filter((row) => !isRemovedRow(row)).map((row) => row.period))].sort();

				return { first_month: periods[0] ?? null, last_month: periods[periods.length - 1] ?? null, months_count: periods.length };
			};

			await insertOnboardingEvent(runner, holdingId, actor.userId, {
				type: 'history_line_edited',
				lineKey: rawLineKey(parts),
				payload: {
					batch_id: batchId,
					invoices: dto.invoices.map((input) => ({
						invoice_id: input.invoice_id,
						period_from: input.period_from,
						period_to: input.period_to,
						contract_currency: input.contract_currency,
						amount_contract_currency: input.amount_contract_currency,
						is_recurring: input.is_recurring !== false,
						products: input.products,
					})),
					before: summary(ctx.rows),
					after: summary([...ctx.remaining, ...ctx.generated.filter((row) => row.line_key === rawLineKey(parts))]),
					rows_removed: ctx.replaced.length,
					rows_created: registered.created_rows,
					lines_touched: ctx.linesTouched,
					rekey: ctx.rekeyTo ? { from: rawLineKey(parts), to: ctx.rekeyTo } : null,
				},
			});

			return ctx;
		});
		const newKey = encodeLineKey(parseRawLineKey(result.rekeyTo ?? rawLineKey(parts))!);
		const line = await this.line(holdingId, newKey).catch((error) => {
			if (error instanceof NotFoundException) return null;
			throw error;
		});

		return { line, key: newKey, lines_touched: result.linesTouched.map((raw) => encodeLineKey(parseRawLineKey(raw)!)) };
	}

	/** Empalma los meses pendientes con un contrato del mismo cliente comercial (otra moneda permitida, S8-1). */
	async link(holdingId: string, key: string, dto: LinkHistoryLineDto, actor: OnboardingActor) {
		const parts = decodeLineKey(key);
		const splice = await withApiWriter(this.dataSource, async (runner) => this.linkInTx(runner, holdingId, parts, dto.contract_id, actor));

		return { line: await this.line(holdingId, key), splice };
	}

	private async linkInTx(runner: QueryRunner, holdingId: string, parts: LineKeyParts, contractId: string, actor: OnboardingActor): Promise<Splice> {
		const rows = await this.lockLine(runner, holdingId, parts);
		const [contract] = (await runner.query(
			`SELECT id, contract_number, status, client_id FROM contracts WHERE id = $1 AND holding_id = $2 AND deleted_at IS NULL`,
			[contractId, holdingId]
		)) as Row[];

		if (!contract) throw new NotFoundException('Contrato no encontrado');
		if (String(contract.client_id) !== parts.client_id) {
			throw conflict('contract_other_client', 'El contrato es de otro cliente comercial: solo se empalma con un contrato del mismo cliente');
		}
		const pending = pendingRows(rows);

		if (!pending.length) throw conflict('line_not_pending', 'La línea no tiene meses pendientes de empalmar');
		await runner.query(
			`UPDATE mrr_legacy SET migrated_to_contract_id = $1, migrated_at = now(), migrated_by = $2 WHERE holding_id = $3 AND id = ANY($4::uuid[])`,
			[contractId, actor.userId || null, holdingId, pending.map((row) => row.id)]
		);
		const invoiceIds = [...new Set(pending.map((row) => row.invoice_id).filter(Boolean))];

		if (invoiceIds.length) {
			await runner.query(`UPDATE invoices_legacy SET contract_id = $1 WHERE holding_id = $2 AND id = ANY($3::uuid[]) AND contract_id IS NULL`, [
				contractId,
				holdingId,
				invoiceIds,
			]);
		}
		if (contract.status === ACTIVE) await runner.query(`SELECT revenue_schedule_rebuild($1::uuid, NULL::date)`, [contractId]);
		const live = rows.filter((row) => row.skip_code !== 'duplicate' && row.skip_code !== 'error');
		const lastMonth =
			live
				.map((row) => row.period)
				.sort()
				.pop() ?? null;
		const splice = spliceOf(
			lastMonth,
			await this.contractFirstMonth(runner, contractId),
			live.filter((row) => row.contract_id === contractId || pending.includes(row)).map((row) => row.period)
		);

		await insertOnboardingEvent(runner, holdingId, actor.userId, {
			type: 'history_linked',
			lineKey: rawLineKey(parts),
			entityType: 'contract',
			entityId: contractId,
			payload: { contract_number: str(contract.contract_number), rows: pending.length, splice },
		});

		return splice;
	}

	/** Quita el empalme: las filas vuelven a pendiente y las facturas que solo respaldaban ese empalme se desvinculan. */
	async unlink(holdingId: string, key: string, actor: OnboardingActor) {
		const parts = decodeLineKey(key);

		await withApiWriter(this.dataSource, async (runner) => {
			const rows = await this.lockLine(runner, holdingId, parts);
			const linked = rows.filter((row) => row.contract_id);

			if (!linked.length) throw conflict('line_not_linked', 'La línea no está empalmada con un contrato');
			const contracts = [...new Set(linked.map((row) => row.contract_id))];

			await runner.query(
				`UPDATE mrr_legacy SET migrated_to_contract_id = NULL, migrated_at = NULL, migrated_by = NULL WHERE holding_id = $1 AND id = ANY($2::uuid[])`,
				[holdingId, linked.map((row) => row.id)]
			);
			await runner.query(
				`UPDATE invoices_legacy il SET contract_id = NULL
				WHERE il.holding_id = $1 AND il.id = ANY($2::uuid[]) AND il.contract_id = ANY($3::uuid[])
					AND NOT EXISTS (SELECT 1 FROM mrr_legacy m WHERE m.invoice_legacy_id = il.id AND m.migrated_to_contract_id = il.contract_id)`,
				[holdingId, [...new Set(linked.map((row) => row.invoice_id).filter(Boolean))], contracts]
			);
			await insertOnboardingEvent(runner, holdingId, actor.userId, {
				type: 'history_unlinked',
				lineKey: rawLineKey(parts),
				payload: { contract_ids: contracts, rows: linked.length },
			});
		});

		return this.line(holdingId, key);
	}

	/** Cerrar = fue baja (`churn`): los meses pendientes cuentan hasta su último mes y no esperan contrato. Reversible. */
	async close(holdingId: string, key: string, dto: CloseHistoryLineDto, actor: OnboardingActor) {
		const parts = decodeLineKey(key);

		await withApiWriter(this.dataSource, async (runner) => {
			const pending = pendingRows(await this.lockLine(runner, holdingId, parts));

			if (!pending.length) throw conflict('line_not_pending', 'La línea no tiene meses pendientes para cerrar');
			await this.markSkip(runner, holdingId, pending, 'churn', dto.reason || 'Fue baja', actor);
			await insertOnboardingEvent(runner, holdingId, actor.userId, {
				type: 'history_closed',
				lineKey: rawLineKey(parts),
				payload: { rows: pending.length, reason: dto.reason ?? null },
			});
		});

		return this.line(holdingId, key);
	}

	/** Quitar = duplicado o error de carga: las filas no empalmadas dejan de contar en todo. Reversible; nada se borra. */
	async remove(holdingId: string, key: string, dto: RemoveHistoryLineDto, actor: OnboardingActor) {
		const parts = decodeLineKey(key);

		await withApiWriter(this.dataSource, async (runner) => {
			const target = (await this.lockLine(runner, holdingId, parts)).filter(
				(row) => !row.contract_id && row.skip_code !== 'duplicate' && row.skip_code !== 'error'
			);

			if (!target.length) {
				throw conflict(
					'line_not_removable',
					'La línea no tiene meses sin empalmar para quitar (desvincúlala primero si el empalme es el error)'
				);
			}
			await this.markSkip(
				runner,
				holdingId,
				target,
				dto.reason,
				dto.notes || (dto.reason === 'duplicate' ? 'Duplicado' : 'Error de carga'),
				actor
			);
			await insertOnboardingEvent(runner, holdingId, actor.userId, {
				type: 'history_removed',
				lineKey: rawLineKey(parts),
				payload: { rows: target.length, reason: dto.reason, notes: dto.notes ?? null },
			});
		});

		return this.line(holdingId, key);
	}

	/** Reabrir: las filas cerradas o quitadas (no empalmadas) vuelven a pendiente. */
	async reopen(holdingId: string, key: string, actor: OnboardingActor) {
		const parts = decodeLineKey(key);

		await withApiWriter(this.dataSource, async (runner) => {
			const target = (await this.lockLine(runner, holdingId, parts)).filter((row) => row.skip && !row.contract_id);

			if (!target.length) throw conflict('line_not_closed', 'La línea no tiene meses cerrados ni quitados');
			await runner.query(
				`UPDATE mrr_legacy SET skip_activation = false, skip_reason_code = NULL, skip_activation_reason = NULL, skip_activation_at = NULL,
					skip_activation_by = NULL
				WHERE holding_id = $1 AND id = ANY($2::uuid[])`,
				[holdingId, target.map((row) => row.id)]
			);
			await insertOnboardingEvent(runner, holdingId, actor.userId, {
				type: 'history_reopened',
				lineKey: rawLineKey(parts),
				payload: { rows: target.length, previous: [...new Set(target.map((row) => row.skip_code))] },
			});
		});

		return this.line(holdingId, key);
	}

	private async markSkip(runner: QueryRunner, holdingId: string, rows: LineRow[], code: string, reason: string, actor: OnboardingActor) {
		await runner.query(
			`UPDATE mrr_legacy SET skip_activation = true, skip_reason_code = $3, skip_activation_reason = $4, skip_activation_at = now(),
				skip_activation_by = $5
			WHERE holding_id = $1 AND id = ANY($2::uuid[])`,
			[holdingId, rows.map((row) => row.id), code, reason, actor.userId || null]
		);
	}

	// ---------------------------------------------------------------- contrato desde la línea

	/**
	 * Alta prellenada (§4.2): cliente de la línea, razón social y compañía de su última factura, moneda de la línea y un ítem con la
	 * cantidad y el unitario del último mes, Mensual Anticipado, 12 meses, inicio = mes siguiente al último.
	 */
	async contractDefaults(holdingId: string, key: string, now = new Date()) {
		const parts = decodeLineKey(key);
		const row = await this.lineRow(this.dataSource, holdingId, parts, now);
		const line = lineDto(row);
		const [last] = (await this.dataSource.query(
			`SELECT m.company_id, il.client_entity_id, SUM(m.mrr_legacy) AS mrr, SUM(m.quantity) AS quantity, COUNT(*) AS rows,
				BOOL_AND(m.quantity IS NOT NULL AND m.quantity > 0) AS has_quantity
			FROM mrr_legacy m LEFT JOIN invoices_legacy il ON il.id = m.invoice_legacy_id
			WHERE m.holding_id = $1 AND m.client_id = $2 AND m.product_name = $3 AND m.contract_currency = $4
				AND to_char(m.period_month, 'YYYY-MM') = $5
			GROUP BY m.company_id, il.client_entity_id
			ORDER BY SUM(m.mrr_legacy) DESC NULLS LAST LIMIT 1`,
			[holdingId, parts.client_id, parts.product_name, parts.contract_currency, str(row.live_last_month) ?? line.last_month]
		)) as Row[];
		const [entity] = last?.client_entity_id
			? [{ id: last.client_entity_id }]
			: ((await this.dataSource.query(
					`SELECT ce.id FROM client_entities ce WHERE ce.holding_id = $1 AND ce.client_id = $2 ORDER BY ce.legal_name, ce.id LIMIT 1`,
					[holdingId, parts.client_id]
				)) as Row[]);
		const mrr = num(last?.mrr);
		const quantity = last?.has_quantity && num(last?.rows) === 1 && num(last?.quantity) > 0 ? num(last.quantity) : 1;
		const lastMonth = str(row.live_last_month) ?? line.last_month;
		const warnings: string[] = [];

		if (!line.product_id) warnings.push(`"${line.product_name}" no está en el catálogo: elige el producto antes de crear el contrato`);
		if (!entity) warnings.push('El cliente no tiene razón social: créala antes de crear el contrato');
		if (line.status !== 'pending') warnings.push('La línea no tiene meses pendientes: no quedará empalmada');
		if (mrr <= 0) warnings.push('El último mes no tiene MRR: revisa el unitario');

		return {
			client_id: parts.client_id,
			client_entity_id: str(entity?.id),
			company_id: str(last?.company_id),
			contract_currency: parts.contract_currency,
			items: [
				{
					key: 'history-1',
					product_id: line.product_id,
					product_name: line.product_name,
					item_type: 'Fijo',
					quantity,
					unit_price: round6(Math.max(mrr, 0) / quantity),
					billing_frequency: 'Mensual',
					billing_method: 'Anticipado',
					term_months: 12,
					start_date: lastMonth ? nextMonthStart(lastMonth) : firstDay(currentMonth(now)),
					is_recurring: true,
					category: HISTORY_ITEM_CATEGORY,
				},
			],
			origin: { type: 'history' as const, line_key: key },
			warnings,
		};
	}

	/** Vista previa del generador de Contratos (`POST /contracts/preview`) + el empalme que quedaría. */
	async contractPreview(holdingId: string, key: string, dto: OnboardingContractDto, now = new Date()) {
		const parts = decodeLineKey(key);
		const row = await this.lineRow(this.dataSource, holdingId, parts, now);

		this.assertSameClient(parts, dto);
		const preview = await this.contractDrafts.preview(this.historyContractDto(dto), holdingId);
		const starts = dto.items
			.filter((item) => item.is_recurring !== false)
			.map((item) => item.start_date?.slice(0, 7))
			.filter(Boolean)
			.sort() as Month[];
		const months = (await this.dataSource.query(
			`SELECT DISTINCT to_char(m.period_month, 'YYYY-MM') AS period FROM mrr_legacy m
			WHERE m.holding_id = $1 AND m.client_id = $2 AND m.product_name = $3 AND m.contract_currency = $4
				AND m.migrated_to_contract_id IS NULL AND NOT m.skip_activation`,
			[holdingId, parts.client_id, parts.product_name, parts.contract_currency]
		)) as Row[];

		return {
			...preview,
			splice: spliceOf(
				str(row.live_last_month),
				starts[0] ?? null,
				months.map((month) => String(month.period))
			),
		};
	}

	/**
	 * Crea el contrato En revisión con el generador común (`ContractDraftsService.create`, su propia transacción) y empalma los meses
	 * pendientes en una segunda transacción. Si el empalme falla, el borrador recién creado se elimina (borrado lógico de Contratos)
	 * para no dejar un contrato sin su historia.
	 */
	async createContract(holdingId: string, key: string, dto: OnboardingContractDto, actor: OnboardingActor) {
		const parts = decodeLineKey(key);
		const rows = await this.lockLine(this.dataSource, holdingId, parts, false);

		this.assertSameClient(parts, dto);
		if (!pendingRows(rows).length) throw conflict('line_not_pending', 'La línea no tiene meses pendientes de empalmar');
		const created = (await this.contractDrafts.create(this.historyContractDto(dto), holdingId, actor.authId)) as Row;
		const contractId = String(created.id);

		try {
			await withApiWriter(this.dataSource, async (runner) => {
				const splice = await this.linkInTx(runner, holdingId, parts, contractId, actor);

				await insertOnboardingEvent(runner, holdingId, actor.userId, {
					type: 'history_contract_created',
					lineKey: rawLineKey(parts),
					entityType: 'contract',
					entityId: contractId,
					payload: { contract_number: str(created.contract_number), origin: { type: 'history', line_key: rawLineKey(parts) }, splice },
				});
			});
		} catch (error) {
			await this.contractDrafts.remove(contractId, holdingId, actor.authId).catch(() => undefined);
			throw error;
		}

		return { contract: { id: contractId, contract_number: str(created.contract_number) }, line: await this.line(holdingId, key) };
	}

	/** Body para el generador de Contratos: sin `origin` y con los ítems en RENEWAL salvo categoría explícita (Domi 14-10). */
	private historyContractDto(dto: OnboardingContractDto): CreateContractDto {
		const body = omitKey(dto, 'origin') as CreateContractDto;

		return { ...body, items: body.items.map((item) => ({ ...item, category: item.category ?? HISTORY_ITEM_CATEGORY })) };
	}

	private assertSameClient(parts: LineKeyParts, dto: CreateContractDto) {
		if (dto.client_id !== parts.client_id) {
			throw conflict('contract_other_client', 'El contrato debe ser del mismo cliente comercial que la línea');
		}
	}
}
