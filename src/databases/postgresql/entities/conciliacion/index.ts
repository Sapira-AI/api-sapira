/**
 * Espejo del módulo `conciliacion`: 3 tablas de `public` SIN entity previa en el repo, generadas desde prod en vivo.
 * APAGADAS en runtime (`*.espejo.ts`: el glob de entities de database.module.ts solo carga `*.entity.ts`). Las tablas que ya tenían entity no se duplican: ver README.md.
 */
export { BankColumnMapping } from './bank-column-mapping.espejo';
export { BankMovement } from './bank-movement.espejo';
export { BankUploadBatch } from './bank-upload-batch.espejo';
