# Benchmark: metering, pricing de consumo, descuentos, FX por factura y emisión automática

> 24-09-2026. Complementa [`benchmark-consumo-desfase-mrr.md`](./benchmark-consumo-desfase-mrr.md) (devengo del uso tardío, MRR de uso, granularidad), [`benchmark-contratos-revrec-multimoneda.md`](./benchmark-contratos-revrec-multimoneda.md) (FX contable IAS 21 / IFRIC 22, `metrics_fx`) y [`benchmark-facturacion-agrupacion-edicion.md`](./benchmark-facturacion-agrupacion-edicion.md) (borrador editable, NC/ND, revisión en Stripe). No repite lo que ya cubren.
> Etiquetas: **[Norma]** · **[Mercado]** · **[Opinión]**. **(NV)** = no verificado en la fuente primaria (se usó el resumen del buscador o no se encontró documentación).

## 1. Eventos de consumo (metering)

**[Mercado]**

| Sistema | Idempotencia | Eventos tardíos | Corrección |
|---|---|---|---|
| **Stripe Billing Meters** | `identifier` único por ≥24 h | timestamp de hasta 35 días atrás y 5 min adelante | *Meter Event Adjustment* cancela solo eventos de las **últimas 24 h**; la agregación (`sum`/`count`/`last`) no se cambia después de crear el medidor |
| **Metronome** | `transaction_id`, 34 días | histórico de hasta 34 días | el borrador se recalcula en tiempo real; la factura finalizada es inmutable: se niega el uso, se reenvía, se anula y se regenera |
| **Orb** | `idempotency_key` = id del evento | *grace period* de 12 h (configurable por cuenta) | `PUT` modifica el evento salvo timestamp y cliente; *deprecate*; *backfill* por rango que reemplaza el conjunto; lo anterior queda archivado, nunca se borra |
| **m3ter** | `uid` con ventana de 35 días | se reubica en su período; recálculo a pedido | reenvío |
| **Lago** | `transaction_id` | (NV) | acepta eventos preagregados en SUM/COUNT/MAX, pero se pierde la auditoría por evento |
| **Chargebee** | `deduplication_id` (usage events) | se pueden agregar usos hasta que la factura se **cierra**; lo que cae en un período ya facturado se guarda pero no se cobra sin regenerar | borrar y volver a agregar |
| **Zuora** | `Unique Key` opcional (upsert) | `STARTDATE` fija el **período de servicio**; si ese período está abierto, entra en el próximo *bill run* | upsert por la clave |

