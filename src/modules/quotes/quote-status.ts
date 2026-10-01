/**
 * Cotizaciones v2 — estados, transiciones y catálogo de tipo de negocio (`docs/v2-rediseno/mapa-v2-cotizaciones.md` §5a,
 * Q-A1, Q-A2, Q-A9). Todo puro: sin base ni Nest. Una sola definición del estado mostrado: `deriveQuoteStatus()` (TS, con
 * pruebas) y `QUOTE_STATUS_LATERAL` (SQL para lista, conteos y KPIs). Si cambias una, cambia la otra.
 *
 * - **Guardado**: `quotes.quote_stage_id` + `quote_stages.kind` (`draft · sent · signed · lost · contract_created`). Las etapas
 *   intermedias del holding (Negociando, Modificada…) llevan el `kind` que el holding configure; sin `kind` cuentan como `draft`.
 * - **Mostrado** (calculado al leer, nunca guardado): `contract_created` si existe un contrato vigente con `quote_id` o un evento
 *   con `origin.quote_id` (aunque el holding no tenga la etapa) · `lost` · `signed` · `expired` (`kind ∈ {draft, sent}` y
 *   `valid_until < hoy`) · `sent` · `draft`.
 */

export const QUOTE_STAGE_KINDS = ['draft', 'sent', 'signed', 'lost', 'contract_created'] as const;
export type QuoteStageKind = (typeof QUOTE_STAGE_KINDS)[number];

/**
 * Kinds que solo admiten una etapa por holding (UNIQUE parcial `idx_quote_stages_holding_kind_unique`). `contract_created` admite
 * varias (Domi 29-09): "Contrato creado" y "Procesada previamente" conviven en SimpliRoute y las dos cuentan como contrato creado.
 */
export const SINGLE_STAGE_KINDS: readonly QuoteStageKind[] = ['signed', 'lost'];

export const QUOTE_DERIVED_STATUSES = ['draft', 'sent', 'expired', 'signed', 'contract_created', 'lost'] as const;
export type QuoteDerivedStatus = (typeof QUOTE_DERIVED_STATUSES)[number];

export const QUOTE_STATUS_LABELS: Record<QuoteDerivedStatus, string> = {
	draft: 'Borrador',
	sent: 'Enviada',
	expired: 'Vencida',
	signed: 'Firmada',
	contract_created: 'Contrato creado',
	lost: 'Perdida',
};

/** Kinds en los que la cotización se edita y se elimina (§5a). */
export const EDITABLE_STAGE_KINDS: readonly QuoteStageKind[] = ['draft', 'sent'];
export const DELETABLE_STAGE_KINDS: readonly QuoteStageKind[] = ['draft', 'sent', 'lost'];

/** Etapas v2 que se siembran en un holding nuevo (mismo set que `functions/create_default_quote_stages_for_holding.sql`). */
export const DEFAULT_QUOTE_STAGES: ReadonlyArray<{ name: string; kind: QuoteStageKind; color: string; is_system_stage: boolean }> = [
	{ name: 'Borrador', kind: 'draft', color: '#94a3b8', is_system_stage: true },
	{ name: 'Enviada', kind: 'sent', color: '#3b82f6', is_system_stage: true },
	{ name: 'Firmada', kind: 'signed', color: '#10b981', is_system_stage: true },
	{ name: 'Perdida', kind: 'lost', color: '#ef4444', is_system_stage: true },
	{ name: 'Contrato creado', kind: 'contract_created', color: '#6366f1', is_system_stage: true },
];

/**
 * Nombre canónico de la etapa "Contrato creado" (seed v2 y búsqueda por nombre en Contratos). La migración **no** la crea en los holdings
 * que no la tienen (decisión Domi 29-09): sin etapa, la cotización se muestra "Contrato creado" por el vínculo y se queda donde está.
 */
export const CONTRACT_CREATED_STAGE_NAME = 'Contrato creado';

/**
 * `kind` a partir del nombre de la etapa (mismo `ILIKE` que el backfill de la migración `1790650000000-QuotesV2`):
 * `contrato creado` y `procesada/procesado previamente` → contract_created (Domi 29-09: cotizaciones procesadas en el flujo anterior
 * fuera de Sapira; el contrato nació con esa cotización) · `%firmad%` → signed · `%perdid%` / `%rechaz%` → lost · `%enviad%` → sent ·
 * resto → draft.
 */
export function stageKindFromName(name: string | null | undefined): QuoteStageKind {
	const lower = (name ?? '').trim().toLowerCase();

	if (!lower) return 'draft';
	if (lower.includes('contrato creado') || lower.includes('procesada previamente') || lower.includes('procesado previamente'))
		return 'contract_created';
	if (lower.includes('firmad')) return 'signed';
	if (lower.includes('perdid') || lower.includes('rechaz')) return 'lost';
	if (lower.includes('enviad')) return 'sent';

	return 'draft';
}

