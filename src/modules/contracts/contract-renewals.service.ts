import { ConflictException, HttpException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { DataSource, type QueryRunner } from 'typeorm';

import { holdingTimezone, loadHoldingPreferences } from '@/core/utils/holding-preferences';
import { NotificationsService } from '@/modules/notifications/notifications.service';

import { setApiWriter } from './api-writer';
import { todayFor } from './business-date';
import { PACT_KIND_LABELS } from './contract-alerts';
import { indexVariation } from './contract-changes';
import { ContractChangesService } from './contract-changes.service';
import { resolveUserId } from './contract-drafts.service';
import {
	AUTO_RENEWAL_JOB,
	autoRenewalSummary,
	compactRenewalPreview,
	DEFAULT_AUTO_RENEW_TERM_MONTHS,
	type DueCandidate,
	dueKey,
	dueReminders,
	dueScheduledChanges,
	EXTEND_HORIZON_JOB,
	loadOpenRenewalProposals,
	noticeLimit,
	proposalCounts,
	proposalItemOf,
	proposalKey,
	type ReminderCandidate,
	reminderLabel,
	reminderLadder,
	reminderTone,
	RENEWAL_PROPOSAL_CODES,
	RENEWAL_PROPOSAL_DISMISSED,
	RENEWAL_PROPOSED,
	RENEWAL_PROPOSED_NOTIFICATION_TYPE,
	RENEWAL_REMINDER,
	RENEWAL_REMINDER_NOTIFICATION_TYPE,
	RENEWAL_REMINDERS_JOB,
	type RenewalCandidate,
	type RenewalProposalCounts,
	type RenewalProposalView,
	SCHEDULED_CHANGE_DUE,
	SCHEDULED_CHANGE_DUE_NOTIFICATION_TYPE,
	SCHEDULED_CHANGES_JOB,
	SYSTEM_ACTOR_ID,
} from './contract-renewals';
import { ContractScheduledChangesService } from './contract-scheduled-changes.service';
import { derivedStatusLateral } from './contract-status';
import { ContractsService } from './contracts.service';
import { loadScheduledChanges, type ScheduledChangeRow } from './scheduled-change-rows';

import type { ContractChangeRequestDto } from './dtos/contract-changes.dto';

type Row = Record<string, unknown>;

const toText = (value: unknown) => (value === null || value === undefined ? null : String(value));
const toNumber = (value: unknown) => Number(value ?? 0) || 0;
const toNullableNumber = (value: unknown) => (value === null || value === undefined ? null : toNumber(value));
const parseJson = (value: unknown) => (typeof value === 'string' ? (JSON.parse(value) as unknown) : value);
/** "Hoy" del holding en su zona horaria (`holding_settings.timezone`, ronda 4; default America/Santiago). */
const isoDate = (date: Date, timezone?: string | null) => todayFor(timezone, date);
/** Ítem del pedido `renewal` con el plazo de su renovación automática. */
const renewalRef = (item: RenewalCandidate) => ({ item_id: item.item_id, ...(item.term_months ? { term_months: item.term_months } : {}) });
/** Motivo legible de por qué el motor no aplicó un cambio (409 `blocked` con sus bloqueos, 400 de validación u otro error). */
const failureReason = (error: unknown): string => {
	const response = error instanceof HttpException ? error.getResponse() : null;
	const preview =
		response && typeof response === 'object' ? ((response as Row).preview as { blockers?: Array<{ message: string }> } | undefined) : undefined;

	if (preview?.blockers?.length) return preview.blockers.map((blocker) => blocker.message).join('; ');

	return error instanceof Error ? error.message : String(error);
};

/** Resultado de una corrida por holding (try/catch por holding: un holding que falla no detiene a los demás). */
export interface JobHoldingResult {
	holding_id: string;
	success: boolean;
	events: number;
	error?: string;
}

/**
 * Renovación automática y cambios programados que se aplican solos (Domi 13-11; `docs/cambios/renovacion-automatica-y-cambios-programados-13-11.md`).
 *
 * - Job `contracts-auto-renewal` (`proposeRenewals`): por holding, ítems recurrentes `auto_renew` sin renovar ni churn con
 *   `end_date ≤ hoy + holding_settings.auto_renewal_notice_days`. Si aún no vencen, **se renuevan solos** (cambio `renewal` con el actor
 *   sistema, plazo `auto_renew_term_months` o 12 meses). Lo ya vencido, o lo que el motor bloquea, queda como evento `RENEWAL_PROPOSED`
 *   (idempotente por ítem y fin) con su notificación; una propuesta omitida no se renueva.
 * - Job `contracts-scheduled-changes` (`flagDueScheduledChanges`): cambios `on_date` / `every_n_months` con fecha ≤ hoy + aviso → **se
 *   aplican solos**; el que no se puede aplicar deja `SCHEDULED_CHANGE_DUE` (idempotente por cambio y fecha) + notificación con el motivo.
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
		private readonly notifications: NotificationsService,
		private readonly scheduledChanges: ContractScheduledChangesService
	) {}

	// ---------------------------------------------------------------- lectura

	/** `GET /contracts/renewal-proposals`: propuestas abiertas del holding con conteos (KPI "Renuevan en 30 días"). */
	async listProposals(holdingId: string, asOf = new Date()): Promise<{ data: RenewalProposalView[]; counts: RenewalProposalCounts }> {
		const data = await loadOpenRenewalProposals(this.dataSource, holdingId, isoDate(asOf, await holdingTimezone(this.dataSource, holdingId)));

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
		const prefs = await loadHoldingPreferences(this.dataSource, holdingId);
		const iso = isoDate(today, prefs.timezone);
		const notice = prefs.auto_renewal_notice_days;
		const rows = (await this.dataSource.query(
			`SELECT ci.id, ci.contract_id, c.contract_number, ci.product_name, ci.end_date::text AS end_date, ci.quantity, ci.unit_price,
				ci.monthly_price, ci.currency, COALESCE(ci.auto_renew_term_months, ${DEFAULT_AUTO_RENEW_TERM_MONTHS}) AS term_months, ci.billing_frequency,
				COALESCE(co.legal_name, co.holding_name) AS company_name
			FROM contract_items ci
			JOIN contracts c ON c.id = ci.contract_id AND c.holding_id = ci.holding_id
			LEFT JOIN companies co ON co.id = c.company_id
			${derivedStatusLateral('$2')}
			WHERE c.holding_id = $1 AND c.deleted_at IS NULL AND ds.derived_status IN ('active', 'pending_renewal', 'expired')
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
			company_name: toText(row.company_name),
		}));
		let created = 0;
		const renewedCompanies: Array<string | null> = [];

		if (!candidates.length) return 0;
		const states = await this.proposalStates(this.dataSource, holdingId, [...new Set(candidates.map((row) => row.contract_id))]);
		const byContract = new Map<string, RenewalCandidate[]>();

		for (const candidate of candidates) {
			// Una propuesta omitida no se renueva sola ni se vuelve a proponer para el mismo fin.
			if (states.get(proposalKey(candidate.item_id, candidate.end_date))?.status === 'dismissed') continue;
			byContract.set(candidate.contract_id, [...(byContract.get(candidate.contract_id) ?? []), candidate]);
		}
		for (const [contractId, items] of byContract) {
			// Aún no vence: se renueva sola (Domi 13-11: 30 días antes del fin, sin confirmar). Lo ya vencido no: renovarlo tarde factura hacia
			// atrás, así que queda como propuesta para que una persona decida.
			const due = items.filter((item) => item.end_date >= iso);
			let pending = items;
			let blocked: string | null = null;

			if (due.length) {
				const open = due.map((item) => states.get(proposalKey(item.item_id, item.end_date))).find((state) => state?.status === 'open');
				const outcome = await this.renewAutomatically(holdingId, contractId, due, open?.event_id ?? null, iso, today);

				if (outcome.renewed) {
					created += 1;
					renewedCompanies.push(due[0].company_name ?? null);
					pending = items.filter((item) => item.end_date < iso);
				} else blocked = outcome.reason;
			}
			const fresh = pending.filter((item) => !states.has(proposalKey(item.item_id, item.end_date)));

			if (fresh.length && (await this.propose(holdingId, contractId, fresh, iso, notice, today, blocked))) created += 1;
		}
		// Resumen del día (Domi 13-11): una sola notificación por holding con el conteo por compañía; nunca una por contrato.
		if (renewedCompanies.length) await this.notifyAutoRenewals(holdingId, iso, renewedCompanies);

		return created;
	}

	private async notifyAutoRenewals(holdingId: string, iso: string, companies: Array<string | null>) {
		try {
			await this.notifications.createOrUpdate(holdingId, {
				source: 'contracts',
				type: RENEWAL_PROPOSED_NOTIFICATION_TYPE,
				severity: 'info',
				title: `Renovaciones automáticas del ${iso.slice(8, 10)}-${iso.slice(5, 7)}: ${companies.length} ${companies.length === 1 ? 'contrato' : 'contratos'}`,
				message: autoRenewalSummary(companies),
				recommendation: 'Es informativo: no hay nada que confirmar. Si alguna no correspondía, revísala en el contrato.',
				metadata: { date: iso, contracts: companies.length, kind: 'auto_renewal_summary' },
				deduplication_key: `contracts:auto-renewals:${iso}`,
			});
		} catch (error) {
			this.logger.warn(
				`No se pudo notificar el resumen de renovaciones (holding ${holdingId}): ${error instanceof Error ? error.message : String(error)}`
			);
		}
	}

	/**
	 * Renueva sola los ítems `auto_renew` de un contrato: el mismo cambio `renewal` que confirma una persona (ítem único con el valor
	 * vigente del grupo, pactos `on_renewal`, facturas del plazo nuevo), con el actor sistema y clave de idempotencia por contrato y fin.
	 * Si el motor lo bloquea (período cerrado, índice sin dato…) no renueva y devuelve el motivo: el contrato queda como propuesta.
	 */
	private async renewAutomatically(
		holdingId: string,
		contractId: string,
		items: RenewalCandidate[],
		proposalEventId: string | null,
		iso: string,
		today: Date
	): Promise<{ renewed: boolean; reason: string | null }> {
		const ids = items.map((item) => item.item_id).sort();
		const request: ContractChangeRequestDto = {
			effective_date: iso,
			origin: proposalEventId ? { type: 'renewal_proposal', event_id: proposalEventId } : { type: 'manual' },
			reason: 'Renovación automática',
			// Plazo de la renovación automática del ítem (`auto_renew_term_months`); sin él, 12 meses (Domi 13-11), no el plazo original.
			change: { type: 'renewal', items: ids.map((id) => renewalRef(items.find((item) => item.item_id === id)!)) },
		};

		try {
			await this.changes.apply(contractId, request, holdingId, SYSTEM_ACTOR_ID, `auto-renewal:${items[0].end_date}:${ids.join('+')}`, today);
		} catch (error) {
			const reason = failureReason(error);

			this.logger.warn(`${AUTO_RENEWAL_JOB}: el contrato ${items[0].contract_number ?? contractId} no se renovó solo: ${reason}`);

			return { renewed: false, reason };
		}
		// Propuestas abiertas de esos ítems (la del origen ya quedó confirmada): se cierran con su notificación.
		const keys = items.map((item) => proposalKey(item.item_id, item.end_date));
		const closedRows = await this.transaction(async (runner) => {
			const closed = (await runner.query(
				`UPDATE contract_lifecycle_events SET event_status = 'Completed', completed_at = now(),
					metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('status', 'confirmed', 'confirmed_by_job', '${AUTO_RENEWAL_JOB}', 'confirmed_at', now())
				WHERE holding_id = $1 AND contract_id = $2 AND event_type = '${RENEWAL_PROPOSED}' AND COALESCE(metadata->>'status', 'open') = 'open'
					AND metadata->'proposal_keys' ?| $3::text[]
				RETURNING id`,
				[holdingId, contractId, keys]
			)) as Row[] | [Row[], number];

			// `UPDATE … RETURNING` por el runner devuelve `[filas, afectadas]`.
			return (Array.isArray(closed?.[0]) ? closed[0] : closed) as Row[];
		});

		for (const id of new Set([...(proposalEventId ? [proposalEventId] : []), ...(closedRows ?? []).map((row) => String(row.id))]))
			await this.resolveNotification(holdingId, `contracts:renewal-proposal:${id}`);

		return { renewed: true, reason: null };
	}

	/**
	 * Propuesta de renovación (evento `RENEWAL_PROPOSED` + notificación) para lo que no se renueva solo: ítems ya vencidos o un contrato que
	 * el motor bloqueó (`blocked` = motivo). Idempotente por ítem y fin, revisado con el contrato bloqueado. Devuelve si creó el evento.
	 */
	private async propose(
		holdingId: string,
		contractId: string,
		items: RenewalCandidate[],
		iso: string,
		notice: number,
		today: Date,
		blocked: string | null
	): Promise<boolean> {
		{
			// Preview de solo lectura con los valores vigentes (precio y pactos se editan al confirmar).
			const request: ContractChangeRequestDto = {
				effective_date: iso,
				origin: { type: 'manual' },
				reason: 'Propuesta de renovación automática',
				change: { type: 'renewal', items: items.map(renewalRef) },
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
				// …o renovarlos (otra réplica del job, o una persona).
				const live = new Set(
					(
						(await runner.query(
							`SELECT id FROM contract_items WHERE id = ANY($1::uuid[]) AND renewed_by_item_id IS NULL AND churn_date IS NULL`,
							[items.map((item) => item.item_id)]
						)) as Row[]
					).map((row) => String(row.id))
				);
				const fresh = items.filter((item) => live.has(item.item_id) && !already.has(proposalKey(item.item_id, item.end_date)));

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
						`Vence${fresh.length > 1 ? 'n' : ''} el ${end}: ${fresh.map((item) => item.product_name).join(', ')}. ${
							blocked ? `No se renovó solo: ${blocked}` : 'Ya venció: la renovación no se aplica sola'
						}. Confirma la renovación u omítela`,
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
							auto_renewal_blocked: blocked,
						}),
					]
				)) as Row[];

				return { id: String(event.id), end, fresh };
			});

			if (!eventId) return false;
			await this.notify(holdingId, {
				type: RENEWAL_PROPOSED_NOTIFICATION_TYPE,
				title: `Renovación por confirmar: ${items[0].contract_number ?? 'contrato'}`,
				message: `${eventId.fresh.map((item) => item.product_name).join(', ')} vence${eventId.fresh.length > 1 ? 'n' : ''} el ${eventId.end}. ${
					blocked ? `No se pudo renovar solo: ${blocked}` : 'Ya venció, así que no se renueva solo'
				}. Confírmala u omítela desde el contrato.`,
				action_type: 'review_renewal_proposal',
				action_payload: { contract_id: contractId, event_id: eventId.id },
				resource_id: contractId,
				deduplication_key: `contracts:renewal-proposal:${eventId.id}`,
			});

			return true;
		}
	}

	// ---------------------------------------------------------------- job contracts-renewal-reminders (S2-1 / S5-4, 7b)

	/** Corrida diaria de alertas crecientes: todos los holdings con contratos Activos; try/catch por holding. */
	async remindRenewals(today = new Date()): Promise<JobHoldingResult[]> {
		return await this.perHolding(RENEWAL_REMINDERS_JOB, (holdingId) => this.remindRenewalsForHolding(holdingId, today));
	}

	/**
	 * Alertas crecientes de un holding: ítems recurrentes con fin que siguen sin decisión (sin renovar ni baja; con o sin auto-renovación) de
	 * contratos Activos, Por renovar o Vencidos. Escalones: `auto_renewal_notice_days` (primer aviso) y luego la escalera del holding
	 * (`renewal_reminder_days`, default 60/30/15/7/0) menor que él; vencido, cada `renewal_overdue_every_days` días (default 7). Una alerta por contrato, fin y escalón (evento `RENEWAL_REMINDER` con `metadata { threshold_days, items[] }`,
	 * revisado con el contrato bloqueado) y la notificación del contrato (misma clave por fin: se actualiza al escalar, no se duplica).
	 */
	async remindRenewalsForHolding(holdingId: string, today = new Date()): Promise<number> {
		const prefs = await loadHoldingPreferences(this.dataSource, holdingId);
		const iso = isoDate(today, prefs.timezone);
		const notice = prefs.auto_renewal_notice_days;
		const rows = (await this.dataSource.query(
			`SELECT ci.id, ci.contract_id, c.contract_number, ci.product_name, ci.end_date::text AS end_date
			FROM contract_items ci
			JOIN contracts c ON c.id = ci.contract_id AND c.holding_id = ci.holding_id
			${derivedStatusLateral('$2')}
			WHERE c.holding_id = $1 AND c.deleted_at IS NULL AND ds.derived_status IN ('active', 'pending_renewal', 'expired')
				AND ci.is_recurring = true AND ci.renewed_by_item_id IS NULL AND ci.churn_date IS NULL
				AND COALESCE(ci.categoria, '') NOT IN ('CHURN', 'DOWNSELL')
				AND NOT (ci.related_item_id IS NOT NULL AND COALESCE(ci.categoria, '') = 'UPSELL')
				AND ci.end_date IS NOT NULL AND ci.end_date <= $3::date
			ORDER BY ci.contract_id, ci.end_date, ci.id`,
			[holdingId, iso, noticeLimit(iso, notice)]
		)) as Row[];
		const candidates: ReminderCandidate[] = (rows ?? []).map((row) => ({
			item_id: String(row.id),
			contract_id: String(row.contract_id),
			contract_number: toText(row.contract_number),
			product_name: toText(row.product_name),
			end_date: String(row.end_date).slice(0, 10),
		}));

		if (!candidates.length) return 0;
		const sent = await this.reminderKeys(this.dataSource, holdingId, [...new Set(candidates.map((row) => row.contract_id))]);
		let created = 0;

		const schedule = { steps: prefs.renewal_reminder_days, overdue_every_days: prefs.renewal_overdue_every_days };

		for (const reminder of dueReminders(candidates, sent, iso, notice, schedule)) {
			const label = reminderLabel(reminder.days_to_end);
			const names = reminder.items.map((item) => item.product_name ?? 'Producto').join(', ');
			const eventId = await this.transaction(async (runner) => {
				await runner.query(`SELECT id FROM contracts WHERE id = $1 AND holding_id = $2 FOR UPDATE`, [reminder.contract_id, holdingId]);
				// Otra réplica pudo avisarlo entre la lectura y el lock.
				if ((await this.reminderKeys(runner, holdingId, [reminder.contract_id])).has(reminder.key)) return null;
				const [event] = (await runner.query(
					`INSERT INTO contract_lifecycle_events (
						contract_id, holding_id, event_type, event_status, title, description, summary, created_by, completed_at, effective_date,
						amount_delta, items_affected, metadata
					) VALUES ($1, $2, '${RENEWAL_REMINDER}', 'Completed', $3, $4, $4, $5, now(), $6::date, 0, $7::jsonb, $8::jsonb) RETURNING id`,
					[
						reminder.contract_id,
						holdingId,
						reminder.days_to_end < 0 ? 'Vencido sin decisión' : 'Vencimiento sin decisión',
						`${label}: ${names} (fin ${reminder.end_date}). Renueva o registra la baja`,
						SYSTEM_ACTOR_ID,
						reminder.end_date,
						JSON.stringify(reminder.items.map((item) => item.item_id)),
						JSON.stringify({
							source: 'api_v2',
							job: RENEWAL_REMINDERS_JOB,
							created_by_system: true,
							threshold_days: reminder.threshold_days,
							days_to_end: reminder.days_to_end,
							end_date: reminder.end_date,
							reminder_key: reminder.key,
							notice_days: notice,
							ladder: reminderLadder(notice, schedule.steps),
							overdue_every_days: schedule.overdue_every_days,
							items: reminder.items,
						}),
					]
				)) as Row[];

				return String(event.id);
			});

			if (!eventId) continue;
			created += 1;
			const tone = reminderTone(reminder.threshold_days);

			await this.notify(holdingId, {
				type: RENEWAL_REMINDER_NOTIFICATION_TYPE,
				severity: tone === 'danger' ? 'error' : tone,
				title: `${reminder.contract_number ?? 'Contrato'}: ${label.toLowerCase()}`,
				message: `${names} ${reminder.days_to_end < 0 ? 'venció' : 'vence'} el ${reminder.end_date} y nadie decidió qué hacer. Mientras no se decida, el ingreso sigue reconociéndose como pendiente de renovar.`,
				recommendation: 'Renuévalo o registra la baja desde el contrato.',
				// Cada escalón (días al vencimiento) vuelve a dejar la alerta "sin leer" para todos.
				escalation_step: reminder.threshold_days,
				action_type: 'open_contract',
				action_payload: { contract_id: reminder.contract_id, event_id: eventId, threshold_days: reminder.threshold_days },
				resource_id: reminder.contract_id,
				// Una notificación por contrato y fin: cada escalón la actualiza (no se acumulan).
				deduplication_key: `contracts:renewal-reminder:${reminder.contract_id}:${reminder.end_date}`,
			});
		}

		return created;
	}

	// ---------------------------------------------------------------- job contracts-scheduled-changes (§9.3.6)

	/**
	 * Job `contracts-extend-horizon`: por holding, las Por Emitir que faltan para que los ítems sin término tengan siempre 12 períodos desde
	 * hoy (`HORIZON_PERIODS_AHEAD`, fijo por sistema; `ContractChangesService.extendHorizonForHolding`; evento `HORIZON_EXTENDED` por contrato
	 * solo si creó algo).
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
		const prefs = await loadHoldingPreferences(this.dataSource, holdingId);
		const iso = isoDate(today, prefs.timezone);
		const notice = prefs.auto_renewal_notice_days;
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
		// Todos los que entran al plazo se intentan aplicar cada día; el aviso (lo que no se pudo aplicar) va una vez por pacto y fecha.
		const due = dueScheduledChanges(candidates, new Set(), iso, notice) as Array<DueCandidate & { row: Row }>;
		const series = await this.indexSeries(due.map((pact) => pact.index_code).filter((code): code is string => Boolean(code)));
		let created = 0;

		for (const pact of due) {
			// Cambio futuro: se aplica solo (Domi 13-11), con el mismo "Aplicar" de una persona y el actor sistema. Rige desde el primer
			// período de cada ítem en o después de su fecha; aplicarlo dentro del plazo de aviso deja las Por Emitir con el valor nuevo.
			let blocked: string;

			try {
				await this.scheduledChanges.apply(
					pact.contract_id,
					pact.id,
					{},
					holdingId,
					SYSTEM_ACTOR_ID,
					`auto-scheduled-change:${dueKey(pact.id, pact.due_date)}`,
					today
				);
				created += 1;
				await this.resolveNotification(holdingId, `contracts:scheduled-change-due:${dueKey(pact.id, pact.due_date)}`);
				continue;
			} catch (error) {
				blocked = failureReason(error);
				this.logger.warn(
					`${SCHEDULED_CHANGES_JOB}: el pacto ${pact.id} (${pact.contract_number ?? pact.contract_id}) no se aplicó solo: ${blocked}`
				);
			}
			if (notified.has(dueKey(pact.id, pact.due_date))) continue;
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
						'Cambio programado por aplicar',
						`El cambio programado ${pact.kind} (${pact.value})${pact.product_name ? ` de "${pact.product_name}"` : ''} rige el ${pact.due_date} y no se aplicó solo: ${blocked}`,
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
							auto_apply_blocked: blocked,
						}),
					]
				)) as Row[];

				return String(event.id);
			});

			if (!eventId) continue;
			created += 1;
			await this.notify(holdingId, {
				type: SCHEDULED_CHANGE_DUE_NOTIFICATION_TYPE,
				title: `Cambio programado por aplicar: ${pact.contract_number ?? 'contrato'}`,
				message: `El ${PACT_KIND_LABELS[pact.kind] ?? 'ajuste'} pactado (${pact.value})${pact.product_name ? ` de "${pact.product_name}"` : ''} rige el ${pact.due_date}. No se pudo aplicar solo: ${blocked}.`,
				recommendation: 'Resuelve el bloqueo en el contrato y aplícalo, omítelo esta vez o cancélalo. Se vuelve a intentar cada día.',
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

	/** Claves `ítem:fin` ya propuestas (cualquier estado: una propuesta omitida no se repite para el mismo fin). */
	private async proposedKeys(db: Pick<DataSource, 'query'> | QueryRunner, holdingId: string, contractIds: string[]): Promise<Set<string>> {
		const rows = (await db.query(
			`SELECT jsonb_array_elements_text(COALESCE(metadata->'proposal_keys', '[]'::jsonb)) AS key FROM contract_lifecycle_events
			WHERE holding_id = $1 AND contract_id = ANY($2::uuid[]) AND event_type = '${RENEWAL_PROPOSED}'`,
			[holdingId, contractIds]
		)) as Row[];

		return new Set((rows ?? []).map((row) => String(row.key)));
	}

	/** Estado de la propuesta de cada clave `ítem:fin` (`open | confirmed | dismissed`); si hay varias gana la abierta. */
	private async proposalStates(
		db: Pick<DataSource, 'query'> | QueryRunner,
		holdingId: string,
		contractIds: string[]
	): Promise<Map<string, { event_id: string; status: string }>> {
		const rows = (await db.query(
			`SELECT e.id, COALESCE(e.metadata->>'status', 'open') AS status, k.key
			FROM contract_lifecycle_events e, jsonb_array_elements_text(COALESCE(e.metadata->'proposal_keys', '[]'::jsonb)) AS k(key)
			WHERE e.holding_id = $1 AND e.contract_id = ANY($2::uuid[]) AND e.event_type = '${RENEWAL_PROPOSED}'
			ORDER BY e.created_at`,
			[holdingId, contractIds]
		)) as Row[];
		const states = new Map<string, { event_id: string; status: string }>();

		for (const row of rows ?? []) {
			const key = String(row.key);

			if (states.get(key)?.status === 'open') continue;
			states.set(key, { event_id: String(row.id), status: toText(row.status) ?? 'open' });
		}

		return states;
	}

	/** Claves `contrato:fin:escalón` ya avisadas (alertas crecientes). */
	private async reminderKeys(db: Pick<DataSource, 'query'> | QueryRunner, holdingId: string, contractIds: string[]): Promise<Set<string>> {
		const rows = (await db.query(
			`SELECT metadata->>'reminder_key' AS key FROM contract_lifecycle_events
			WHERE holding_id = $1 AND contract_id = ANY($2::uuid[]) AND event_type = '${RENEWAL_REMINDER}'`,
			[holdingId, contractIds]
		)) as Row[];

		return new Set((rows ?? []).map((row) => toText(row.key)).filter((key): key is string => Boolean(key)));
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
			severity?: 'info' | 'warning' | 'error';
			title: string;
			message: string;
			recommendation?: string;
			escalation_step?: number;
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
				recommendation: 'Abre el contrato y revisa la tarjeta en el Resumen.',
				resource_type: 'contract',
				metadata: { ...input.action_payload },
				// Destinatarios: las suscripciones del tipo (semilla N3: Administrador y Finanzas), ya no solo super admins.
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
