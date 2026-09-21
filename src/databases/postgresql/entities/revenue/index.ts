/**
 * Espejo del módulo `revenue`: 5 tablas de `public` SIN entity previa en el repo, generadas desde prod en vivo.
 * Promovidas a `.entity.ts` (las carga el glob de database.module.ts): 5. Apagadas (`*.espejo.ts`, fuera del glob): 0.
 * Las tablas que ya tenían entity no se duplican: ver README.md.
 */
export { AccountingPeriodCutoff } from './accounting-period-cutoff.entity';
export { AccountingPeriodEvent } from './accounting-period-event.entity';
export { MrrAdjustment } from './mrr-adjustment.entity';
export { RevenueRule } from './revenue-rule.entity';
export { RevenueScheduleMonthly } from './revenue-schedule-monthly.entity';
