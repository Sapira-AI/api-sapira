/**
 * Espejo del módulo `cotizaciones-catalogo`: 1 tablas de `public` SIN entity previa en el repo, generadas desde prod en vivo.
 * APAGADAS en runtime (`*.espejo.ts`: el glob de entities de database.module.ts solo carga `*.entity.ts`). Las tablas que ya tenían entity no se duplican: ver README.md.
 */
export { QuoteAttachment } from './quote-attachment.espejo';