export const isStageKind = (value: unknown): value is QuoteStageKind => (QUOTE_STAGE_KINDS as readonly string[]).includes(String(value));

export interface QuoteStatusInput {
	/** `quote_stages.kind` de la etapa guardada; null = etapa sin kind (cuenta como draft). */
	kind: QuoteStageKind | string | null | undefined;
	/** `YYYY-MM-DD` o null. */
	valid_until: string | null | undefined;
	/** Hay un contrato vigente con `quote_id` o un evento de contrato con `origin.quote_id`. */
	has_contract: boolean;
}

/** Espejo TS del lateral SQL. `today` es `YYYY-MM-DD`. */
export function deriveQuoteStatus(input: QuoteStatusInput, today: string): QuoteDerivedStatus {
	const kind: QuoteStageKind = isStageKind(input.kind) ? input.kind : 'draft';

	if (input.has_contract || kind === 'contract_created') return 'contract_created';
	if (kind === 'lost') return 'lost';
	if (kind === 'signed') return 'signed';
	if (input.valid_until && input.valid_until < today) return 'expired';

	return kind === 'sent' ? 'sent' : 'draft';
}

/**
 * `LEFT JOIN LATERAL … ds` con `ds.kind` (guardado, `draft` si la etapa no tiene) y `ds.derived_status`. Necesita `q` (quotes),
 * `qs` (quote_stages), `ct` (contrato creado, lateral `QUOTE_CONTRACT_LATERAL`) y `ap` (contrato al que se aplicó) en el FROM.
 * `today` es el placeholder de la fecha (`$2`…). Mismas reglas que `deriveQuoteStatus`.
 */
export const quoteStatusLateral = (today: string) => `LEFT JOIN LATERAL (
	SELECT COALESCE(qs.kind, 'draft') AS kind,
		CASE
			WHEN ct.id IS NOT NULL OR ap.contract_id IS NOT NULL OR qs.kind = 'contract_created' THEN 'contract_created'
			WHEN qs.kind = 'lost' THEN 'lost'
			WHEN qs.kind = 'signed' THEN 'signed'
			WHEN q.valid_until IS NOT NULL AND q.valid_until < ${today}::date THEN 'expired'
			WHEN qs.kind = 'sent' THEN 'sent'
			ELSE 'draft'
		END AS derived_status
) ds ON true`;

/**
 * Vínculos con Contratos (§3): `ct` = contrato **creado** desde la cotización (`contracts.quote_id`, no borrado); `ap` = contrato
 * al que se **aplicó** (`POST /contracts/:id/changes` con `origin.type = quote`, `contract_lifecycle_events.metadata.origin.quote_id`).
 */
export const QUOTE_CONTRACT_LATERAL = `LEFT JOIN LATERAL (
	SELECT c.id, c.contract_number, c.status
	FROM contracts c
	WHERE c.quote_id = q.id AND c.holding_id = q.holding_id AND c.deleted_at IS NULL
	ORDER BY c.created_at
	LIMIT 1
) ct ON true
LEFT JOIN LATERAL (
	SELECT e.contract_id, e.id AS event_id, e.effective_date, c.contract_number, c.status
	FROM contract_lifecycle_events e
	JOIN contracts c ON c.id = e.contract_id AND c.deleted_at IS NULL
	WHERE e.holding_id = q.holding_id AND e.metadata->'origin'->>'quote_id' = q.id::text
	ORDER BY e.created_at
	LIMIT 1
) ap ON true`;

// ------------------------------------------------------------------ transiciones (§5a)

export const QUOTE_TRANSITION_ERRORS = [
	'invalid_transition',
	'quote_has_contract',
	'items_incomplete',
	'booking_date_required',
	'stage_kind_mismatch',
	'quote_signed_locked',
	'quote_not_deletable',
	'item_linked_to_contract',
] as const;
export type QuoteTransitionError = (typeof QUOTE_TRANSITION_ERRORS)[number];

/** Tipos de evento de `quote_events` (§8). */
export const QUOTE_EVENT_TYPES = [
	'CREATED',
	'UPDATED',
	'SENT',
	'SIGNED',
	'LOST',
	'REOPENED',
	'STAGE_CHANGED',
	'DUPLICATED_FROM',
	'CONTRACT_CREATED',
	'APPLIED_TO_CONTRACT',
	'DELETED',
] as const;
export type QuoteEventType = (typeof QUOTE_EVENT_TYPES)[number];

/**
 * Transiciones válidas entre kinds: `draft ⇄ sent` · `draft|sent → signed` · `draft|sent → lost` · `signed → sent` (destrabar) ·
 * `signed → lost` · `lost → draft` (reabrir; Supuesto). Nada sale de `contract_created` ni entra a mano. Mover entre dos etapas
 * del mismo kind (Recepcionado → Negociando) vale en `draft` y `sent`. Con contrato vinculado nada se mueve.
 */
