/**
 * Auto-renovación v2 con confirmación del holding y aviso de pactos por vencer (spec modificaciones §9.3.5 y §9.3.6, B2-4). Reglas **puras**
 * y lecturas compartidas (lista de propuestas, detalle del contrato) sin inyección: el servicio (`ContractRenewalsService`) y los jobs
 * (`ContractsScheduler`) las usan. **Nunca renueva sola**: el job deja un evento `RENEWAL_PROPOSED` y una notificación; confirmar es
 * `POST /contracts/:id/changes` con `change.type renewal` y `origin { type: 'renewal_proposal', event_id }`.
 */
import { addDays, diffDays } from './billing-engine';

type Row = Record<string, unknown>;
type Queryable = { query: (sql: string, params?: unknown[]) => Promise<unknown> };

/** `contract_lifecycle_events.created_by` es uuid NOT NULL sin FK: el actor "sistema" de los jobs (también `metadata.created_by_system`). */
export const SYSTEM_ACTOR_ID = '00000000-0000-0000-0000-000000000000';
export const RENEWAL_PROPOSED = 'RENEWAL_PROPOSED';
export const RENEWAL_PROPOSAL_DISMISSED = 'RENEWAL_PROPOSAL_DISMISSED';
export const SCHEDULED_CHANGE_DUE = 'SCHEDULED_CHANGE_DUE';
export const AUTO_RENEWAL_JOB = 'contracts-auto-renewal';
export const SCHEDULED_CHANGES_JOB = 'contracts-scheduled-changes';
export const EXTEND_HORIZON_JOB = 'contracts-extend-horizon';
export const RENEWAL_REMINDERS_JOB = 'contracts-renewal-reminders';
export const RENEWAL_REMINDER = 'RENEWAL_REMINDER';
export const RENEWAL_REMINDER_NOTIFICATION_TYPE = 'contract_renewal_reminder';
export const RENEWAL_PROPOSED_NOTIFICATION_TYPE = 'contract_renewal_proposed';
export const SCHEDULED_CHANGE_DUE_NOTIFICATION_TYPE = 'contract_scheduled_change_due';
/** Aviso previo por defecto (`holding_settings.auto_renewal_notice_days`, migración B2: default 30). */
export const DEFAULT_NOTICE_DAYS = 30;
export const RENEWAL_PROPOSAL_CODES = {
	not_found: 'renewal_proposal_not_found',
	not_open: 'renewal_proposal_not_open',
} as const;

const toText = (value: unknown) => (value === null || value === undefined ? null : String(value));
const toNumber = (value: unknown) => Number(value ?? 0) || 0;
const toNullableNumber = (value: unknown) => (value === null || value === undefined ? null : toNumber(value));
const parseJson = (value: unknown) => (typeof value === 'string' ? (JSON.parse(value) as unknown) : value);
const isoTime = (value: unknown) => (value instanceof Date ? value.toISOString() : toText(value));

/** Clave de idempotencia de una propuesta: una por ítem y fin (un fin nuevo tras renovar = propuesta nueva). */
export const proposalKey = (itemId: string, endDate: string) => `${itemId}:${endDate}`;
/** Clave de idempotencia del aviso de un pacto: una por pacto y fecha (cada ocurrencia de `every_n_months` avisa una vez). */
export const dueKey = (pactId: string, dueDate: string) => `${pactId}:${dueDate}`;
/** Límite del aviso: hoy + días de aviso del holding (1–180). */
export const noticeLimit = (today: string, noticeDays: number) =>
	addDays(today, Math.min(180, Math.max(1, Math.round(noticeDays || DEFAULT_NOTICE_DAYS))));

/** Ítem candidato a propuesta (lo que lee el job). */
export interface RenewalCandidate {
	item_id: string;
	contract_id: string;
	contract_number: string | null;
	product_name: string | null;
	end_date: string;
	quantity: number | null;
	unit_price: number | null;
	monthly_price: number | null;
	currency: string | null;
	term_months: number | null;
	billing_frequency: string | null;
}

/**
 * Agrupa los candidatos por contrato sin los ya propuestos (idempotente por ítem y fin) ni los que vencen después del aviso. El job ya filtra
 * en SQL (`auto_renew`, sin renovar ni churn, contrato `active | pending_renewal`); esta función es la regla testeable.
 */