Fuentes: [Stripe API](https://docs.stripe.com/billing/subscriptions/usage-based/recording-usage-api.md) · [Stripe adjustments](https://docs.stripe.com/api/billing/meter-event-adjustment) · [Metronome ingest](https://docs.metronome.com/connect-metronome/send-usage-events/) · [Metronome invoices](https://docs.metronome.com/guides/implement-metronome/core-concepts/how-invoicing-works) · [Orb backfill/amend](https://docs.withorb.com/events-and-metrics/reporting-errors) · [m3ter](https://docs.m3ter.com/guides/end-customer-accounts/submitting-usage-data-for-an-account) · [Lago](https://getlago.com/docs/guide/events/usage-performances) · [Chargebee usages](https://apidocs.chargebee.com/docs/api/usages) · [Chargebee events](https://www.chargebee.com/docs/billing/2.0/usage-based-billing/ingesting-usage-events-into-chargebee) · [Zuora import](https://knowledgecenter.zuora.com/Zuora_Billing/Bill_your_customers/Bill_for_usage_or_prepaid_products/Usage/AC_Import_Usage_Data). En Amberflo, la idempotencia y la API de backfill retroactivo están descritas solo en su material comercial (NV).

Dato de contexto: Stripe hoy recomienda **Metronome** (ahora producto de Stripe) para las integraciones nuevas de consumo y deja Billing Meters para quien ya lo usa ([Stripe](https://docs.stripe.com/billing/subscriptions/usage-based/recording-usage)).

**Patrones [Mercado]**
- **El evento crudo es inmutable y lleva una clave de idempotencia** (ventana de 24 h a 35 días). Las correcciones se registran como hechos nuevos (enmienda, archivo o negación); nadie hace un update destructivo.
- **El período de servicio sale del evento** (timestamp o `STARTDATE`) y el contrato decide el período de facturación.
- **La métrica facturable** (qué se cuenta: filtro más sum/count/max/unique/last; Metronome también permite [métricas SQL](https://docs.metronome.com/guides/implement-metronome/core-concepts/create-billable-metrics)) **va separada del precio** (cuánto se cobra).
- **Carga desde el data warehouse**: se hace por archivos. Orb lee desde S3/GCS en JSONL o CSV, pensado para un `UNLOAD` del DWH ([Orb](https://docs.withorb.com/events-and-metrics/cloud-storage-integration)); Chargebee acepta S3 y un bulk de 5 MB; Zuora, un CSV de 4 MB. En sentido contrario, Metronome exporta a Snowflake/BigQuery una vez al día ([doc](https://docs.metronome.com/developer-resources/data-export/)).
- **El cliente manda un monto final en vez de una cantidad**: Lago tiene el modelo *dynamic*, con `precise_total_amount_cents` por evento y solo agregación suma ([Lago](https://getlago.com/docs/guide/plans/charges/charge-models/dynamic)). El resto lo resuelve con un cargo o línea ad hoc (NV el detalle por proveedor).
- **Vista de consumo para el cliente**: Stripe expone *meter event summaries* por API; Metronome y Orb ofrecen dashboards o portal embebible (NV).

## 2. Modelos de pricing de consumo

- **Graduado vs volumen**. Ejemplo de Stripe con 12 unidades: graduado = 111 USD (cada tramo a su precio), volumen = 66 USD (todo al precio del último tramo alcanzado) ([Stripe](https://docs.stripe.com/subscriptions/pricing-models/tiered-pricing)). **[Norma]** Un descuento por volumen **retroactivo** es contraprestación variable. Uno **prospectivo** (el precio baja para las unidades futuras) obliga a evaluar si da un *material right* ([PwC 7.2.3](https://viewpoint.pwc.com/dt/us/en/pwc/accounting_guides/revenue_from_contrac/revenue_from_contrac_US/chapter_7_options_to_US/72customer_options_t_US/723volume_discounts_US.html)).
- **Mínimo comprometido más excedente**. Metronome distingue el *prepaid commit* (pago anticipado con drawdown mensual; lo no usado expira) del *postpaid commit* (gasto mínimo con **factura de true-up** al cierre del compromiso) ([Metronome](https://docs.metronome.com/guides/pricing-packaging/apply-credits-and-commits/create-a-pre-paid-commit)). Orb modela mínimos y máximos como *adjustments* ([Orb](https://docs.withorb.com/product-catalog/adjustments)); Lago tiene *spending minimum* ([Lago](https://getlago.com/docs/guide/plans/charges/spending-minimum)).
- **Créditos prepagados**. En Stripe, los *credit grants* aplican **solo a precios medidos** y se descuentan al finalizar la factura ([Stripe](https://docs.stripe.com/billing/subscriptions/usage-based/billing-credits)).
- **Agregación max/last**. Stripe tiene `last`; Lago, `max_agg` y `unique_count_agg`. Se usan para asientos, almacenamiento pico o capacidad.
- **Frecuencia del variable distinta de la del fijo**. Lago tiene `bill_charges_monthly` (plan anual con consumo mensual) ([Lago](https://docs.getlago.com/guide/plans/plan-model)); Orb define la cadencia por precio dentro del mismo plan ([Orb](https://docs.withorb.com/product-catalog/price-configuration)); Metronome separa los *usage statements* de las facturas programadas.
- **Cómo se ve en la factura**. Metronome crea **una línea por grupo de precio** (p. ej., input/output). Chargebee guarda el desglose por tramo de cada línea (`invoice_line_item_tiers`, [catálogo](https://datacatalog.chargebee.com/invoice_line_item_tiers/)). Que Stripe muestre una fila por tramo en el PDF quedó sin verificar (NV). El patrón es **una línea por cargo y el detalle de tramos como sublíneas o anexo**.

**[Opinión]** En un DTE chileno, `MontoItem` debe cuadrar con `QtyItem × PrcItem` menos el descuento (NV el detalle de la tolerancia del SII). Un precio unitario "efectivo" (total ÷ cantidad) genera problemas de redondeo. Conviene una línea por tramo, o una línea con cantidad 1 y el detalle en la descripción o en un anexo.

## 3. Descuentos sobre consumo

**[Mercado]**
- **Stripe**: hasta 20 descuentos por suscripción, ítem o factura. Un cupón de suscripción alcanza también a los ítems medidos, salvo que se restrinja con `applies_to` por producto ([Stripe](https://docs.stripe.com/billing/subscriptions/coupons)).
- **Orb**: cinco tipos de ajuste con un **orden fijo**: descuento en unidades (antes de aplicar el precio) → monto → % → mínimo → máximo ([Orb](https://docs.withorb.com/product-catalog/adjustments)). El alcance por precio o por plan (`applies_to_price_ids`) quedó sin verificar (NV).
- **Metronome**: el descuento suele ser una tarifa de drawdown preferente a cambio del commit, más overrides al rate card (NV).

**[Norma]**
- IFRS 15 ¶81–82: un descuento de paquete se **prorratea** entre todas las obligaciones, salvo evidencia observable de que corresponde a una sola ([IFRS 15](https://www.ifrs.org/content/dam/ifrs/publications/pdf-standards/english/2021/issued/part-a/ifrs-15-revenue-from-contracts-with-customers.pdf)).
- ¶84–85: la contraprestación variable, incluido un descuento que depende del consumo, se asigna **entera al período o servicio al que corresponde** si se relaciona específicamente con él.
- El ingreso se reconoce **neto del descuento**.

**[Opinión]** Descuento en el ítem con `applies_to: fixed | usage | both`, tipo `% | monto | unidades gratis`, vigencia y orden de aplicación fijo (como Orb). En el devengo:
- un descuento sobre el consumo de un mes va a ese mes (¶85);
- un descuento de paquete (p. ej., "20% en todo el contrato") se prorratea por valor relativo;
- un descuento retroactivo por volumen se trata como estimación con restricción.

## 4. FX por factura

**[Mercado]**

| Sistema | Fecha de la tasa | Override | Detalle |
|---|---|---|---|
| **Zuora** | la **menor** entre fecha de factura y fecha de posteo | proveedor propio | Oanda o tasa propia; **offset de N días**; opción de tasa mensual; la NC puede usar la tasa de la factura original ([Zuora](https://docs.zuora.com/en/accounts-receivable/finance/zuora-finance-settings/foreign-currency-conversion)) |
| **NetSuite** | tabla de tasas vigente a la fecha de la transacción | editable **por transacción** (con permiso) | [Oracle](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_N1404249.html) |
| **Chargebee** | `forex_type` manual o automático (diario) | cambios de tasa programables | solo para convertir a la moneda base en reportes; la factura va en la moneda del cliente ([API](https://apidocs.chargebee.com/docs/api/currencies)) |
| **Maxio** | tasa de openexchangerates, cacheada cada hora | **tasa fija por moneda** para que el precio no flote en cada renovación | [Maxio](https://docs.maxio.com/hc/en-us/articles/24286716475661-Multi-Currency-in-Advanced-Billing) |
| **Odoo** | `res.currency.rate` a la fecha de la factura | tasa manual por factura solo con módulos de terceros (NV en el core 17+) | Chile usa mindicador.cl ([Odoo CL](https://www.odoo.com/documentation/17.0/applications/finance/fiscal_localizations/chile.html)); para Banxico y SUNAT hay módulos OCA o de terceros |
| **SAP** | no investigado (NV) | — | — |

**[Norma] LatAm**

| País | Moneda del documento | Tasa | Campo fiscal |
|---|---|---|---|
| **Chile** | CLP (exportación en moneda extranjera) | tasa **de la fecha de emisión** (Oficio SII 1.220/2010, art. 4 DL 1.123). El dólar observado se calcula con las operaciones del día hábil anterior | `TpoMoneda`, `TpoCambio`, `MntTotOtrMnda` en la sección OtraMoneda del DTE. Si la diferencia de cambio al alza entre factura y pago supera la variación de la UF, corresponde **nota de débito** (art. 15 DL 825) ([Oficio](https://www.sii.cl/normativa_legislacion/jurisprudencia_administrativa/ley_impuesto_ventas/2010/ja1220.doc) · [formato DTE](https://www.sii.cl/factura_electronica/factura_mercado/formato_dte_202602.pdf)) |
| **Perú** | se puede emitir en USD | para el IGV: **TC promedio ponderado venta SBS** de la fecha en que nace la obligación (normalmente la emisión); si no hay publicación, el último publicado. Art. 5 num. 17 del Reglamento del IGV (fuente secundaria, NV la primaria) | — ([ref.](https://noticierocontable.com/tipo-de-cambio-sunat-o-sbs/)) |
| **México** | puede ir en USD | **FIX de Banxico** publicado en el DOF (del día hábil anterior) **o el pactado entre las partes** | `TipoCambio` obligatorio si la moneda no es MXN; el SAT lo valida contra un rango (umbral NV); el complemento de pago lleva `TipoCambioP` y `EquivalenciaDR` ([ref.](https://herramientasfiscales.mx/blog/error-moneda-tipo-cambio-cfdi)) |
| **Colombia** | **COP** (Res. 042/2020); otras monedas solo informativas | **TRM de la fecha de la operación**, certificada por la Superfinanciera | `PaymentExchangeRate` (anexo técnico 1.9) ([INCP](https://incp.org.co/publicaciones/infoincp-publicaciones/impuestos/2023/06/dian-aclara-en-que-moneda-se-debe-realizar-la-facturacion-electronica/) · [Anexo](https://www.dian.gov.co/impuestos/factura-electronica/Documents/Anexo-Tecnico-Factura-Electronica-de-Venta-vr-1-9.pdf)) |

**[Opinión]**
- La **fecha de la tasa fiscal siempre es la de emisión**. La "fecha de servicio" solo sirve para métricas y devengo.
- Una tasa fija contractual es **precio**: define el monto en la moneda del documento, pero el campo fiscal sigue usando la tasa oficial del día (salvo el "pactado" de México).
- Sin tasa del día, la emisión automática **se detiene** y se genera una alerta. La excepción es un fallback explícito por país (Perú: último publicado).

> **Nota de Domi (24-09)**: la regla de la ND chilena por diferencia de cambio no aplica a contratos en UF: la UF es moneda
> de contrato y se factura y cobra en CLP, sin diferencia de cambio. Solo aplica al facturar en moneda extranjera y cobrar en otra.

## 5. Emisión y envío automáticos

**[Mercado]**
- **Stripe**: con `auto_advance`, la factura finaliza 1 h después de su creación o del último webhook. El *grace period* se configura **hasta 72 h** con reglas ("tiene precio medido", "ciclo de suscripción") y en un borrador se prioriza el más conservador. En ese plazo solo entra uso con timestamp dentro del período de servicio. Si el precio cambió a mitad del ciclo, el uso reportado en el grace period **se pierde**. También admite finalización programada (`automatically_finalizes_at`, hasta 5 años) ([grace](https://docs.stripe.com/billing/subscriptions/usage-based/configure-grace-period) · [scheduled](https://docs.stripe.com/invoicing/scheduled-finalization)).
- **Metronome**: `draft → grace (24 h) → finalized → void`, con *regenerate*.
- **Zuora**: *bill runs* programados con fecha objetivo. *Auto-Post* y *Auto-Email* se saltan la revisión. El *billing preview run* sirve para simular ([Zuora](https://docs.zuora.com/en/zuora-billing/bill-your-customer/collect-payments/implement-billing-and-payments-workflow/workflow-with-auto-post-and-auto-email)).
- **Odoo, reabrir un `account.move`**:
  - En **borrador** se edita libremente.
  - **Publicado**: "Reset to draft" se oculta si el diario tiene *hash lock* (`restrict_mode_hash_table`) y se bloquea por fechas de cierre ([código](https://github.com/odoo/odoo/blob/14.0/addons/account/models/account_move.py)).
  - **Chile**: un DTE rechazado vuelve a borrador, se corrige y se publica de nuevo con **folio manual**; uno aceptado solo se corrige con NC.
  - **México**: el CFDI timbrado se cancela ante el SAT con motivo 01 (con sustituto), 02, 03 o 04. Pasadas 24 h requiere que el receptor acepte (72 h y se da por aceptada) ([Odoo MX](https://www.odoo.com/documentation/17.0/applications/finance/fiscal_localizations/mexico.html)).
  - Tendencia: Odoo está bloqueando el *reset to draft* de documentos ya enviados a la autoridad (PR para [Italia](https://github.com/odoo/odoo/pull/288901) y [Arabia Saudita](https://github.com/odoo/odoo/pull/287844)).

**Patrón**: una ventana de revisión antes de emitir (de 1 h a días), un aviso previo y, después de la finalización, anular y reemitir. Con el ERP de por medio hay tres estados distintos:
1. borrador en el ERP: se pisa al sincronizar;
2. publicado sin aceptación fiscal: *reset to draft*, si el diario no tiene hash;
3. aceptado por la autoridad: NC más factura nueva (o cancelación con sustituto en México).

## Recomendación para Sapira

| Tema | Recomendación | Impacto en modelo |
|---|---|---|
| Unidad de consumo | Registro crudo e inmutable con clave de idempotencia; se acepta también un agregado por período (carga manual o CSV) marcado como tal | `usage_records` (`idempotency_key` única por empresa, `service_date`, `quantity`, `granularity: event\|period_aggregate`, `source: api\|csv\|dwh\|manual`) |
| Corrección | Sin update destructivo: `amend`/`void` crean una versión y archivan la anterior; si el período ya está facturado, van al true-up o a NC (sin reabrir) | `usage_records.status active\|archived`, `supersedes_id`, `correction_reason` |
| Tardíos | Ventana de aceptación y *grace* configurables por empresa antes de cerrar el borrador | `companies.usage_grace_hours`, `usage_backdate_days` |
| Métrica vs precio | Métrica facturable (filtro + `sum\|count\|max\|last\|unique`) separada del modelo de precio del ítem | `billable_metrics`; `contract_items.metric_id` |
| Monto en vez de cantidad | Métrica de tipo **monto** (el cliente manda el total; el precio unitario es 1 en la moneda del ítem) y se guarda la cantidad informativa | `billable_metrics.value_type quantity\|amount`, `usage_records.amount` |
| DWH | Carga por archivo (CSV/JSONL por S3 o subida con URL firmada) con reporte de rechazos; se reprocesa por idempotencia | `usage_imports` (archivo, filas ok/error) |
| Pricing | `per_unit \| package \| tiered_graduated \| tiered_volume \| dynamic` + mínimo, máximo y commit prepago/pospago con true-up | `contract_items.pricing_model`, `tiers[]`, `min_amount`, `max_amount`, `commit_type` |
| Frecuencia | Cadencia del variable independiente de la del fijo (p. ej., fijo anual y consumo mensual) | `contract_items.billing_frequency` por ítem (ya previsto) |
| Presentación | Una línea por tramo (o una línea con anexo) para cuadrar con el DTE | `invoice_items.parent_item_id`, `tier_index` |
| Descuentos | En el ítem con `applies_to fixed\|usage\|both`, tipo %/monto/unidades y orden fijo; devengo neto (¶85 vs ¶81) | `item_discounts` (`applies_to`, `kind`, `value`, `valid_from/to`, `allocation: period\|pro_rata`) |
| FX fiscal | Tasa oficial por país a la fecha de emisión (CL observado, PE SBS venta, MX FIX DOF o pactado, CO TRM); la tasa fija contractual se trata como precio | `invoices.fx_rate`, `fx_rate_date`, `fx_rate_source official\|contract\|manual`; `fx_rates` por país/fuente/fecha |
| Falta de tasa | Bloquea la emisión automática y avisa; fallback explícito por país | evento `fx_missing`; `countries.fx_fallback` |
| CL diferencia de cambio | Sugerir ND si el alza entre factura y pago supera la variación de la UF | regla en conciliación de pagos |
| Emisión automática | Programada con **ventana de revisión** y aviso N días antes; *auto-send* opcional | `billing_policies` (`auto_issue`, `review_window_hours`, `notify_days_before`, `auto_send`) |
| Reabrir un borrador sincronizado | Según el estado en el ERP: borrador → re-sync; publicado sin aceptación → *reset to draft* si el diario lo permite; aceptado → NC + reemplazo (MX: cancelación con motivo) | `erp_sync_state draft\|posted\|fiscal_accepted`, `erp_move_id`, `replaces_invoice_id` (existe), `fiscal_cancel_reason` |

Sin verificar: el detalle de los tramos en el PDF de Stripe, los descuentos de Metronome, el umbral de validación del `TipoCambio` en el CFDI, la fuente primaria peruana (se usaron fuentes secundarias), la tasa manual en el core de Odoo 17+, SAP y el detalle de Amberflo.