export function transitionError(from: QuoteStageKind, to: QuoteStageKind, hasContract: boolean): QuoteTransitionError | null {
	if (hasContract) return 'quote_has_contract';
	if (from === 'contract_created' || to === 'contract_created') return 'invalid_transition';
	const allowed: Record<Exclude<QuoteStageKind, 'contract_created'>, readonly QuoteStageKind[]> = {
		draft: ['draft', 'sent', 'signed', 'lost'],
		sent: ['draft', 'sent', 'signed', 'lost'],
		signed: ['sent', 'lost'],
		lost: ['draft'],
	};

	return allowed[from].includes(to) ? null : 'invalid_transition';
}

/** Evento que deja una transición (`STAGE_CHANGED` cuando el kind no cambia). */
export function transitionEventType(from: QuoteStageKind, to: QuoteStageKind): QuoteEventType {
	if (from === to) return 'STAGE_CHANGED';
	if (to === 'signed') return 'SIGNED';
	if (to === 'lost') return 'LOST';
	if (to === 'sent') return from === 'signed' || from === 'lost' ? 'REOPENED' : 'SENT';

	return 'REOPENED';
}

// ------------------------------------------------------------------ tipo de negocio (Q-A9)

export const QUOTE_TYPE_CODES = ['new_business', 'upsell', 'cross_sell', 'downsell', 'renewal', 'renegotiation', 'reactivation'] as const;
export type QuoteTypeCode = (typeof QUOTE_TYPE_CODES)[number];

export const QUOTE_TYPE_LABELS: Record<QuoteTypeCode, string> = {
	new_business: 'Nuevo negocio',
	upsell: 'Upsell',
	cross_sell: 'Cross-sell',
	downsell: 'Downsell',
	renewal: 'Renovación',
	renegotiation: 'Renegociación',
	reactivation: 'Reactivación',
};

/**
 * Grafías reales de `quotes.quote_type` (QA/prod: Upselling, Upsell, New Business, NewBusiness, Nuevo cliente, Downselling, Renewal,
 * Despliegue…) → código. Mismo criterio que `AssignToContractModal` (`down`/`cross`, el resto upsell) más nuevo negocio, renovación,
 * renegociación y reactivación por raíz. `Despliegue` cuenta como nuevo negocio (Supuesto).
 */
export function normalizeQuoteType(value: string | null | undefined): QuoteTypeCode | null {
	const raw = (value ?? '').trim().toLowerCase();

	if (!raw) return null;
	const compact = raw.replace(/[\s_-]+/g, '');

	if ((QUOTE_TYPE_CODES as readonly string[]).includes(raw)) return raw as QuoteTypeCode;
	if (compact.includes('down')) return 'downsell';
	if (compact.includes('cross')) return 'cross_sell';
	if (compact.includes('upsel')) return 'upsell';
	if (compact.includes('renov') || compact.includes('renew')) return 'renewal';
	if (compact.includes('renegoc')) return 'renegotiation';
	if (compact.includes('reactiv')) return 'reactivation';
	if (compact.includes('new') || compact.includes('nuevo') || compact.includes('despliegue')) return 'new_business';

	return null;
}

/** Valores guardados que caen en cada código (para filtrar `quote_type` sobre datos viejos y nuevos). */
export const QUOTE_TYPE_SYNONYMS: Record<QuoteTypeCode, readonly string[]> = {
	new_business: ['new_business', 'New Business', 'NewBusiness', 'Nuevo cliente', 'Nuevo negocio', 'Despliegue'],
	upsell: ['upsell', 'Upsell', 'Upselling'],
	cross_sell: ['cross_sell', 'Cross-sell', 'Cross sell', 'Crossell', 'Crosselling'],
	downsell: ['downsell', 'Downsell', 'Downselling'],
	renewal: ['renewal', 'Renewal', 'Renovación', 'Renovacion'],
	renegotiation: ['renegotiation', 'Renegociación', 'Renegociacion'],
	reactivation: ['reactivation', 'Reactivación', 'Reactivacion'],
};

export const quoteTypeLabel = (value: string | null | undefined): string | null => {
	const code = normalizeQuoteType(value);

	return code ? QUOTE_TYPE_LABELS[code] : value ? String(value) : null;
};

/** Formato del correlativo por holding para cotizaciones manuales (§8, Supuesto de formato). */
export const QUOTE_NUMBER_PREFIX = 'COT';
export const quoteNumberPattern = (year: number) => `^${QUOTE_NUMBER_PREFIX}-${year}-(\\d{1,6})$`;
export const formatQuoteNumber = (year: number, correlative: number) => `${QUOTE_NUMBER_PREFIX}-${year}-${String(correlative).padStart(4, '0')}`;