export function groupRenewalCandidates(
	candidates: RenewalCandidate[],
	proposed: Set<string>,
	today: string,
	noticeDays: number
): Map<string, RenewalCandidate[]> {
	const limit = noticeLimit(today, noticeDays);
	const groups = new Map<string, RenewalCandidate[]>();

	for (const candidate of candidates) {
		if (!candidate.end_date || candidate.end_date > limit || proposed.has(proposalKey(candidate.item_id, candidate.end_date))) continue;
		groups.set(candidate.contract_id, [...(groups.get(candidate.contract_id) ?? []), candidate]);
	}

	return groups;
}

/** Pacto en fecha candidato a aviso. */
export interface DueCandidate {
	id: string;
	contract_id: string;
	contract_number: string | null;
	contract_item_id: string | null;
	product_name: string | null;
	trigger: 'on_date' | 'every_n_months';
	kind: string;
	value: number;
	due_date: string;
	index_code: string | null;
}

/** Pactos `on_date` / `every_n_months` con fecha ≤ hoy + aviso, sin aviso previo para esa fecha (idempotente por pacto y fecha). */
export function dueScheduledChanges(candidates: DueCandidate[], notified: Set<string>, today: string, noticeDays: number): DueCandidate[] {
	const limit = noticeLimit(today, noticeDays);

	return candidates.filter((pact) => pact.due_date && pact.due_date <= limit && !notified.has(dueKey(pact.id, pact.due_date)));
}

// ---------------------------------------------------------------- alertas crecientes antes del vencimiento (S2-1 / S5-4, 7b)

/**
 * Escalera por defecto después del primer aviso (días antes del fin; 0 = el día del fin) y frecuencia por defecto vencido sin decisión.
 * Desde la ronda 4 de Configuración son preferencias del holding (`holding_settings.renewal_reminder_days` /
 * `renewal_overdue_every_days`, `loadHoldingPreferences`); estos valores son sus defaults.
 */
export const REMINDER_LADDER = [60, 30, 15, 7, 0] as const;
export const OVERDUE_REMINDER_EVERY_DAYS = 7;

/**
 * Umbrales de aviso del holding: el primero es `holding_settings.auto_renewal_notice_days` (mismo significado: cuántos días antes empieza
 * a avisar) y después los escalones de la escalera del holding menores que él. Ej. (escalera por defecto): 30 → [30, 15, 7, 0];
 * 90 → [90, 60, 30, 15, 7, 0].
 */
export function reminderLadder(noticeDays: number, steps: readonly number[] = REMINDER_LADDER): number[] {
	const first = Math.min(180, Math.max(1, Math.round(noticeDays || DEFAULT_NOTICE_DAYS)));
	const rest = [...new Set(steps.filter((threshold) => Number.isInteger(threshold) && threshold >= 0 && threshold < first))];

	return [first, ...rest.sort((a, b) => b - a)];
}

/**
 * Escalón alcanzado a `daysToEnd` días del fin: el menor umbral ≥ días que faltan (antes del primero, null). Vencido: 0 el primer tramo y
 * luego −N, −2N… con N = `overdueEvery` (un aviso cada N días mientras siga sin decisión; default 7).
 */
export function reminderThreshold(daysToEnd: number, ladder: number[], overdueEvery: number = OVERDUE_REMINDER_EVERY_DAYS): number | null {
	if (daysToEnd < 0) {
		const every = Math.max(1, Math.round(overdueEvery || OVERDUE_REMINDER_EVERY_DAYS));
		const steps = Math.floor(-daysToEnd / every);

		return steps === 0 ? 0 : -every * steps;
	}
	const reached = ladder.filter((threshold) => daysToEnd <= threshold);

	return reached.length ? Math.min(...reached) : null;
}

/** Clave de idempotencia: una alerta por contrato, fin y escalón (un fin nuevo tras renovar parte de cero). */
export const reminderKey = (contractId: string, endDate: string, threshold: number) => `${contractId}:${endDate}:${threshold}`;

/** Tono de la alerta: info lejos del fin, warning en la última quincena, error desde el día del fin (vencido sin decisión). */
export const reminderTone = (threshold: number): 'info' | 'warning' | 'danger' => (threshold <= 0 ? 'danger' : threshold <= 15 ? 'warning' : 'info');

/** Texto corto: "Vence en 12 días · sin decisión", "Vence hoy · sin decisión", "Vencido hace 9 días · sin decisión". */
export function reminderLabel(daysToEnd: number): string {
	if (daysToEnd > 0) return `Vence en ${daysToEnd} ${daysToEnd === 1 ? 'día' : 'días'} · sin decisión`;
	if (daysToEnd === 0) return 'Vence hoy · sin decisión';

	return `Vencido hace ${-daysToEnd} ${daysToEnd === -1 ? 'día' : 'días'} · sin decisión`;
}

