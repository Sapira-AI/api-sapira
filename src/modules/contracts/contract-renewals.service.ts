import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { DataSource, type QueryRunner } from 'typeorm';

import { NotificationsService } from '@/modules/notifications/notifications.service';

import { setApiWriter } from './api-writer';
import { todayFor } from './business-date';
import { indexVariation } from './contract-changes';
import { ContractChangesService } from './contract-changes.service';
import { resolveUserId } from './contract-drafts.service';
import {
	AUTO_RENEWAL_JOB,
	compactRenewalPreview,
	DEFAULT_NOTICE_DAYS,
	type DueCandidate,
	dueKey,
	dueScheduledChanges,
	EXTEND_HORIZON_JOB,
	groupRenewalCandidates,
	loadOpenRenewalProposals,
	noticeLimit,
	proposalCounts,
	proposalItemOf,
	proposalKey,
	RENEWAL_PROPOSAL_CODES,
	RENEWAL_PROPOSAL_DISMISSED,
	RENEWAL_PROPOSED,
	RENEWAL_PROPOSED_NOTIFICATION_TYPE,
	type RenewalCandidate,
	type RenewalProposalCounts,
	type RenewalProposalView,
	SCHEDULED_CHANGE_DUE,
	SCHEDULED_CHANGE_DUE_NOTIFICATION_TYPE,
	SCHEDULED_CHANGES_JOB,
	SYSTEM_ACTOR_ID,
} from './contract-renewals';
import { derivedStatusLateral } from './contract-status';
import { ContractsService } from './contracts.service';
import { loadScheduledChanges, type ScheduledChangeRow } from './scheduled-change-rows';

import type { ContractChangeRequestDto } from './dtos/contract-changes.dto';

type Row = Record<string, unknown>;

const toText = (value: unknown) => (value === null || value === undefined ? null : String(value));
const toNumber = (value: unknown) => Number(value ?? 0) || 0;
const toNullableNumber = (value: unknown) => (value === null || value === undefined ? null : toNumber(value));
const parseJson = (value: unknown) => (typeof value === 'string' ? (JSON.parse(value) as unknown) : value);
const isoDate = (date: Date) => todayFor(null, date);

/** Resultado de una corrida por holding (try/catch por holding: un holding que falla no detiene a los demás). */
export interface JobHoldingResult {
	holding_id: string;
	success: boolean;
	events: number;
	error?: string;
}

/**
 * Auto-renovación v2 con confirmación y aviso de pactos (spec modificaciones §9.3.5 y §9.3.6, B2-4).
 *
 * - Job `contracts-auto-renewal` (`proposeRenewals`): por holding, ítems recurrentes `auto_renew` sin renovar ni churn de contratos
 *   `active | pending_renewal` con `end_date ≤ hoy + holding_settings.auto_renewal_notice_days` → un evento `RENEWAL_PROPOSED` por contrato
 *   (`created_by` = actor sistema, `metadata { items, preview, pacts, proposal_keys, status: open }`, idempotente por ítem y fin) y una
 *   notificación. **Nunca renueva**.
 * - Job `contracts-scheduled-changes` (`flagDueScheduledChanges`): pactos `on_date` / `every_n_months` con fecha ≤ hoy + aviso → evento
 *   `SCHEDULED_CHANGE_DUE` (idempotente por pacto y fecha) + notificación; aplicar sigue siendo manual (`…/scheduled-changes/:id/apply`).
 * - `GET /contracts/renewal-proposals` y `POST /contracts/:id/renewal-proposals/:eventId/dismiss { reason }` (`RENEWAL_PROPOSAL_DISMISSED`).
 * Toda escritura en una transacción con `setApiWriter` primero; el contrato se bloquea (`FOR UPDATE`) antes de revisar la idempotencia.
 */
@Injectable()
export class ContractRenewalsService {
	private readonly logger = new Logger(ContractRenewalsService.name);

	constructor(
		private readonly dataSource: DataSource,
		private readonly contracts: ContractsService,
		private readonly changes: ContractChangesService,
		private readonly notifications: NotificationsService
	) {}

	// ---------------------------------------------------------------- lectura

