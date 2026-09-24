# Benchmark — agrupación, edición y documento fiscal de las facturas de un contrato

> 23-09-2026 · insumo de S4 de [`../auditoria-contratos.md`](../auditoria-contratos.md). Complementa Relvo
> (`invoice_route`), Maxio (grupos), Alguna (roll-up) y Zenskar (draft editable) con Stripe, Chargebee, Zuora, NetSuite,
> Recurly y normas de facturación electrónica de Chile, Perú y México. Etiquetas: **[Mercado]** · **[Opinión]** ·
> **[Norma LatAm]**. No se pudieron leer directo: docs nuevas de Zuora (aviso de navegador), la página de agrupación de
> Stripe (404) y los PDF de instructivos de proveedores (se usó el resumen del buscador).

## 1. Agrupar en una factura (varios contratos o monedas)

- **Zuora**: por defecto una factura por cuenta; se separa con "Invoice Separately" o con `invoiceGroupNumber` (grupo por
  OC u otro criterio), ambos fijados en la suscripción; distingue **dueño de la factura** de dueño de la suscripción
  (la matriz recibe la factura de las filiales).
  [Invoice Grouping](https://docs.zuora.com/en/zuora-billing/bill-your-customer/leverage-advanced-capabilities/flexible-billing/invoice-grouping/invoice-grouping-overview) ·
  [owner](https://docs.zuora.com/en/zuora-billing/manage-accounts-subscriptions-and-non-subscriptions/manage-subscription-transactions/subscribe-and-amend/amend-subscriptions/change-owners-of-subscriptions)
- **NetSuite SuiteBilling**: la **cuenta de facturación** (cliente, **una sola moneda**, calendario, plazo de pago,
  dirección) se asigna a cada suscripción; todo lo que cae en la misma cuenta va junto.
  [Oracle](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_4779334000.html)
- **Maxio**: grupo declarado antes; la suscripción principal controla emisión y cobro; el cliente ve la consolidada.
  [Maxio](https://docs.maxio.com/hc/en-us/articles/24252269909389-Consolidate-Invoices)
- **Stripe**: "Billing Cadences" (public preview): la cadencia, no la suscripción, genera una sola factura.
  [doc](https://docs.stripe.com/billing/subscriptions/invoice-consolidation)
- **Chargebee y Recurly**: consolidan **después** solo si coinciden fecha, **moneda**, medio de pago y dirección;
  Chargebee separa por OC. [Chargebee](https://www.chargebee.com/docs/billing/2.0/invoices-credit-notes-and-quotes/consolidated-invoicing)
- **Nadie mezcla monedas en un documento.**

**Patrón**: declarar el agrupamiento **antes** (cuenta, grupo, dueño, cadencia); consolidar después es el modelo antiguo y
frágil. La OC casi siempre **separa** facturas.
**Sapira [Opinión]**: reemplazar unificar/consolidar por la **ruta de facturación declarada** (A.5): una moneda por
documento (las líneas en UF/USD se convierten con su método por línea, A.3), OC/HES como atributo que puede partir la
ruta, la ruta puede tomar líneas de **varios contratos** del mismo receptor; consolidar a mano queda como excepción con
motivo.

## 2. Editar un borrador

- **Stripe**: la factura de renovación queda en borrador ~1 hora y se edita; `auto_advance=false` para revisarla; una vez
  finalizada no cambia el monto. **Revisión** (`from_invoice.action=revision`): borrador nuevo que al finalizar anula la
  original (no aplica a facturas de suscripción ni con NC; en la UE puede corresponder NC).
  [subscription invoices](https://docs.stripe.com/billing/invoices/subscription) ·
  [invoice edits](https://docs.stripe.com/invoicing/invoice-edits.md?testing-method=with-code)
- **Zuora**: borradores editables o regenerables; fecha y vencimiento editables en borrador.
- **Patrón**: la frontera es **emitir**; antes se edita todo, después NC o revisión que anula y reemplaza.

**Sapira [Opinión]**: borrador editable como un todo con origen `generated | operator_edited` (A.6); al regenerar, las
líneas `manual` y los campos editados a mano **no se pisan** (se muestra la diferencia y se pide confirmar el descarte).
Con folio fiscal, lo emitido se corrige con **NC que anula + factura nueva vinculada** (`replaces_invoice_id`)
[Norma LatAm].

## 3. Dividir, emitir parcial, reprogramar, varios períodos

- **Stripe**: ítems pendientes entran en la siguiente factura; "Invoice now" los factura de inmediato.
- **Chargebee**: `invoice_immediately=false` deja cargos "unbilled"; "Invoice now" los adelanta.
- **Zuora**: separa con grupos o "Invoice Separately" y calendarios de facturación.
- **Patrón**: la unidad que se mueve es el **cargo**, no la factura; una factura multi-período = líneas con su propio
  período de servicio.

**Sapira [Opinión]**: `invoice_items` como cargos con `service_period_start/end`; dividir = mover líneas o % a otro
borrador de la misma ruta; reprogramar = cambiar la fecha de emisión; varios períodos = juntar cargos pendientes; cada
operación es un evento con motivo; el devengo va por el período de cada línea, no por la fecha de la factura.

## 4. Notas de crédito y débito, ajuste a lo emitido

- **Stripe**: NC sobre factura abierta (baja lo adeudado) o pagada (saldo a favor, reembolso, `out_of_band`); suma ≤
  total; por línea recomendado. [doc](https://docs.stripe.com/invoicing/dashboard/credit-notes)
- **Chargebee**: tipos `adjustment` / `refundable` / `store`, `reference_invoice_id`, `create_reason_code`.
  [API](https://apidocs.chargebee.com/docs/api/credit_notes)
- **Zuora**: NC y ND como documentos legales aplicados **por ítem**; el proceso genera NC en borrador en vez de facturas
  negativas.
- **Chile SII**: `CodRef` 1 anula, 2 corrige texto, 3 corrige montos
  ([SII](https://www.sii.cl/destacados/factura_electronica/guias_ayuda/nota_credito_corrige_monto_fe.pdf)); ND para cargos
  adicionales o anular NC. **Perú SUNAT**: catálogo 09 (01 anulación; 13 ajusta monto pendiente y/o **vencimiento o
  cuotas**: cambiar el vencimiento después de emitir exige NC). **México SAT**: CFDI de egreso con relación `01`;
  sustitución `04`.
- "El ERP emitió distinto a lo planificado": ningún líder lo trata (todos emiten ellos); lo más cercano es importar
  documentos (Relvo desde el SII, "Import credit note" de Chargebee).

**Sapira [Opinión]**: NC/ND como `invoices` con vínculo obligatorio a la original, `void_scope full | partial` y código
fiscal por país derivado, líneas espejo; se mantiene `impact_month | defer_forward`. **Ajuste a lo emitido**: conciliar el
documento real de Odoo contra el borrador; si difiere, evento `adjusted_to_issued`, el devengo pasa a lo emitido y el
contrato queda como referencia con marca de desbalance (no bloqueo).

## 5. Tipo de documento, impuestos y vencimiento

- **Stripe**: cascada factura → suscripción → cliente → cuenta (`days_until_due` en la suscripción, `default_tax_rates`).
  **NetSuite**: plazo y moneda en la cuenta de facturación. **Odoo l10n_cl**: tipo de documento derivado del tipo de
  contribuyente del receptor. Chile: OC con código **801**; "HES" es convención de los compradores, no un código SII.

**Sapira [Opinión]**: una sola cadena de precedencia para tipo de documento, impuesto, plazo y referencias: **borrador
(override) → ruta de facturación → vínculo contrato–razón social → razón social receptora → emisor**; impuesto primero
por ítem/producto (exento/afecto) y luego por receptor (exportación); vencimiento = emisión + plazo, **congelado al
emitir**; guardar el origen de cada valor (`*_source`) para mostrar en la UI por qué tiene ese valor.

## 6. Estados de factura

Stripe y Chargebee: un solo eje; Zuora separa documento y saldo; Relvo tiene ejes con estado fiscal y envío. En LatAm el
estado fiscal (aceptado / rechazado) es independiente del pago → un estado único los mezcla (los 8 estados de hoy).
**Sapira [Opinión]**: ejes independientes (A.6): ciclo `upcoming → draft → issued → void` · pago `unpaid | partial | paid
| overdue` · fiscal `not_submitted → pending → accepted | rejected` · envío. El estado visible se **deriva**.

## Resumen

| Tema | Recomendación | Impacto en modelo (sin eliminar campos) |
|---|---|---|
| Agrupar | Ruta de facturación declarada, una moneda por documento, OC/HES separa, multi-contrato; consolidar a mano = excepción con motivo | `invoice_routes` (+ líneas y `split_weight`), `invoices.invoice_route_id`; `contract_billing_splits` migra a rutas |
| Editar borrador | Todo editable hasta emitir; regenerar respeta lo manual; lo emitido con NC + reemplazo | `draft_body_origin`, `invoice_items.source`, `amount_basis`, `replaces_invoice_id`, log por documento |
| Dividir / parcial / reprogramar | La unidad es el cargo pendiente | `service_period_start/end`, `invoices.role` (`adhoc`, `split`, `catch_up`) |
| NC/ND y ajuste | Vínculo obligatorio, alcance total/parcial, código fiscal por país, líneas espejo; conciliar planificado vs emitido | `reference_invoice_id`, `void_scope`, `fiscal_reason_code`, `invoice_items.reference_item_id` |
| Documento, impuesto, vencimiento | Cascada borrador → ruta → vínculo → receptor → emisor con origen guardado; vencimiento congelado al emitir | `payment_terms`, `due_date`, `document_type_code` + `*_source`, `invoice_references[]` |
| Estados | Ejes independientes, estado visible derivado | `lifecycle_status`, `payment_status`, `fiscal_status`, `delivery_status`; `status` actual como vista derivada |
