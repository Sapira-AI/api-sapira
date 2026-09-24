# Benchmark — modificaciones de contrato, pausa, escalamientos y reactivación

> 23-09-2026 · insumo de S3 (Modificaciones) de [`../auditoria-contratos.md`](../auditoria-contratos.md) y de S1-18
> (condiciones futuras pactadas) y S2-12 (pausa). Complementa Alguna (Changes API), Zenskar (fases), Maxio, Relvo y
> A.4. Etiquetas: **[Norma]** · **[Mercado]** · **[Opinión]**. Verificado en el código: `REACTIVATION` ya existe en
> `contract_items.categoria` y en el `momentum` de la RSM (junto con `BOP` y `PENDING_RENEWAL`).

## 1. Un solo flujo de cambios

- **Zuora Orders**: una Order agrupa *order actions* tipadas (Renew, Suspend, Resume, Cancel…) con fecha efectiva
  propia y **Order Delta Metrics** (delta de MRR/TCV/cantidad por acción).
  [dev](https://developer.zuora.com/docs/get-started/api-tutorials/orders-tutorials/modify-subscriptions) ·
  [delta](https://knowledgecenter.zuora.com/Zuora_Billing/Manage_subscription_transactions/Orders/Order_Delta_Metrics_and_Order_Metrics/AA_Overview_of_Order_Delta_Metrics)
- **NetSuite SuiteBilling**: *change orders* tipados (Activation, Modify Pricing, Suspend, Reactivate, Renew,
  Terminate), inmediatos o futuros; Modify Pricing pide el **Modification Type** (New/Churn, Upsell/Downsell, Ignored).
  [Oracle](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_1554934535.html)
- **Salesforce CPQ / Revenue Cloud**: la enmienda nace de una "amend quote" que muestra solo el delta; las líneas
  nuevas se **co-terminan** y prorratean. [sf9to5](https://sf9to5.com/2021/08/10/benefits-cpq-amendments-renewals/)
- **Stripe**: preview con `invoices/create_preview` y `proration_date` fija; schedules con metadata por fase.
  [prorations](https://docs.stripe.com/billing/subscriptions/prorations) ·
  [schedules](https://docs.stripe.com/billing/subscriptions/subscription-schedules)

**Patrón**: una primitiva con acciones tipadas y fecha efectiva cada una, preview de facturas + delta de métricas,
origen trazable, co-terminación por defecto.
**Sapira [Opinión]**: `contract_amendment` = Order con N acciones; `origin` (manual / quote HubSpot / quote
Salesforce / agente) + `source_ref` + motivo. Preview: facturas futuras, NC, filas RSM desde la fecha efectiva y
**delta de MRR/CMRR por momentum**. Ítem agregado hereda `end_date` del contrato (co-terminación desactivable) y el
ancla del ciclo, con primer período proporcional (anticipado: línea en la próxima factura o fuera de ciclo; vencido:
al cierre del período).

## 2. Prorrateo y fecha efectiva

| Proveedor | Opciones | Fecha | Detalle |
|---|---|---|---|
| Stripe | `create_prorations` (**default**, se cobra en la próxima factura), `always_invoice`, `none` | inmediata o futura | Advierte prorratear sobre factura impaga |
| Chargebee | prorrateo opcional | inmediata / próxima renovación / fecha | por día o milisegundo ([doc](https://www.chargebee.com/docs/billing/2.0/subscriptions/proration)) |
| NetSuite | prorratea si no calza con el período | fecha efectiva | Off-cycle invoicing |
| Alguna / Maxio | full, none, credit_only, charge_only | — | ya documentado |

**Sapira [Opinión]** (en Chile cada crédito es una NC con CodRef: minimizarlas): upsell/cross-sell `full` cobrado en
la próxima factura (`always_invoice` opcional); downsell por defecto **en el próximo período** con `none`; si es
inmediato, `credit_only` con la NC visible en la preview; advertencia sobre factura impaga; granularidad por día.

## 3. Cambios futuros pactados (ramps, escalators, uplift)

- **Ramps**: Chargebee hasta 12 con `effective_from` (**si se edita la suscripción, el ramp vuelve a borrador**)
  ([ramps](https://www.chargebee.com/docs/billing/2.0/subscriptions/ramps)); Stripe, fases de un schedule (máx. 10).
- **Uplift en la renovación**: Zuora No Change / **Percentage Increase** / Latest Catalog Pricing, por tenant, cargo o
  suscripción ([Zuora](https://docs.zuora.com/en/zuora-billing/manage-accounts-subscriptions-and-non-subscriptions/manage-subscription-transactions/common-subscription-information/automated-price-change-uplift-for-renewed-subscriptions));
  NetSuite uplift por línea en Renew; Salesforce CPQ Renewal Uplift Rate por contrato o suscripción.
- Fin del plazo: Chargebee `action_at_term_end` = renew / evergreen / cancel / renew_once
  ([API](https://apidocs.chargebee.com/docs/api/contract_terms)). Escalator dentro del plazo: Alguna
  `price_escalation {percentage, interval_months}`.
- **Métricas**: ChartMogul cuenta toda alza de MRR (incluida la de precio) como **Expansion**
  ([doc](https://help.chartmogul.com/article/163-understanding-mrr-movements)); Chargebee incluye upgrades programados
  en el **CMRR**; Maxio no cuenta como expansión una renovación al mismo valor.

**Sapira [Opinión]**: ramps = fases pactadas (A.4), proyectadas en el CMRR desde la firma; al entrar en vigor, delta en
la RSM como `UPSELL` subtipo `price_step`. Uplift = `renewal_policy {action_at_term_end, uplift_pct, pricing:
same|uplift|catalog}` en el contrato, override por ítem; al renovar, ítem con `renews_item_id` y momentum `RENEWAL`, y
el delta de precio se reporta como **expansión de precio** separada de la de volumen (explica el NRR).

## 4. Pausa y reanudación

- **Stripe separa dos cosas**: `pause_collection` (servicio sigue, facturas quedan borrador / incobrables / anuladas;
  `resumes_at` o indefinida) y **pausa de la suscripción** (`paused`: se detienen servicio y facturación; crédito del
  tiempo no usado; reanudación con prorrateo; preview; motivo en `status_details`).
  [pause-payment](https://docs.stripe.com/billing/subscriptions/pause-payment) · [pause](https://docs.stripe.com/billing/subscriptions/pause)
- **Chargebee**: inmediata / fin de plazo / fecha, reanudación automática o manual; **MRR = 0 y no es churn**; pausas
  programadas en el CMRR; reportes "Paused MRR" y "Pause to Paid MRR"; si la reanudación cae fuera del plazo, mueve la
  renovación. [doc](https://www.chargebee.com/docs/billing/2.0/subscriptions/pause-subscription)
- **Zuora**: Suspend/Resume como order actions; no factura en la suspensión; puede **extender el plazo**;
  auto-resume; la suscripción suspendida solo cuenta en el CMRR.
- **Recurly**: pausa desde la próxima fecha de cobro por N ciclos; no aporta MRR. **NetSuite**: Suspend/Reactivate por
  línea. **Pausa masiva**: ninguno la tiene nativa.

**Sapira [Opinión]**: acción `pause` con `scope: billing | service`, inicio (inmediato / fin de período / fecha),
`resume_at` opcional y `extend_term`. `service`: devengo 0 y MRR 0 en la pausa, CMRR mantenido si hay reanudación;
`billing`: el devengo sigue, solo se posponen los borradores. **Pausa masiva** = N amendments con preview agregada y
una sola aprobación (diferenciador).

## 5. Revertir churn o cancelación

- **Stripe**: la cancelación programada se revierte hasta el fin del período; una suscripción cancelada **no** se
  reactiva ([cancel](https://docs.stripe.com/billing/subscriptions/cancel)).
- **Chargebee**: reactiva canceladas, incluso con **fecha pasada** conservando el ciclo; dentro del plazo, sin factura
  si no hay cambios; Reactivation MRR como expansión ([reactivation](https://www.chargebee.com/docs/billing/2.0/subscriptions/reactivation)).
- **ChartMogul**: Churn y luego Reactivation, salvo que se "conecten" las suscripciones (entonces Expansion).
- **NetSuite**: change order Reactivate.

**Sapira [Opinión]**: (a) churn programado no vigente → se anula, sin impacto en métricas; (b) churn vigente revertido
**dentro de una ventana** (antes del cierre del período) → **reversión**: se restauran ítems, el evento queda anulado
con motivo y se reescriben las filas `CHURN` de la RSM; las NC emitidas no se tocan, se re-factura; (c) fuera de la
ventana → **reactivación** con ítems `REACTIVATION`.

## 6. Clasificación en métricas

Lógica común a nivel **cliente**: NEW (no tenía MRR), CHURN (pierde el último), CONTRACTION (baja sin cancelar todo),
EXPANSION (sube), REACTIVATION (vuelve tras churn). Cross-sell no es categoría estándar (ChartMogul lo incluye en
Expansion); definición difundida: **upsell vertical** (mismo producto, más cantidad o tier), **cross-sell horizontal**
(otro producto). NetSuite deja que la usuaria la elija.

**Sapira [Opinión]** — derivada automática con override y motivo:

| Situación | Momentum |
|---|---|
| El cliente no tenía MRR activo | `NEW` |
| Tuvo MRR y lo perdió | `REACTIVATION` |
| Producto que el cliente no tiene activo en ningún contrato | `CROSS-SELL` |
| Mismo producto, más cantidad o precio | `UPSELL` |
| Baja de cantidad o precio sin quitar todo | `DOWNSELL` |
| Retira el último MRR del cliente | `CHURN` |
| Quita un producto pero sigue con otros | `DOWNSELL` (no `CHURN`) |

Un contrato nuevo de un cliente existente **no es NEW**.

## 7. Contabilidad de la modificación [Norma]

IFRS 15 ¶18-21 / ASC 606-10-25-10..13 ([IFRS 15](https://www.ifrs.org/content/dam/ifrs/publications/pdf-standards/english/2022/issued/part-a/ifrs-15-revenue-from-contracts-with-customers.pdf?bypass=on) ·
[PwC](https://viewpoint.pwc.com/dt/us/en/pwc/accounting_guides/revenue_from_contrac/revenue_from_contrac_US/chapter_2_scope_and__US/29contract_modificat_US.html) ·
[Deloitte](https://dart.deloitte.com/USDART/home/publications/archive/deloitte-publications/accounting-spotlight/2020/contract-modifications)):
¶20 **contrato separado** (bienes distintos a precio independiente; lo original no se toca); ¶21(a) **prospectivo**
(terminación + contrato nuevo: el precio pendiente se reparte en lo restante, sin tocar lo reconocido); ¶21(b)
**acumulativo** (catch-up en la fecha de la modificación). El SaaS es una serie de servicios distintos (¶22(b)) →
casi siempre ¶20 o ¶21(a). Un cambio solo de precio va por ¶21(a). Una concesión por algo existente al inicio es
contraprestación variable, no modificación.

**Sapira [Opinión]**: `accounting_treatment ∈ {separate, prospective, catch_up}` derivado (ítem nuevo a precio de lista
→ separate; descuento, cambio de precio o downsell → prospective; proyecto con % avance → catch_up). **La RSM nunca
reescribe meses ya reconocidos** en separate/prospective: recalcula desde la fecha efectiva; el catch-up va como fila de
ajuste en el mes de la modificación.

## Resumen

| Tema | Recomendación | Impacto en modelo (sin eliminar campos) |
|---|---|---|
| Flujo único | Amendment = Order con acciones tipadas (add, update, remove, renew, pause, resume, terminate, reactivate) + preview con delta por momentum | `contract_amendments` + tabla hija de acciones; un evento de lifecycle por acción |
| Origen | `origin` + `source_ref` | columnas en `contract_amendments` |
| Co-terminación | Ítem nuevo termina con el contrato y se alinea al ciclo; primer período proporcional | `end_date` heredado; `related_item_id` al ítem base |
| Prorrateo | upsell/cross-sell `full` en la próxima factura; downsell al próximo período `none`; aviso por factura impaga | `proration_behavior`, `invoice_timing` por acción |
| Ramps | Fases pactadas en el CMRR; `UPSELL` subtipo `price_step` | fases A.4; subtipo en la RSM |
| Uplift | `renewal_policy` en el contrato con override por ítem; expansión de precio | `renews_item_id`, `categoria=RENEWAL` |
| Pausa | `scope billing|service`, `resume_at`, `extend_term`; MRR 0 sin churn | estado `paused`, eventos `paused/resumed`, RSM con devengo 0 |
| Pausa masiva | N amendments, preview agregada, una aprobación | `batch_id` |
| Deshacer churn | anular / revertir en ventana / reactivar | `contract_lifecycle_events.reversed_by`; `REACTIVATION` ya existe |
| Clasificación | Automática a nivel cliente con override y motivo | `categoria` derivada + motivo |
| Contabilidad | `accounting_treatment` derivado; nunca reescribir meses reconocidos salvo catch-up | columna en el amendment |

No verificado directamente: docs de Zuora (render con JavaScript) y tip sheet de Salesforce CPQ (fallo de
certificado) → se usaron resúmenes y blogs de partners citados; no se encontró escalator documentado en Maxio ni pausa
masiva nativa en ningún proveedor.
