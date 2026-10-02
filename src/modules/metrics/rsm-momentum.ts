/**
 * Regla única del "pendiente de renovar" en `revenue_schedule_monthly` (spec revenue §1.2 y D-CTR-1, decisión S5-3): las filas
 * `momentum = 'PENDING_RENEWAL'` (`apply_pending_renewal_tail`: ítems vencidos sin renovar ni baja) no son MRR; se muestran aparte, nunca
 * sumadas. Una sola definición para Métricas y Contratos (Contratos la importa de aquí). Archivo puro, sin dependencias: no crea ciclos.
 */

/** `momentum` de las filas de "pendiente de renovar". */
export const PENDING = 'PENDING_RENEWAL';

/** Filtro SQL de las filas que SÍ son MRR para otro alias de `revenue_schedule_monthly` (p. ej. el mes anterior del detalle). */
export const notPendingRenewalOf = (alias: string) => `${alias}.momentum IS DISTINCT FROM '${PENDING}'`;

/** Filtro SQL (alias `r` de `revenue_schedule_monthly`) de las filas que SÍ son MRR. */
export const NOT_PENDING_RENEWAL = notPendingRenewalOf('r');
