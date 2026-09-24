/**
 * Estado del cliente comercial calculado desde su relación comercial (decisión Domi 24-09-2026), en vez del campo
 * manual `clients.status`, que casi nadie actualiza (en prod, 1.174 "Activo" sin ningún contrato). El campo
 * manual se mantiene en la base porque lo usa el front viejo; el front nuevo muestra y filtra este.
 *
 * - `active`: al menos un contrato Activo vigente (fin ≥ hoy o sin fin) sin término confirmado, o una suscripción
 *   (Stripe) activa o con pago atrasado que no se cancela al fin del período.
 * - `ending` ("Por terminar"): sigue vigente, pero todo lo vigente tiene término confirmado (contrato con
 *   `churn_date` futura o suscripción con `cancel_at_period_end`).
 * - `paused`: reservado para los contratos en pausa (función pendiente, ver auditoría de contratos S3); hoy no aplica.
 * - `onboarding` ("En implementación"): sin nada vigente, con algún contrato "En revisión".
 * - `churned`: tuvo relación comercial (contratos, suscripciones, MRR legacy o facturas emitidas) y ya no tiene
 *   nada vigente.
 * - `prospect`: nunca tuvo contrato ni suscripción (puede tener cotizaciones).
 *
 * Las facturas no definen el estado: un cliente en churn puede seguir con deuda (eso se muestra aparte).
 */
export const CLIENT_LIFECYCLE_STATUSES = ['active', 'ending', 'paused', 'onboarding', 'churned', 'prospect'] as const;
export type ClientLifecycleStatus = (typeof CLIENT_LIFECYCLE_STATUSES)[number];

/**
 * Expresión SQL del estado para el cliente con alias `alias` (p. ej. `cl`). Usa `CURRENT_DATE`. Los alias internos
 * llevan prefijo `lc_` para no chocar con los de la consulta que la incluye (con `c` como alias del cliente, una
 * subconsulta `FROM contracts c` se comparaba consigo misma y todo salía Churn).
 */
export function clientLifecycleSql(alias: string): string {
	// Vigente: Activo, sin fin pasado y sin churn ya ocurrido (un churn pasado con estado sin actualizar ya terminó).
	const vigente = `lc_ct.client_id = ${alias}.id AND lc_ct.status = 'Activo' AND (lc_ct.contract_end_date IS NULL OR lc_ct.contract_end_date >= CURRENT_DATE)
		AND (lc_ct.churn_date IS NULL OR lc_ct.churn_date >= CURRENT_DATE)`;
	const subVigente = `lc_sub.client_id = ${alias}.id AND lc_sub.status IN ('active', 'past_due')`;

	return `CASE
		WHEN EXISTS (SELECT 1 FROM contracts lc_ct WHERE ${vigente} AND lc_ct.churn_date IS NULL)
			OR EXISTS (SELECT 1 FROM subscriptions lc_sub WHERE ${subVigente} AND COALESCE(lc_sub.cancel_at_period_end, false) = false) THEN 'active'
		WHEN EXISTS (SELECT 1 FROM contracts lc_ct WHERE ${vigente})
			OR EXISTS (SELECT 1 FROM subscriptions lc_sub WHERE ${subVigente}) THEN 'ending'
		WHEN EXISTS (SELECT 1 FROM contracts lc_ct WHERE lc_ct.client_id = ${alias}.id AND lc_ct.status = 'En revisión') THEN 'onboarding'
		WHEN EXISTS (SELECT 1 FROM contracts lc_ct WHERE lc_ct.client_id = ${alias}.id)
			OR EXISTS (SELECT 1 FROM subscriptions lc_sub WHERE lc_sub.client_id = ${alias}.id)
			OR EXISTS (SELECT 1 FROM mrr_legacy lc_ml WHERE lc_ml.client_id = ${alias}.id)
			OR EXISTS (SELECT 1 FROM invoices lc_inv WHERE lc_inv.client_id = ${alias}.id AND lc_inv.is_active AND lc_inv.status NOT IN ('Por Emitir', 'Cancelada')) THEN 'churned'
		ELSE 'prospect'
	END`;
}
