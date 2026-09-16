/**
 * Espejo del módulo `fx`: 3 tablas de `public` SIN entity previa en el repo, generadas desde prod en vivo.
 * Promovidas a `.entity.ts` (las carga el glob de database.module.ts): 3. Apagadas (`*.espejo.ts`, fuera del glob): 0.
 * Las tablas que ya tenían entity no se duplican: ver README.md.
 */
export { ContractFxPeriodRate } from './contract-fx-period-rate.entity';
export { FxApiSyncLog } from './fx-api-sync-log.entity';
export { HoldingFxPeriodRate } from './holding-fx-period-rate.entity';
