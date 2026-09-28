/**
 * Estado **mostrado** del contrato (decisión del dueño, 25-09). `contracts.status` no cambia: solo lo mueven acciones
 * explícitas. El estado que ve la usuaria se deriva al leer, nunca se guarda y no hay cron.
 *
 * - `draft` = En revisión · `cancelled` = Cancelado · `paused` = Pausado (reservado para la acción de pausa S2-12).
 * - `Activo` se mira en sus ítems recurrentes que no son ajustes de baja (`categoria` fuera de CHURN/DOWNSELL) ni tienen
 *   churn. Un ítem "terminó sin decisión" si `end_date < hoy` y nadie lo renovó (`renewed_by_item_id` nulo).
 *   - sin ítems recurrentes → `active`
 *   - alguno terminó sin decisión y ninguno sigue vigente o es futuro → `expired`
 *   - alguno terminó sin decisión (y otro sigue) → `pending_renewal` ("Por renovar")
 *   - si no → `active`
 * - cualquier otro estado → `other`.
 *
 * Una sola definición: `derivedStatusLateral()` (SQL, lista, conteos, KPIs y 360) y `deriveContractStatus()` (espejo
 * TS con pruebas). Si cambias una, cambia la otra.
 */

export const CONTRACT_DERIVED_STATUSES = ['active', 'pending_renewal', 'expired', 'draft', 'paused', 'cancelled'] as const;
export type ContractDerivedStatus = (typeof CONTRACT_DERIVED_STATUSES)[number] | 'other';

export interface StatusItem {
	is_recurring: boolean | null;
	categoria: string | null;
	churn_date: string | null;
	start_date?: string | null;
	end_date: string | null;
	renewed_by_item_id: string | null;
}

/** Espejo TS del lateral SQL. Fechas `YYYY-MM-DD`. */
export function deriveContractStatus(status: string | null | undefined, items: StatusItem[], today: string): ContractDerivedStatus {
	if (status === 'En revisión') return 'draft';
	if (status === 'Cancelado') return 'cancelled';
	if (status === 'Pausado') return 'paused';
	if (status !== 'Activo') return 'other';

	const considered = items.filter(
		(item) => item.is_recurring === true && !['CHURN', 'DOWNSELL'].includes(item.categoria ?? '') && !item.churn_date
	);
	const endedWithoutDecision = considered.filter((item) => item.end_date !== null && item.end_date < today && !item.renewed_by_item_id).length;
	const live = considered.filter((item) => item.end_date === null || item.end_date >= today).length;

	if (endedWithoutDecision === 0) return 'active';

	return live === 0 ? 'expired' : 'pending_renewal';
}

/**
 * `LEFT JOIN LATERAL … ds` con `ds.derived_status`. Necesita `c` (contracts) en el FROM. `today` es el placeholder de la
 * fecha de hoy (`$2`, `$3`…). Mismas reglas que `deriveContractStatus`.
 */
export const derivedStatusLateral = (today: string) => `LEFT JOIN LATERAL (
	SELECT CASE
		WHEN c.status = 'En revisión' THEN 'draft'
		WHEN c.status = 'Cancelado' THEN 'cancelled'
		WHEN c.status = 'Pausado' THEN 'paused'
		WHEN c.status = 'Activo' THEN CASE
			WHEN st.ended_without_decision = 0 THEN 'active'
			WHEN st.live_items = 0 THEN 'expired'
			ELSE 'pending_renewal'
		END
		ELSE 'other'
	END AS derived_status
	FROM (
		SELECT
			COUNT(*) FILTER (WHERE ci.end_date < ${today}::date AND ci.renewed_by_item_id IS NULL) AS ended_without_decision,
			COUNT(*) FILTER (WHERE ci.end_date IS NULL OR ci.end_date >= ${today}::date) AS live_items
		FROM contract_items ci
		WHERE ci.contract_id = c.id AND ci.is_recurring = true
			AND COALESCE(ci.categoria, '') NOT IN ('CHURN', 'DOWNSELL')
			AND ci.churn_date IS NULL
	) st
) ds ON true`;