	/** `GET /contracts/renewal-proposals`: propuestas abiertas del holding con conteos (KPI "Renuevan en 30 días"). */
	async listProposals(holdingId: string, asOf = new Date()): Promise<{ data: RenewalProposalView[]; counts: RenewalProposalCounts }> {
		const data = await loadOpenRenewalProposals(this.dataSource, holdingId, isoDate(asOf));

		return { data, counts: proposalCounts(data) };
	}

	// ---------------------------------------------------------------- omitir

	/** `POST /contracts/:id/renewal-proposals/:eventId/dismiss { reason }`: la propuesta queda `dismissed`; evento `RENEWAL_PROPOSAL_DISMISSED`. */
	async dismiss(idOrNumber: string, eventId: string, reason: string, holdingId: string, authId: string) {
		const contract = await this.contracts.resolveContract(idOrNumber, holdingId);
		const userId = await resolveUserId(this.dataSource, authId);
		const result = await this.transaction(async (runner) => {
			const [proposal] = (await runner.query(
				`SELECT id, metadata, items_affected FROM contract_lifecycle_events
				WHERE id = $1 AND contract_id = $2 AND holding_id = $3 AND event_type = '${RENEWAL_PROPOSED}' FOR UPDATE`,
				[eventId, contract.id, holdingId]
			)) as Row[];

			if (!proposal)
				throw new NotFoundException({
					message: 'La propuesta de renovación no existe en este contrato',
					code: RENEWAL_PROPOSAL_CODES.not_found,
				});
			const metadata = (parseJson(proposal.metadata) ?? {}) as Row;
			const status = toText(metadata.status) ?? 'open';

			if (status !== 'open')
				throw new ConflictException({
					message: `La propuesta ya está ${status === 'confirmed' ? 'confirmada' : 'omitida'}`,
					code: RENEWAL_PROPOSAL_CODES.not_open,
				});
			const items = (Array.isArray(metadata.items) ? metadata.items : []) as Row[];
			const [event] = (await runner.query(
				`INSERT INTO contract_lifecycle_events (
					contract_id, holding_id, event_type, event_status, title, description, summary, created_by, completed_at, effective_date,
					amount_delta, items_affected, metadata
				) VALUES ($1, $2, '${RENEWAL_PROPOSAL_DISMISSED}', 'Completed', $3, $4, $4, $5, now(), CURRENT_DATE, 0, $6::jsonb, $7::jsonb)
				RETURNING id`,
				[
					contract.id,
					holdingId,
					'Propuesta de renovación omitida',
					`Se omitió la propuesta de renovación de ${items.map((item) => item.product_name).join(', ')}: ${reason}`,
					userId,
					JSON.stringify(items.map((item) => String(item.item_id))),
					JSON.stringify({ source: 'api_v2', proposal_event_id: proposal.id, reason, items }),
				]
			)) as Row[];

			await runner.query(
				`UPDATE contract_lifecycle_events SET event_status = 'Completed', completed_at = now(),
					metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('status', 'dismissed', 'dismissed_by_event_id', $3::text,
						'dismissed_reason', $4::text, 'dismissed_at', now())
				WHERE id = $1 AND holding_id = $2`,
				[proposal.id, holdingId, String(event.id), reason]
			);

			return { proposal_event_id: String(proposal.id), event_id: String(event.id), status: 'dismissed' as const, reason };
		});

		await this.resolveNotification(holdingId, `contracts:renewal-proposal:${result.proposal_event_id}`);

		return result;
	}

	// ---------------------------------------------------------------- job contracts-auto-renewal (§9.3.5)

	/** Corrida diaria: todos los holdings con contratos Activos; try/catch por holding. */
	async proposeRenewals(today = new Date()): Promise<JobHoldingResult[]> {
		return await this.perHolding(AUTO_RENEWAL_JOB, (holdingId) => this.proposeRenewalsForHolding(holdingId, today));
	}