/** Ítem recurrente que termina sin decisión (sin renovar ni baja), candidato a alerta. */
export interface ReminderCandidate {
	item_id: string;
	contract_id: string;
	contract_number: string | null;
	product_name: string | null;
	end_date: string;
}

/** Escalera del holding (ronda 4): escalones y frecuencia vencido; sin valores = los de siempre. */
export interface ReminderSchedule {
	steps?: readonly number[];
	overdue_every_days?: number;
}

export interface DueReminder {
	contract_id: string;
	contract_number: string | null;
	end_date: string;
	days_to_end: number;
	threshold_days: number;
	key: string;
	items: Array<{ item_id: string; product_name: string | null; end_date: string }>;
}

/**
 * Alertas que tocan hoy: por contrato, el fin más próximo de sus ítems sin decisión; si ese fin alcanzó un escalón que no se avisó
 * (`sent`, claves `reminderKey`), una alerta con los ítems que terminan ese día. Solo el escalón actual (si el job no corrió, no se ponen al
 * día los anteriores).
 */
export function dueReminders(
	candidates: ReminderCandidate[],
	sent: Set<string>,
	today: string,
	noticeDays: number,
	schedule: ReminderSchedule = {}
): DueReminder[] {
	const ladder = reminderLadder(noticeDays, schedule.steps);
	const byContract = new Map<string, ReminderCandidate[]>();
	const out: DueReminder[] = [];

	for (const candidate of candidates) {
		if (!candidate.end_date) continue;
		byContract.set(candidate.contract_id, [...(byContract.get(candidate.contract_id) ?? []), candidate]);
	}
	for (const [contractId, items] of byContract) {
		const end = items.map((item) => item.end_date).sort()[0];
		const daysToEnd = diffDays(today, end);
		const threshold = reminderThreshold(daysToEnd, ladder, schedule.overdue_every_days);

		if (threshold === null) continue;
		const key = reminderKey(contractId, end, threshold);

		if (sent.has(key)) continue;
		out.push({
			contract_id: contractId,
			contract_number: items[0].contract_number,
			end_date: end,
			days_to_end: daysToEnd,
			threshold_days: threshold,
			key,
			items: items
				.filter((item) => item.end_date === end)
				.map((item) => ({ item_id: item.item_id, product_name: item.product_name, end_date: item.end_date })),
		});
	}

	return out;
}

/** Última alerta vigente del contrato (detalle › tarjeta del Resumen): días al fin recalculados hoy y tono del escalón. */
export interface RenewalReminderView {
	event_id: string;
	end_date: string;
	days_to_end: number;
	threshold_days: number;
	tone: 'info' | 'warning' | 'danger';
	label: string;
	items: Array<{ item_id: string; product_name: string | null; end_date: string }>;
	sent_at: string | null;
}

/**
 * La alerta más reciente del contrato cuyos ítems siguen sin renovar ni baja (si ya se decidió, null). El escalón es el de hoy (no el del
 * envío) para que la tarjeta no quede atrasada entre corridas.
 */
export async function loadRenewalReminder(
	db: Queryable,
	contractId: string,
	holdingId: string,
	today: string,
	noticeDays = DEFAULT_NOTICE_DAYS,
	schedule: ReminderSchedule = {}
): Promise<RenewalReminderView | null> {
	const [row] = ((await db.query(
		`SELECT e.id, e.metadata, e.created_at FROM contract_lifecycle_events e
		WHERE e.contract_id = $1 AND e.holding_id = $2 AND e.event_type = '${RENEWAL_REMINDER}'
		ORDER BY e.created_at DESC LIMIT 1`,
		[contractId, holdingId]
	)) ?? []) as Row[];

	if (!row) return null;
	const metadata = (parseJson(row.metadata) ?? {}) as Row;
	const items = (Array.isArray(metadata.items) ? metadata.items : []) as DueReminder['items'];

	if (!items.length) return null;
	const pendingRows = ((await db.query(
		`SELECT id FROM contract_items WHERE id = ANY($1::uuid[]) AND holding_id = $2 AND renewed_by_item_id IS NULL AND churn_date IS NULL`,
		[items.map((item) => String(item.item_id)), holdingId]
	)) ?? []) as Row[];
	const pending = new Set(pendingRows.map((item) => String(item.id)));
	const open = items.filter((item) => pending.has(String(item.item_id)));

	if (!open.length) return null;
	const end = open.map((item) => item.end_date).sort()[0];
	const daysToEnd = diffDays(today, end);
	const threshold =
		reminderThreshold(daysToEnd, reminderLadder(noticeDays, schedule.steps), schedule.overdue_every_days) ?? toNumber(metadata.threshold_days);

	return {
		event_id: String(row.id),
		end_date: end,
		days_to_end: daysToEnd,
		threshold_days: threshold,
		tone: reminderTone(threshold),
		label: reminderLabel(daysToEnd),
		items: open,
		sent_at: isoTime(row.created_at),
	};
}

