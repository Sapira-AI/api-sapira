/**
 * MRR histórico (`mrr_legacy`): **una sola regla de qué filas cuentan**, compartida por Métricas (`MetricsDataService.loadMrrLines`),
 * Dashboard y lista de Clientes (`HoldingMetricsService`), Cliente 360 (`ClientMetricsService.getMrr`) y el módulo `onboarding`
 * (`docs/v2-rediseno/spec-onboarding-y-mrr-historico-v2.md` §3.1, `spec-revenue-y-metricas.md` §1.8).
 *
 * Una fila cuenta si:
 * 1. es recurrente (`is_recurring`);
 * 2. **corte U14**: no está migrada a un contrato en meses ≥ primer mes con MRR de ese contrato (ahí ya cuenta el devengo);
 * 3. no está **quitada** (motivo `duplicate` | `error`). Una línea cerrada (`churn`, "fue baja") cuenta hasta su último mes.
 *
 * El motivo normalizado vive en `mrr_legacy.skip_reason_code` (migración `1791900000000-OnboardingDatosHistoricos`); los textos libres
 * guardados antes (`skip_activation_reason`) se leen sin tocar datos: "duplic" → `duplicate`, "error" → `error`, cualquier otro → `churn`.
 * La columna se lee con `to_jsonb(m) ->> 'skip_reason_code'` para que la API funcione igual antes de aplicar la migración (mismo patrón
 * que `loadHoldingPreferences`).
 */

export const SKIP_REASON_CODES = ['churn', 'duplicate', 'error'] as const;
export type SkipReasonCode = (typeof SKIP_REASON_CODES)[number];
/** Motivos que sacan la fila de todo cálculo ("quitar"). */
export const REMOVED_REASON_CODES: readonly SkipReasonCode[] = ['duplicate', 'error'];

/** Motivo efectivo de una fila marcada `skip_activation` (NULL si no está marcada). Necesita la fila de `mrr_legacy` con alias `m`. */
export function legacySkipCodeSql(alias = 'm'): string {
	return `(CASE WHEN ${alias}.skip_activation THEN COALESCE(to_jsonb(${alias}) ->> 'skip_reason_code',
		CASE WHEN ${alias}.skip_activation_reason ILIKE '%duplic%' THEN 'duplicate' WHEN ${alias}.skip_activation_reason ILIKE '%error%' THEN 'error' ELSE 'churn' END) END)`;
}

/** `true` si la fila está quitada (duplicado o error): no cuenta en nada. Siempre booleano. */
export function legacyRemovedSql(alias = 'm'): string {
	return `(COALESCE(${legacySkipCodeSql(alias)}, '') IN ('duplicate', 'error'))`;
}

/**
 * CTE `first_rsm(contract_id, first_month)`: primer mes con MRR contratado de cada contrato del holding (corte U14). `holdingParam` es
 * el placeholder del holding (`$1`).
 */
export function legacyFirstRsmCte(holdingParam: string): string {
	return `first_rsm AS (
				SELECT r.contract_id, MIN(r.period_month) AS first_month
				FROM revenue_schedule_monthly r
				WHERE r.holding_id = ${holdingParam} AND r.contract_id IS NOT NULL AND r.mrr_period_contracted_contract_ccy > 0
				GROUP BY r.contract_id
			)`;
}

/** JOIN de una fila `m` con su primer mes de contrato (`f.first_month`), sobre el CTE `first_rsm`. */
export const LEGACY_FIRST_RSM_JOIN = 'LEFT JOIN first_rsm f ON f.contract_id = m.migrated_to_contract_id';

/**
 * Condiciones (AND) de fila que cuenta: recurrente, corte U14 y no quitada. Necesita `m` (`mrr_legacy`) y `f` (`first_rsm`).
 */
export function legacyCountedConditions(alias = 'm', first = 'f'): string[] {
	return [
		`COALESCE(${alias}.is_recurring, false) = true`,
		`NOT (${first}.first_month IS NOT NULL AND ${alias}.period_month >= ${first}.first_month)`,
		`NOT ${legacyRemovedSql(alias)}`,
	];
}

/** Motivo efectivo en TS (misma regla que `legacySkipCodeSql`), para filas ya leídas. */
export function skipReasonCodeOf(row: {
	skip_activation?: unknown;
	skip_reason_code?: unknown;
	skip_activation_reason?: unknown;
}): SkipReasonCode | null {
	if (row.skip_activation !== true) return null;
	const stored = typeof row.skip_reason_code === 'string' ? row.skip_reason_code : null;

	if (stored && (SKIP_REASON_CODES as readonly string[]).includes(stored)) return stored as SkipReasonCode;
	const text = String(row.skip_activation_reason ?? '').toLowerCase();

	if (text.includes('duplic')) return 'duplicate';
	if (text.includes('error')) return 'error';

	return 'churn';
}