	/** Propuestas de un holding: un evento `RENEWAL_PROPOSED` por contrato con sus ítems no propuestos aún (por ítem y fin). Devuelve cuántos. */
	async proposeRenewalsForHolding(holdingId: string, today = new Date()): Promise<number> {
		const iso = isoDate(today);
		const notice = await this.noticeDays(holdingId);
		const rows = (await this.dataSource.query(
			`SELECT ci.id, ci.contract_id, c.contract_number, ci.product_name, ci.end_date::text AS end_date, ci.quantity, ci.unit_price,
				ci.monthly_price, ci.currency, ci.term_months, ci.billing_frequency
			FROM contract_items ci
			JOIN contracts c ON c.id = ci.contract_id AND c.holding_id = ci.holding_id
			${derivedStatusLateral('$2')}
			WHERE c.holding_id = $1 AND c.deleted_at IS NULL AND ds.derived_status IN ('active', 'pending_renewal')
				AND ci.is_recurring = true AND ci.auto_renew = true AND ci.renewed_by_item_id IS NULL AND ci.churn_date IS NULL
				AND COALESCE(ci.categoria, '') NOT IN ('CHURN', 'DOWNSELL')
				AND NOT (ci.related_item_id IS NOT NULL AND COALESCE(ci.categoria, '') = 'UPSELL')
				AND ci.end_date IS NOT NULL AND ci.end_date <= $3::date
			ORDER BY ci.contract_id, ci.end_date, ci.id`,
			[holdingId, iso, noticeLimit(iso, notice)]
		)) as Row[];
		const candidates: RenewalCandidate[] = (rows ?? []).map((row) => ({
			item_id: String(row.id),
			contract_id: String(row.contract_id),
			contract_number: toText(row.contract_number),
			product_name: toText(row.product_name),
			end_date: String(row.end_date).slice(0, 10),
			quantity: toNullableNumber(row.quantity),
			unit_price: toNullableNumber(row.unit_price),
			monthly_price: toNullableNumber(row.monthly_price),
			currency: toText(row.currency),
			term_months: toNullableNumber(row.term_months),
			billing_frequency: toText(row.billing_frequency),
		}));
		let created = 0;

		if (!candidates.length) return 0;
		const proposed = await this.proposedKeys(this.dataSource, holdingId, [...new Set(candidates.map((row) => row.contract_id))]);

		for (const [contractId, items] of groupRenewalCandidates(candidates, proposed, iso, notice)) {
			// Preview de solo lectura con los valores vigentes (precio y pactos se editan al confirmar).
			const request: ContractChangeRequestDto = {
				effective_date: iso,
				origin: { type: 'manual' },
				reason: 'Propuesta de renovación automática',
				change: { type: 'renewal', items: items.map((item) => ({ item_id: item.item_id })) },
			};
			let preview: Record<string, unknown>;

			try {
				preview = compactRenewalPreview((await this.changes.preview(contractId, request, holdingId, today)) as unknown as Row);
			} catch (error) {
				preview = compactRenewalPreview(null, error instanceof Error ? error.message : String(error));
			}
			const pacts = (await loadScheduledChanges(this.dataSource, contractId, holdingId))
				.filter(
					(pact) =>
						pact.status === 'scheduled' &&
						pact.trigger === 'on_renewal' &&
						(pact.contract_item_id === null || items.some((item) => item.item_id === pact.contract_item_id))
				)
				.map((pact) => ({
					id: pact.id,
					item_id: pact.contract_item_id,
					kind: pact.kind,
					value: pact.value,
					product_name: pact.product_name,
				}));
			const eventId = await this.transaction(async (runner) => {
				await runner.query(`SELECT id FROM contracts WHERE id = $1 AND holding_id = $2 FOR UPDATE`, [contractId, holdingId]);
				// Otra réplica pudo proponerlos entre la lectura y el lock.
				const already = await this.proposedKeys(runner, holdingId, [contractId]);
				const fresh = items.filter((item) => !already.has(proposalKey(item.item_id, item.end_date)));

				if (!fresh.length) return null;
				const end = fresh.map((item) => item.end_date).sort()[0];
				const [event] = (await runner.query(
					`INSERT INTO contract_lifecycle_events (
						contract_id, holding_id, event_type, event_status, title, description, summary, created_by, effective_date,
						amount_delta, items_affected, metadata
					) VALUES ($1, $2, '${RENEWAL_PROPOSED}', 'Pending', $3, $4, $4, $5, $6::date, 0, $7::jsonb, $8::jsonb) RETURNING id`,
					[
						contractId,
						holdingId,
						'Propuesta de renovación',
						`Vence${fresh.length > 1 ? 'n' : ''} el ${end}: ${fresh.map((item) => item.product_name).join(', ')}. Confirma la renovación u omítela`,
						SYSTEM_ACTOR_ID,
						end,
						JSON.stringify(fresh.map((item) => item.item_id)),
						JSON.stringify({
							source: 'api_v2',
							job: AUTO_RENEWAL_JOB,
							created_by_system: true,
							status: 'open',
							notice_days: notice,
							proposal_keys: fresh.map((item) => proposalKey(item.item_id, item.end_date)),
							items: fresh.map(proposalItemOf),
							preview,
							pacts,
						}),
					]
				)) as Row[];

				return { id: String(event.id), end, fresh };
			});

			if (!eventId) continue;
			created += 1;
			await this.notify(holdingId, {
				type: RENEWAL_PROPOSED_NOTIFICATION_TYPE,
				title: `Renovación por confirmar: ${items[0].contract_number ?? 'contrato'}`,
				message: `${eventId.fresh.map((item) => item.product_name).join(', ')} vence${eventId.fresh.length > 1 ? 'n' : ''} el ${eventId.end}. La renovación no se aplica sola: confírmala u omítela desde el contrato.`,
				action_type: 'review_renewal_proposal',
				action_payload: { contract_id: contractId, event_id: eventId.id },
				resource_id: contractId,
				deduplication_key: `contracts:renewal-proposal:${eventId.id}`,
			});
		}

		return created;
	}

