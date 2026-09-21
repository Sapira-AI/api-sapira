/**
 * Espejo del módulo `legacy`: 4 tablas de `public` SIN entity previa en el repo, generadas desde prod en vivo.
 * Promovidas a `.entity.ts` (las carga el glob de database.module.ts): 4. Apagadas (`*.espejo.ts`, fuera del glob): 0.
 * Las tablas que ya tenían entity no se duplican: ver README.md.
 */
export { InvoiceItemsLegacy } from './invoice-items-legacy.entity';
export { InvoiceItemsLegacyMatch } from './invoice-items-legacy-match.entity';
export { InvoicesLegacy } from './invoices-legacy.entity';
export { MrrLegacy } from './mrr-legacy.entity';