/** Ítem de una propuesta (`metadata.items`). */
export interface ProposalItem {
	item_id: string;
	product_name: string | null;
	end_date: string;
	renewal_start: string;
	quantity: number | null;
	unit_price: number | null;
	monthly_price: number | null;
	currency: string | null;
	term_months: number | null;
	billing_frequency: string | null;
}

export const proposalItemOf = (candidate: RenewalCandidate): ProposalItem => ({
	item_id: candidate.item_id,
	product_name: candidate.product_name,
	end_date: candidate.end_date,
	renewal_start: addDays(candidate.end_date, 1),
	quantity: candidate.quantity,
	unit_price: candidate.unit_price,
	monthly_price: candidate.monthly_price,
	currency: candidate.currency,
	term_months: candidate.term_months,
	billing_frequency: candidate.billing_frequency,
});

/** Propuesta abierta tal como la devuelve la API (`GET /contracts/renewal-proposals`, `renewal_proposals[]` del detalle). */
export interface RenewalProposalView {
	event_id: string;
	contract_id: string;
	contract_number: string | null;
	client_name: string | null;
	contract_currency: string | null;
	status: 'open';
	/** Ítems que siguen sin renovar ni baja (los ya resueltos por otra vía no se listan). */
	items: ProposalItem[];
	/** Fin más próximo de los ítems y días que faltan (negativo = vencido sin decisión). */
	end_date: string;
	days_to_end: number;
	/** Inicio de la renovación propuesta (fin + 1). */
	renewal_start: string;
	/** Σ mensual de los ítems (moneda de cada ítem; en un contrato de una moneda = la del contrato). */
	monthly_total: number;
	preview: Record<string, unknown> | null;
	pacts: Array<Record<string, unknown>>;
	created_at: string | null;
}

/** Conteos de la lista (KPI "Renuevan en 30 días"). */
export interface RenewalProposalCounts {
	open: number;
	renew_in_30_days: number;
	overdue: number;
}

/** Arma la vista de una propuesta con los ítems aún pendientes (`pending` = ítems sin renovar ni baja); null si ya no queda ninguno. */
export function proposalView(row: Row, pending: Set<string>, today: string): RenewalProposalView | null {
	const metadata = (parseJson(row.metadata) ?? {}) as Row;
	const items = ((Array.isArray(metadata.items) ? metadata.items : []) as ProposalItem[]).filter((item) => pending.has(String(item.item_id)));

	if (!items.length) return null;
	const end = items.map((item) => item.end_date).sort()[0];

	return {
		event_id: String(row.id),
		contract_id: String(row.contract_id),
		contract_number: toText(row.contract_number),
		client_name: toText(row.client_name),
		contract_currency: toText(row.contract_currency),
		status: 'open',
		items,
		end_date: end,
		days_to_end: diffDays(today, end),
		renewal_start: addDays(end, 1),
		monthly_total: Math.round(items.reduce((sum, item) => sum + toNumber(item.monthly_price), 0) * 100) / 100,
		preview: (metadata.preview as Record<string, unknown> | undefined) ?? null,
		pacts: (Array.isArray(metadata.pacts) ? metadata.pacts : []) as Array<Record<string, unknown>>,
		created_at: isoTime(row.created_at),
	};
}

export function proposalCounts(proposals: RenewalProposalView[]): RenewalProposalCounts {
	return {
		open: proposals.length,
		renew_in_30_days: proposals.filter((proposal) => proposal.days_to_end >= 0 && proposal.days_to_end <= 30).length,
		overdue: proposals.filter((proposal) => proposal.days_to_end < 0).length,
	};
}

/**
 * Propuestas abiertas del holding (o de un contrato): eventos `RENEWAL_PROPOSED` con `metadata.status = open` y al menos un ítem que sigue
 * sin renovar ni baja. Ordenadas por fin más próximo.
 */