	// ---------------------------------------------------------------- job contracts-scheduled-changes (§9.3.6)

	/**
	 * Job `contracts-extend-horizon`: por holding, las Por Emitir que faltan para que los ítems sin término tengan siempre 12 períodos desde
	 * hoy (`ContractChangesService.extendHorizonForHolding`; evento `HORIZON_EXTENDED` por contrato solo si creó algo).
	 */
	async extendHorizons(today = new Date()): Promise<JobHoldingResult[]> {
		return await this.perHolding(EXTEND_HORIZON_JOB, (holdingId) => this.changes.extendHorizonForHolding(holdingId, SYSTEM_ACTOR_ID, today));
	}

	async flagDueScheduledChanges(today = new Date()): Promise<JobHoldingResult[]> {
		return await this.perHolding(SCHEDULED_CHANGES_JOB, (holdingId) => this.flagDueForHolding(holdingId, today));
	}

	/**
	 * Pactos en fecha por vencer de un holding → evento `SCHEDULED_CHANGE_DUE` + notificación (confirmación; aplicar es manual). Pacto `index`:
	 * el aviso lleva la variación del índice a la fecha (`indicadores_economicos`, con `index_lag_months`) o `index_value_missing`.
	 */
	async flagDueForHolding(holdingId: string, today = new Date()): Promise<number> {
		const iso = isoDate(today);
		const notice = await this.noticeDays(holdingId);
		const rows = (await this.dataSource.query(
			`SELECT sc.id, sc.contract_id, c.contract_number, sc.contract_item_id, ci.product_name, sc.trigger, sc.kind, sc.value, sc.index_code,
				sc.index_base_value, sc.index_lag_months,
				(CASE WHEN sc.trigger = 'on_date' THEN sc.effective_date ELSE COALESCE(sc.next_effective_date, sc.anchor_date) END)::text AS due_date
			FROM contract_scheduled_changes sc
			JOIN contracts c ON c.id = sc.contract_id AND c.holding_id = sc.holding_id
			LEFT JOIN contract_items ci ON ci.id = sc.contract_item_id
			WHERE sc.holding_id = $1 AND sc.status = 'scheduled' AND sc.trigger IN ('on_date', 'every_n_months') AND sc.parent_id IS NULL
				AND c.deleted_at IS NULL AND c.status = 'Activo'
				AND (CASE WHEN sc.trigger = 'on_date' THEN sc.effective_date ELSE COALESCE(sc.next_effective_date, sc.anchor_date) END) <= $2::date
			ORDER BY due_date, sc.id`,
			[holdingId, noticeLimit(iso, notice)]
		)) as Row[];
		const candidates: Array<DueCandidate & { row: Row }> = (rows ?? []).map((row) => ({
			id: String(row.id),
			contract_id: String(row.contract_id),
			contract_number: toText(row.contract_number),
			contract_item_id: toText(row.contract_item_id),
			product_name: toText(row.product_name),
			trigger: String(row.trigger) as DueCandidate['trigger'],
			kind: String(row.kind),
			value: toNumber(row.value),
			due_date: String(row.due_date).slice(0, 10),
			index_code: toText(row.index_code),
			row,
		}));

		if (!candidates.length) return 0;
		const notified = await this.dueKeys(this.dataSource, holdingId, [...new Set(candidates.map((pact) => pact.contract_id))]);
		const due = dueScheduledChanges(candidates, notified, iso, notice) as Array<DueCandidate & { row: Row }>;
		const series = await this.indexSeries(due.map((pact) => pact.index_code).filter((code): code is string => Boolean(code)));
		let created = 0;

		for (const pact of due) {
			const variation =
				pact.kind === 'index'
					? indexVariation(
							{
								index_code: pact.index_code,
								index_base_value: toNullableNumber(pact.row.index_base_value),
								index_lag_months: pact.row.index_lag_months === null ? 1 : toNumber(pact.row.index_lag_months),
								value: pact.value,
							} as Pick<ScheduledChangeRow, 'index_code' | 'index_base_value' | 'index_lag_months' | 'value'>,
							series,
							pact.due_date
						)
					: null;
			const index = pact.kind === 'index' ? { code: pact.index_code, value_missing: !variation, ...(variation ?? {}) } : null;
			const key = dueKey(pact.id, pact.due_date);
			const eventId = await this.transaction(async (runner) => {
				await runner.query(`SELECT id FROM contracts WHERE id = $1 AND holding_id = $2 FOR UPDATE`, [pact.contract_id, holdingId]);
				if ((await this.dueKeys(runner, holdingId, [pact.contract_id])).has(key)) return null;
				const [event] = (await runner.query(
					`INSERT INTO contract_lifecycle_events (
						contract_id, holding_id, event_type, event_status, title, description, summary, created_by, effective_date,
						amount_delta, items_affected, metadata
					) VALUES ($1, $2, '${SCHEDULED_CHANGE_DUE}', 'Pending', $3, $4, $4, $5, $6::date, 0, $7::jsonb, $8::jsonb) RETURNING id`,
					[
						pact.contract_id,
						holdingId,
						'Ajuste pactado por aplicar',
						`El pacto ${pact.kind} (${pact.value})${pact.product_name ? ` de "${pact.product_name}"` : ''} rige el ${pact.due_date}: revísalo y aplícalo${
							index?.value_missing ? ' (falta el valor publicado del índice)' : ''
						}`,
						SYSTEM_ACTOR_ID,
						pact.due_date,
						JSON.stringify(pact.contract_item_id ? [pact.contract_item_id] : []),
						JSON.stringify({
							source: 'api_v2',
							job: SCHEDULED_CHANGES_JOB,
							created_by_system: true,
							scheduled_change_id: pact.id,
							trigger: pact.trigger,
							kind: pact.kind,
							value: pact.value,
							due_date: pact.due_date,
							due_key: key,
							notice_days: notice,
							index,
							blockers: index?.value_missing ? ['index_value_missing'] : [],
						}),
					]
				)) as Row[];

				return String(event.id);
			});

			if (!eventId) continue;
			created += 1;
			await this.notify(holdingId, {
				type: SCHEDULED_CHANGE_DUE_NOTIFICATION_TYPE,
				title: `Ajuste pactado por aplicar: ${pact.contract_number ?? 'contrato'}`,
				message: `El pacto ${pact.kind} (${pact.value})${pact.product_name ? ` de "${pact.product_name}"` : ''} rige el ${pact.due_date}. No se aplica solo: revísalo y aplícalo desde el contrato.${
					index?.value_missing ? ' Falta el valor publicado del índice.' : ''
				}`,
				action_type: 'review_scheduled_change',
				action_payload: { contract_id: pact.contract_id, scheduled_change_id: pact.id, event_id: eventId },
				resource_id: pact.contract_id,
				deduplication_key: `contracts:scheduled-change-due:${key}`,
			});
		}

		return created;
	}

