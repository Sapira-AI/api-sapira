/**
 * Espejo del módulo `facturacion`: 13 tablas de `public` SIN entity previa en el repo, generadas desde prod en vivo.
 * Promovidas a `.entity.ts` (las carga el glob de database.module.ts): 13. Apagadas (`*.espejo.ts`, fuera del glob): 0.
 * Las tablas que ya tenían entity no se duplican: ver README.md.
 */
export { BillingReference } from './billing-reference.entity';
export { InvoiceAdjustment } from './invoice-adjustment.entity';
export { InvoiceCollectionLog } from './invoice-collection-log.entity';
export { InvoiceCollectionSettings } from './invoice-collection-settings.entity';
export { InvoiceEmail } from './invoice-email.entity';
export { InvoicePayment } from './invoice-payment.entity';
export { InvoiceReferenceLink } from './invoice-reference-link.entity';
export { InvoiceReschedule } from './invoice-reschedule.entity';
export { InvoiceRestructureLog } from './invoice-restructure-log.entity';
export { OverdueCheckLog } from './overdue-check-log.entity';
export { PeriodGuardWarning } from './period-guard-warning.entity';
export { Quantity } from './quantity.entity';
export { ReferenceRequest } from './reference-request.entity';
