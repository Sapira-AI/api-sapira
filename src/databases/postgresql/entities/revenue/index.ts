/**
 * Espejo del módulo `revenue`: 5 tablas de `public` SIN entity previa en el repo, generadas desde prod en vivo.
 * APAGADAS en runtime (`*.espejo.ts`: el glob de entities de database.module.ts solo carga `*.entity.ts`). Las tablas que ya tenían entity no se duplican: ver README.md.
 */
export { AccountingPeriodCutoff } from './accounting-period-cutoff.espejo';
export { AccountingPeriodEvent } from './accounting-period-event.espejo';
export { MrrAdjustment } from './mrr-adjustment.espejo';
export { RevenueRule } from './revenue-rule.espejo';
export { RevenueScheduleMonthly } from './revenue-schedule-monthly.espejo';
