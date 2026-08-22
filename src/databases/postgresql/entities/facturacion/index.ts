/**
 * Espejo del módulo `facturacion`: 14 tablas de `public` SIN entity previa en el repo, generadas desde prod en vivo.
 * APAGADAS en runtime (`*.espejo.ts`: el glob de entities de database.module.ts solo carga `*.entity.ts`). Las tablas que ya tenían entity no se duplican: ver README.md.
 */
export { BillingReference } from './billing-reference.espejo';
export { InvoiceAdjustment } from './invoice-adjustment.espejo';
export { InvoiceCollectionLog } from './invoice-collection-log.espejo';
export { InvoiceCollectionSettings } from './invoice-collection-settings.espejo';
export { InvoiceEmail } from './invoice-email.espejo';
export { InvoicePayment } from './invoice-payment.espejo';
export { InvoiceReferenceLink } from './invoice-reference-link.espejo';
export { InvoiceReschedule } from './invoice-reschedule.espejo';
export { InvoiceRestructureLog } from './invoice-restructure-log.espejo';
export { InvoiceTriggerDebugLog } from './invoice-trigger-debug-log.espejo';
export { OverdueCheckLog } from './overdue-check-log.espejo';
export { PeriodGuardWarning } from './period-guard-warning.espejo';
export { Quantity } from './quantity.espejo';
export { ReferenceRequest } from './reference-request.espejo';
