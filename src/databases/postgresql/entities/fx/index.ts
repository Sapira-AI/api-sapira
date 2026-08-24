/**
 * Espejo del módulo `fx`: 3 tablas de `public` SIN entity previa en el repo, generadas desde prod en vivo.
 * APAGADAS en runtime (`*.espejo.ts`: el glob de entities de database.module.ts solo carga `*.entity.ts`). Las tablas que ya tenían entity no se duplican: ver README.md.
 */
export { ContractFxPeriodRate } from './contract-fx-period-rate.espejo';
export { FxApiSyncLog } from './fx-api-sync-log.espejo';
export { HoldingFxPeriodRate } from './holding-fx-period-rate.espejo';
