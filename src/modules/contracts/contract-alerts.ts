/**
 * Cierre automático de las alertas de Contratos (Notificaciones v2, `docs/v2-rediseno/contrato-api-notificaciones.md` §5). Después de un
 * cambio del contrato (`ContractChangesService.apply`: renovar, dar de baja, terminar, aplicar un pacto) o de omitir/cancelar un pacto, se
 * revisan las alertas abiertas del contrato contra el dato actual y se cierran las que ya no aplican:
 * - `contract_renewal_reminder` (una por contrato y fin): cuando ya no queda ningún ítem sin decisión con ese fin.
 * - `contract_renewal_proposed`: cuando la propuesta dejó de estar abierta (confirmada u omitida).
 * - `contract_scheduled_change_due` (una por pacto y fecha): cuando el pacto ya no está programado o su próxima fecha avanzó.
 * Nunca lanza: un fallo deja un aviso en el log y no deshace el cambio (ya confirmado).
 */
import type { AppNotification } from '@/databases/postgresql/entities/automatizaciones-ia/app-notification.entity';

import {
	RENEWAL_PROPOSED,
	RENEWAL_PROPOSED_NOTIFICATION_TYPE,
	RENEWAL_REMINDER_NOTIFICATION_TYPE,
	SCHEDULED_CHANGE_DUE_NOTIFICATION_TYPE,
} from './contract-renewals';

type Row = Record<string, unknown>;
type Queryable = { query: (sql: string, params?: unknown[]) => Promise<unknown> };

export interface ContractAlertsNotifier {
	listOpen(holdingId: string, type: string, resourceId?: string): Promise<AppNotification[]>;
	resolveOpen(holdingId: string, criteria: { ids?: string[] }): Promise<number>;
}

/** Nombre de cada tipo de pacto en textos para personas (eventos y notificaciones). */
export const PACT_KIND_LABELS: Record<string, string> = {
	percent_uplift: 'reajuste %',
	index: 'reajuste por índice',
	new_unit_price: 'precio nuevo',
	quantity: 'cantidad nueva',
	term: 'plazo nuevo',
	billing_frequency: 'frecuencia nueva',
};

/** Último segmento de la clave (`…:<fecha>`). */
const keyTail = (key: string | null | undefined) => (key ? (key.split(':').pop() ?? '') : '');
const payloadText = (notification: AppNotification, field: string) => {
	const value = (notification.action_payload ?? {})[field];

	return typeof value === 'string' ? value : null;
};

/** Fines con ítems recurrentes que siguen sin decisión (sin renovar ni baja), con la misma regla del job de alertas. */
async function pendingEndDates(db: Queryable, holdingId: string, contractId: string): Promise<Set<string>> {
	const rows = (await db.query(
		`SELECT DISTINCT ci.end_date::text AS end_date
		FROM contract_items ci
		JOIN contracts c ON c.id = ci.contract_id AND c.holding_id = ci.holding_id
		WHERE ci.contract_id = $1 AND ci.holding_id = $2 AND c.deleted_at IS NULL
			AND ci.is_recurring = true AND ci.renewed_by_item_id IS NULL AND ci.churn_date IS NULL
			AND COALESCE(ci.categoria, '') NOT IN ('CHURN', 'DOWNSELL')
			AND NOT (ci.related_item_id IS NOT NULL AND COALESCE(ci.categoria, '') = 'UPSELL')
			AND ci.end_date IS NOT NULL`,
		[contractId, holdingId]
	)) as Row[];

	return new Set((rows ?? []).map((row) => String(row.end_date).slice(0, 10)));
}

/** Ids de las alertas abiertas del contrato que ya no aplican. Puro respecto de la base: recibe las lecturas. */
export async function staleContractAlertIds(
	db: Queryable,
	notifier: Pick<ContractAlertsNotifier, 'listOpen'>,
	holdingId: string,
	contractId: string
): Promise<string[]> {
	const [reminders, proposals, pacts] = await Promise.all([
		notifier.listOpen(holdingId, RENEWAL_REMINDER_NOTIFICATION_TYPE, contractId),
		notifier.listOpen(holdingId, RENEWAL_PROPOSED_NOTIFICATION_TYPE, contractId),
		notifier.listOpen(holdingId, SCHEDULED_CHANGE_DUE_NOTIFICATION_TYPE, contractId),
	]);
	const stale: string[] = [];

	if (reminders.length) {
		const pending = await pendingEndDates(db, holdingId, contractId);

		for (const reminder of reminders) if (!pending.has(keyTail(reminder.deduplication_key))) stale.push(reminder.id);
	}

	const eventIds = proposals.map((proposal) => payloadText(proposal, 'event_id')).filter((id): id is string => Boolean(id));

	if (proposals.length) {
		const rows = eventIds.length
			? ((await db.query(
					`SELECT id::text AS id FROM contract_lifecycle_events
					WHERE holding_id = $1 AND id = ANY($2::uuid[]) AND event_type = '${RENEWAL_PROPOSED}' AND event_status = 'Pending'
						AND COALESCE(metadata->>'status', 'open') = 'open'`,
					[holdingId, eventIds]
				)) as Row[])
			: [];
		const open = new Set((rows ?? []).map((row) => String(row.id)));

		for (const proposal of proposals) {
			const eventId = payloadText(proposal, 'event_id');

			if (!eventId || !open.has(eventId)) stale.push(proposal.id);
		}
	}

	if (pacts.length) {
		const pactIds = pacts.map((pact) => payloadText(pact, 'scheduled_change_id')).filter((id): id is string => Boolean(id));
		const rows = pactIds.length
			? ((await db.query(
					`SELECT id::text AS id, status,
						(CASE WHEN trigger = 'on_date' THEN effective_date ELSE COALESCE(next_effective_date, anchor_date) END)::text AS due_date
					FROM contract_scheduled_changes WHERE holding_id = $1 AND id = ANY($2::uuid[])`,
					[holdingId, pactIds]
				)) as Row[])
			: [];
		const byId = new Map((rows ?? []).map((row) => [String(row.id), row]));

		for (const pact of pacts) {
			const row = byId.get(payloadText(pact, 'scheduled_change_id') ?? '');
			const notifiedDue = keyTail(pact.deduplication_key);

			if (!row || row.status !== 'scheduled' || String(row.due_date ?? '').slice(0, 10) > notifiedDue) stale.push(pact.id);
		}
	}

	return stale;
}

/** Cierra las alertas del contrato que ya no aplican. Devuelve cuántas cerró; nunca lanza. */
export async function reconcileContractAlerts(
	db: Queryable,
	notifier: ContractAlertsNotifier | undefined,
	holdingId: string,
	contractId: string,
	onError: (message: string) => void = () => undefined
): Promise<number> {
	if (!notifier) return 0;
	try {
		const ids = await staleContractAlertIds(db, notifier, holdingId, contractId);

		return ids.length ? await notifier.resolveOpen(holdingId, { ids }) : 0;
	} catch (error) {
		onError(`No se pudieron cerrar las alertas del contrato ${contractId}: ${error instanceof Error ? error.message : String(error)}`);
		return 0;
	}
}
