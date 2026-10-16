import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { loadHoldingPreferences } from '@/core/utils/holding-preferences';
import { validationException } from '@/core/utils/validation-errors';
import { withApiWriter } from '@/modules/contracts/api-writer';
import { ContractDraftsService } from '@/modules/contracts/contract-drafts.service';
import type { CreateContractDto } from '@/modules/contracts/dtos/create-contract.dto';
import { currentMonth, type Month } from '@/modules/metrics/metrics-period';
import { LEGACY_FIRST_RSM_JOIN, legacyCountedConditions, legacyFirstRsmCte, legacySkipCodeSql } from '@/modules/metrics/mrr-historico';

import {
	conflict,
	decodeLineKey,
	eventDto,
	firstDay,
	insertOnboardingEvent,
	isoDate,
	type LineKeyParts,
	nextMonthStart,
	num,
	numOrNull,
	omitKey,
	type OnboardingActor,
	paginated,
	type Queryable,
	queryEvents,
	rawLineKey,
	round6,
	type Row,
	str,
} from './onboarding-common';
import { candidateScore, LINE_JOINS, lineCtes, lineDto, lineSelect, type Splice, spliceOf } from './onboarding-lines';

import type {
	CloseHistoryLineDto,
	EditHistoryMonthsDto,
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
	status: 'st.status',
};

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
 * Bandeja de MRR histórico (§3.1, §4.2, §5): lista y detalle de líneas, edición de meses, empalmar/desvincular, cerrar (fue baja),
 * quitar (duplicado o error), reabrir y crear el contrato desde la línea con el generador común de Contratos. Toda escritura va en
 * una transacción con la marca `sapira.writer` (`withApiWriter`) y deja su evento en `onboarding_events`; ninguna dispara
 * notificaciones, correos ni sincronizaciones. `link` y `contract` recalculan el devengo del contrato si ya está Activo (un borrador no
 * tiene devengo: se arma al activarse).
 */
@Injectable()
export class OnboardingHistoryService {
	constructor(
		private readonly dataSource: DataSource,
		private readonly contractDrafts: ContractDraftsService
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
		if (query.batchId) where.push(`${add(query.batchId)}::uuid = ANY(st.batch_ids)`);
		if (query.search) {
			const term = add(`%${query.search}%`);

			where.push(`(cl.name_commercial ILIKE ${term} OR st.product_name ILIKE ${term} OR array_to_string(st.legal_names, ' ') ILIKE ${term})`);
		}
		const order = SORT_COLUMNS[query.sortBy ?? 'client'] ?? SORT_COLUMNS.client;
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
			invoices: invoices.map((invoice) => ({
				id: String(invoice.id),
				invoice_number: str(invoice.invoice_number),
				issue_date: isoDate(invoice.issue_date),
				currency: str(invoice.invoice_currency),
				total: num(invoice.total_invoice_currency),
				status: str(invoice.status),
				contract_id: str(invoice.contract_id),
			})),
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

	/** Edición de meses (monto en moneda de contrato y recurrente), con su registro de cambios. */
	async editMonths(holdingId: string, key: string, dto: EditHistoryMonthsDto, actor: OnboardingActor) {
		const parts = decodeLineKey(key);

		await withApiWriter(this.dataSource, async (runner) => {
			const rows = (await runner.query(
				`SELECT m.id, m.subtotal_contract_currency, m.is_recurring, m.term, to_char(m.period_month, 'YYYY-MM') AS period
				FROM mrr_legacy m
				WHERE m.holding_id = $1 AND m.client_id = $2 AND m.product_name = $3 AND m.contract_currency = $4 AND m.id = ANY($5::uuid[])
				FOR UPDATE`,
				[holdingId, parts.client_id, parts.product_name, parts.contract_currency, dto.months.map((month) => month.id)]
			)) as Row[];
			const byId = new Map(rows.map((row) => [String(row.id), row]));
			const missing = dto.months.map((month, index) => ({ month, index })).filter(({ month }) => !byId.has(month.id));

			if (missing.length) {
				throw validationException(missing.map(({ index }) => ({ field: `months.${index}.id`, message: 'El mes no es de esta línea' })));
			}
			const changes: Row[] = [];

			for (const month of dto.months) {
				const current = byId.get(month.id)!;
				const subtotal = month.subtotal_contract_currency ?? num(current.subtotal_contract_currency);
				const recurring = month.is_recurring ?? current.is_recurring === true;

				if (subtotal === num(current.subtotal_contract_currency) && recurring === (current.is_recurring === true)) continue;
				// `mrr_legacy` y `momentum` explícitos (regla de la API). Nombrar `mrr_legacy` en el SET hace que el trigger
				// `calculate_mrr_legacy_system_currency` (no lee la marca) recalcule el monto en moneda de sistema con la política del holding.
				await runner.query(
					`UPDATE mrr_legacy SET subtotal_contract_currency = $3::numeric, is_recurring = $4,
						mrr_legacy = CASE WHEN $4 THEN round($3::numeric / term, 2) ELSE NULL END,
						momentum = CASE WHEN $4 THEN 'EOP' ELSE NULL END,
						fx_contract_to_invoice = CASE WHEN allocated_invoice_currency <> 0 AND $3::numeric <> 0
							THEN GREATEST(round(abs(allocated_invoice_currency / $3::numeric), 6), 0.000001) ELSE fx_contract_to_invoice END
					WHERE id = $1 AND holding_id = $2`,
					[month.id, holdingId, subtotal, recurring]
				);
				changes.push({
					id: month.id,
					period_month: current.period,
					before: { subtotal_contract_currency: num(current.subtotal_contract_currency), is_recurring: current.is_recurring === true },
					after: { subtotal_contract_currency: subtotal, is_recurring: recurring },
				});
			}
			if (changes.length) {
				await insertOnboardingEvent(runner, holdingId, actor.userId, {
					type: 'history_months_edited',
					lineKey: rawLineKey(parts),
					payload: { months: changes },
				});
			}
		});

		return this.line(holdingId, key);
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
		if (line.status !== 'pending' && line.status !== 'pending_ended') warnings.push('La línea no tiene meses pendientes: no quedará empalmada');
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
		const preview = await this.contractDrafts.preview(omitKey(dto, 'origin') as CreateContractDto, holdingId);
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
		const created = (await this.contractDrafts.create(omitKey(dto, 'origin') as CreateContractDto, holdingId, actor.authId)) as Row;
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

	private assertSameClient(parts: LineKeyParts, dto: CreateContractDto) {
		if (dto.client_id !== parts.client_id) {
			throw conflict('contract_other_client', 'El contrato debe ser del mismo cliente comercial que la línea');
		}
	}
}