	// ---------------------------------------------------------------- internos

	private async perHolding(job: string, work: (holdingId: string) => Promise<number>): Promise<JobHoldingResult[]> {
		const holdings = (await this.dataSource.query(
			`SELECT DISTINCT holding_id FROM contracts WHERE deleted_at IS NULL AND status = 'Activo' AND holding_id IS NOT NULL ORDER BY holding_id`
		)) as Row[];
		const results: JobHoldingResult[] = [];

		for (const row of holdings ?? []) {
			const holdingId = String(row.holding_id);

			try {
				results.push({ holding_id: holdingId, success: true, events: await work(holdingId) });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);

				this.logger.error(`${job}: falló el holding ${holdingId}: ${message}`);
				results.push({ holding_id: holdingId, success: false, events: 0, error: message });
			}
		}

		return results;
	}

	private async noticeDays(holdingId: string): Promise<number> {
		const [row] = (await this.dataSource.query(`SELECT auto_renewal_notice_days FROM holding_settings WHERE holding_id = $1`, [
			holdingId,
		])) as Row[];

		return toNumber(row?.auto_renewal_notice_days) || DEFAULT_NOTICE_DAYS;
	}

	/** Claves `ítem:fin` ya propuestas (cualquier estado: una propuesta omitida no se repite para el mismo fin). */
	private async proposedKeys(db: Pick<DataSource, 'query'> | QueryRunner, holdingId: string, contractIds: string[]): Promise<Set<string>> {
		const rows = (await db.query(
			`SELECT jsonb_array_elements_text(COALESCE(metadata->'proposal_keys', '[]'::jsonb)) AS key FROM contract_lifecycle_events
			WHERE holding_id = $1 AND contract_id = ANY($2::uuid[]) AND event_type = '${RENEWAL_PROPOSED}'`,
			[holdingId, contractIds]
		)) as Row[];

		return new Set((rows ?? []).map((row) => String(row.key)));
	}

	/** Claves `pacto:fecha` ya avisadas. */
	private async dueKeys(db: Pick<DataSource, 'query'> | QueryRunner, holdingId: string, contractIds: string[]): Promise<Set<string>> {
		const rows = (await db.query(
			`SELECT metadata->>'due_key' AS key FROM contract_lifecycle_events
			WHERE holding_id = $1 AND contract_id = ANY($2::uuid[]) AND event_type = '${SCHEDULED_CHANGE_DUE}'`,
			[holdingId, contractIds]
		)) as Row[];

		return new Set((rows ?? []).map((row) => toText(row.key)).filter((key): key is string => Boolean(key)));
	}

	private async indexSeries(codes: string[]): Promise<Map<string, Array<{ date: string; value: number }>>> {
		const series = new Map<string, Array<{ date: string; value: number }>>();

		if (!codes.length) return series;
		const rows = (await this.dataSource.query(
			`SELECT codigo, fecha::text AS fecha, valor FROM indicadores_economicos WHERE codigo = ANY($1::text[]) ORDER BY fecha`,
			[[...new Set(codes)]]
		)) as Row[];

		for (const row of rows ?? []) {
			const code = String(row.codigo);

			series.set(code, [...(series.get(code) ?? []), { date: String(row.fecha).slice(0, 10), value: toNumber(row.valor) }]);
		}

		return series;
	}

	/** Notificación del holding (suscripciones por tipo + super admins); un fallo no deshace el evento. */
	private async notify(
		holdingId: string,
		input: {
			type: string;
			title: string;
			message: string;
			action_type: string;
			action_payload: Record<string, unknown>;
			resource_id: string;
			deduplication_key: string;
		}
	) {
		try {
			await this.notifications.createOrUpdate(holdingId, {
				source: 'contracts',
				severity: 'info',
				recommendation: 'Abre el contrato y revisa la tarjeta en el Resumen',
				resource_type: 'contract',
				metadata: { ...input.action_payload },
				recipients: { include_super_admins: true },
				...input,
			});
		} catch (error) {
			this.logger.warn(`No se pudo notificar ${input.type} (holding ${holdingId}): ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private async resolveNotification(holdingId: string, key: string) {
		try {
			await this.notifications.resolveByDeduplicationKey(holdingId, key);
		} catch (error) {
			this.logger.warn(`No se pudo cerrar la notificación ${key}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private async transaction<T>(work: (runner: QueryRunner) => Promise<T>): Promise<T> {
		const runner = this.dataSource.createQueryRunner();

		await runner.connect();
		await runner.startTransaction();
		try {
			// Costura `sapira.writer = 'api'`: primera sentencia de la transacción.
			await setApiWriter(runner);
			const result = await work(runner);

			await runner.commitTransaction();

			return result;
		} catch (error) {
			await runner.rollbackTransaction();
			throw error;
		} finally {
			await runner.release();
		}
	}
}
