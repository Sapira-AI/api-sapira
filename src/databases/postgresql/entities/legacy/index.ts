/**
 * Espejo del módulo `legacy`: 4 tablas de `public` SIN entity previa en el repo, generadas desde prod en vivo.
 * APAGADAS en runtime (`*.espejo.ts`: el glob de entities de database.module.ts solo carga `*.entity.ts`). Las tablas que ya tenían entity no se duplican: ver README.md.
 */
export { InvoiceItemsLegacy } from './invoice-items-legacy.entity';
export { InvoiceItemsLegacyMatch } from './invoice-items-legacy-match.entity';
export { InvoicesLegacy } from './invoices-legacy.entity';
export { MrrLegacy } from './mrr-legacy.espejo';
