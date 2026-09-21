/**
 * Espejo del módulo `integraciones/salesforce`: 1 tablas de `public` SIN entity previa en el repo, generadas desde prod en vivo.
 * Promovidas a `.entity.ts` (las carga el glob de database.module.ts): 1. Apagadas (`*.espejo.ts`, fuera del glob): 0.
 * Las tablas que ya tenían entity no se duplican: ver README.md.
 */
export { SalesforceSyncLog } from './salesforce-sync-log.entity';
