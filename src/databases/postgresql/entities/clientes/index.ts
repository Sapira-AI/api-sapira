/**
 * Espejo del módulo `clientes`: 6 tablas de `public` SIN entity previa en el repo, generadas desde prod en vivo.
 * APAGADAS en runtime (`*.espejo.ts`: el glob de entities de database.module.ts solo carga `*.entity.ts`). Las tablas que ya tenían entity no se duplican: ver README.md.
 */
export { ClientDocument } from './client-document.espejo';
export { ClientEntityTaxIdNormalizationConflict } from './client-entity-tax-id-normalization-conflict.espejo';
export { CompanyAccountMapping } from './company-account-mapping.espejo';
export { CompanyBankAccount } from './company-bank-account.espejo';
export { CompanyLegalDocument } from './company-legal-document.espejo';
export { ContactPreference } from './contact-preference.espejo';
