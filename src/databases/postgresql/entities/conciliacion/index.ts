/**
 * Espejo del módulo `conciliacion`: 3 tablas de `public` SIN entity previa en el repo, generadas desde prod en vivo.
 * Promovidas a `.entity.ts` (las carga el glob de database.module.ts): 3. Apagadas (`*.espejo.ts`, fuera del glob): 0.
 * Las tablas que ya tenían entity no se duplican: ver README.md.
 */
export { BankColumnMapping } from './bank-column-mapping.entity';
export { BankMovement } from './bank-movement.entity';
export { BankUploadBatch } from './bank-upload-batch.entity';