export async function loadOpenRenewalProposals(
	db: Queryable,
	holdingId: string,
	today: string,
	contractId: string | null = null
): Promise<RenewalProposalView[]> {
	const rows = ((await db.query(
		`SELECT e.id, e.contract_id, e.metadata, e.created_at, c.contract_number, c.contract_currency, cl.name_commercial AS client_name
		FROM contract_lifecycle_events e
		JOIN contracts c ON c.id = e.contract_id AND c.holding_id = e.holding_id
		LEFT JOIN clients cl ON cl.id = c.client_id
		WHERE e.holding_id = $1 AND e.event_type = '${RENEWAL_PROPOSED}' AND COALESCE(e.metadata->>'status', 'open') = 'open'
			AND c.deleted_at IS NULL AND ($2::uuid IS NULL OR e.contract_id = $2::uuid)
		ORDER BY e.effective_date, e.created_at`,
		[holdingId, contractId]
	)) ?? []) as Row[];

	if (!rows.length) return [];
	const itemIds = [
		...new Set(
			rows.flatMap((row) => {
				const items = ((parseJson(row.metadata) ?? {}) as Row).items;

				return Array.isArray(items) ? (items as Row[]).map((item) => String(item.item_id)) : [];
			})
		),
	];
	const pendingRows = ((await db.query(
		`SELECT id FROM contract_items WHERE id = ANY($1::uuid[]) AND holding_id = $2 AND renewed_by_item_id IS NULL AND churn_date IS NULL`,
		[itemIds, holdingId]
	)) ?? []) as Row[];
	const pending = new Set(pendingRows.map((row) => String(row.id)));

	return rows
		.map((row) => proposalView(row, pending, today))
		.filter((view): view is RenewalProposalView => view !== null)
		.sort((a, b) => a.end_date.localeCompare(b.end_date));
}

/** Resumen compacto del preview de la renovación que se guarda en la propuesta (`metadata.preview`). */
export function compactRenewalPreview(preview: Row | null, error: string | null = null): Record<string, unknown> {
	if (!preview) return { available: false, error };
	const contract = (preview.contract ?? {}) as { before?: Row; after?: Row };
	const items = (preview.items ?? {}) as { added?: unknown[] };
	const invoices = (preview.invoices ?? {}) as { created?: unknown[]; updated?: unknown[] };

	return {
		available: true,
		mrr_before: toNullableNumber(contract.before?.mrr),
		mrr_after: toNullableNumber(contract.after?.mrr),
		end_date_before: toText(contract.before?.end_date),
		end_date_after: toText(contract.after?.end_date),
		items_added: items.added?.length ?? 0,
		invoices_created: invoices.created?.length ?? 0,
		invoices_updated: invoices.updated?.length ?? 0,
		warnings: ((preview.warnings ?? []) as Row[]).map((warning) => warning.code),
		blockers: ((preview.blockers ?? []) as Row[]).map((blocker) => ({ code: blocker.code, message: blocker.message })),
		can_apply: preview.can_apply === true,
	};
}

/** Pausas de los ítems (lectura para el detalle y la lista de ítems, §9.3.3). */
export interface ItemPauseView {
	id: string;
	contract_item_id: string;
	pause_start: string;
	pause_end: string | null;
	extend_term: boolean;
	status: string;
	reason: string | null;
	pause_event_id: string | null;
	resume_event_id: string | null;
	/** ¿Cubre hoy? (pausa no cancelada con `pause_start ≤ hoy ≤ pause_end`, o abierta). */
	active_today: boolean;
}

export async function loadItemPauses(db: Queryable, contractId: string, holdingId: string, today: string): Promise<ItemPauseView[]> {
	const rows = ((await db.query(
		`SELECT id, contract_item_id, pause_start::text AS pause_start, pause_end::text AS pause_end, extend_term, status, reason,
			pause_event_id, resume_event_id
		FROM contract_item_pauses WHERE contract_id = $1 AND holding_id = $2 ORDER BY pause_start, id`,
		[contractId, holdingId]
	)) ?? []) as Row[];

	return rows.map((row) => {
		const start = String(row.pause_start).slice(0, 10);
		const end = toText(row.pause_end)?.slice(0, 10) ?? null;
		const status = toText(row.status) ?? 'active';

		return {
			id: String(row.id),
			contract_item_id: String(row.contract_item_id),
			pause_start: start,
			pause_end: end,
			extend_term: row.extend_term === true,
			status,
			reason: toText(row.reason),
			pause_event_id: toText(row.pause_event_id),
			resume_event_id: toText(row.resume_event_id),
			active_today: status !== 'cancelled' && start <= today && (end === null || end >= today),
		};
	});
}
