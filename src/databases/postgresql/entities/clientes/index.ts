/**
 * Espejo del módulo `clientes`: 6 tablas de `public` SIN entity previa en el repo, generadas desde prod en vivo.
 * Promovidas a `.entity.ts` (las carga el glob de database.module.ts): 6. Apagadas (`*.espejo.ts`, fuera del glob): 0.
 * Las tablas que ya tenían entity no se duplican: ver README.md.
 */
export { ClientDocument } from './client-document.entity';
export { ClientEntityTaxIdNormalizationConflict } from './client-entity-tax-id-normalization-conflict.entity';
export { CompanyAccountMapping } from './company-account-mapping.entity';
export { CompanyBankAccount } from './company-bank-account.entity';
export { CompanyLegalDocument } from './company-legal-document.entity';
export { ContactPreference } from './contact-preference.entity';
