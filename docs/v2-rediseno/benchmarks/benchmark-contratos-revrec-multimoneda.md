# Benchmark — creación de contratos, rev-rec, multimoneda, FX contable, aprobación y documento fiscal

> 23-09-2026 · insumo de la Fase 0 de [`../auditoria-contratos.md`](../auditoria-contratos.md) (temas abiertos de S1:
> S1-6, S1-12, S1-16, S1-17, S1-9, S1-7). Complementa los benchmarks de Alguna, Maxio, Relvo y Zenskar (no los
> repite). Etiquetas: **[Norma]** IFRS/ASC · **[Mercado]** práctica documentada · **[Opinión]** recomendación.

## 1. Reconocimiento de ítems NO recurrentes

**Líderes**
- **Stripe**: cada línea de factura es una obligación; con período de servicio → lineal en el período; sin período →
  todo al finalizar la factura; se cambia con reglas. Granularidad **global** (default diario; alternativas por
  segundo, mes parejo, mes con primer/último prorrateado) y toggle de catch-up.
  [metodología](https://docs.stripe.com/revenue-recognition/methodology/subscriptions-and-invoicing) ·
  [settings](https://docs.stripe.com/revenue-recognition/revenue-settings)
- **Zuora Billing**: la regla va en la **carga del catálogo** (`Recognize upon invoicing` / `Recognize daily over
  time` + modelos como "completo en fecha específica").
  [rules](https://docs.zuora.com/en/accounts-receivable/finance/zuora-finance-settings/manage-revenue-recognition-rules)
- **Chargebee RevRec**: Ratable (30/360, diario, end-month exclusive) · Point in Time (entrega / fin de contrato) ·
  Proportional Performance (% avance, hitos); configurado por producto/tipo/familia.
  [reglas](https://www.chargebee.com/docs/revrec/revenue-recognition/configuring-revenue-rules)
- **NetSuite ARM**: regla por ítem (método, amount source, fuente de fecha de inicio); lineal "even periods" (sin
  prorrateo) vs "exact days"; por evento/hito; % de avance acumulado.
  [fields](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_4356113783.html)

**[Norma]** IFRS 15 ¶35 / ASC 606-10-25-27: se reconoce **en el tiempo** si se cumple alguno de: el cliente consume
el beneficio mientras se presta; se crea/mejora un activo que controla; no hay uso alternativo + derecho exigible a
cobrar lo avanzado. Si no, **punto en el tiempo**.
[IFRS 15](https://www.ifrs.org/content/dam/ifrs/publications/pdf-standards/english/2022/issued/part-a/ifrs-15-revenue-from-contracts-with-customers.pdf?bypass=on)
**Setup (B48–B51)**: si no transfiere un servicio distinto (puesta en marcha administrativa) es un **anticipo** que se
difiere en el período del servicio; si es distinto (integración aprovechable por sí sola) es su propia obligación
(en el tiempo por avance o punto al entregar). [IFRIC AP](https://www.ifrs.org/content/dam/ifrs/meetings/2018/september/ifric/ap02.pdf)
**B16 "al facturar"**: válido cuando lo facturable corresponde al valor entregado (consumo, horas), no para un
one shot cobrado por adelantado.

**Patrón [Mercado]**: método en el **producto** con default, la línea hereda; granularidad día/mes como **política
global**, no por línea; % avance e hitos requieren un evento que alguien registra.

**Recomendación [Opinión]**: método en el producto (existe `revenue_rules`, vacía) con **override por línea + motivo**.
Defaults: recurrente → lineal en el período facturado; setup → lineal N meses (default vigencia) o punto en el
tiempo en go-live si es distinto; servicios profesionales → hito / % avance; consumo → según facturación. Catálogo:
`point_in_time(facturación|inicio|entrega|fin)`, `ratable(servicio_facturado|vigencia|N_meses)`, `milestone`,
`percent_complete`, `as_billed`. Granularidad `daily | monthly_even | monthly_prorated_first_last` por razón social u
holding (cambiarla reescribe historia). En la UI: "¿el cliente puede usar la implementación por sí sola?" (B48 en
lenguaje de negocio).

## 2. Captura de precios y término

- **Zuora** separa el **período del precio** (List Price Base: por período de facturación, mes, semana, año) del
  **período de facturación**; precio "por mes" facturado trimestral = multiplica.
  [charge models](https://knowledgecenter.zuora.com/Zuora_Billing/Build_products_and_prices/Basic_concepts_and_terms/B_Charge_Models)
  Stripe amarra el intervalo al precio. Flat fee vs per unit (Zuora) = `amount_basis exact_total|unit_rate` (Relvo).
- **Término**: Zuora `Termed` vs `Evergreen` (**TCV vacío** en evergreen);
  [Zuora](https://knowledgecenter.zuora.com/Zuora_Billing/Manage_accounts,_subscriptions,_and_non-subscription_transactions/Manage_subscription_transactions/Common_subscription_information/AB_Get_started_with_subscriptions)
  · Salesforce CPQ marca Evergreen por línea
  ([SF](https://help.salesforce.com/s/articleView?id=sales.cpq_evergreen_parent.htm&language=en_US&type=5)) ·
  Chargebee modela el compromiso aparte (contract terms) sobre una suscripción continua
  ([doc](https://www.chargebee.com/docs/billing/2.0/subscriptions/contract-terms)) · Zenskar `end_date = null`.
- **[Norma]** con cancelación libre, el contrato contable dura solo el período con derechos exigibles (típicamente un
  mes): no se difiere ni proyecta ingreso futuro. Stripe no proyecta más allá de lo facturado.
  [PwC 2.6](https://viewpoint.pwc.com/dt/us/en/pwc/accounting_guides/revenue_from_contrac/revenue_from_contrac_US/chapter_2_scope_and__US/26identifying_the_co_US.html)
- **Patrón**: obligatorio = cliente, producto/precio, cantidad, precio, inicio, tipo de término. Derivado (no se
  pregunta) = fin, TCV/ARR, próxima factura, ancla del ciclo. Descuento sobre precio de lista.

**Recomendación [Opinión]**: línea con `price_period` (mes|año|único) separado de `billing_frequency`, `amount_basis`,
descuento sobre `list_price_id`; la UI muestra en vivo total mensual y total por factura. Contrato con
`term_type fixed|evergreen` + `initial_term_months` + `renewal (none|auto_same_term|to_evergreen)`. Evergreen: RSM
solo del período facturado + proyección **no contable** de 12 meses rodantes para forecast/ARR; TCV nulo o "ARR × 1"
etiquetado. Ocultar en "Avanzado": ancla del ciclo, anticipado/vencido (hereda del producto), método rev-rec y FX
(heredan).

## 3. Multimoneda

- **Stripe**: todos los ítems de una suscripción en una moneda; cliente amarrado a una moneda.
  [doc](https://docs.stripe.com/invoicing/multi-currency-customers) · **Zuora Billing**: facturas separadas por moneda ·
  **Zuora Revenue**: transacción → funcional ("home") → reporte en cascada, y **sí admite contratos multimoneda**.
  [FX](https://docs.zuora.com/en/accounts-receivable/finance/zuora-finance-settings/foreign-currency-conversion) ·
  [multi-currency contracts](https://knowledgecenter.zuora.com/Zuora_Revenue/Multi-currency_contracts/A_Overview_of_multi-currency_contracts)
- **NetSuite**: moneda de transacción ≠ base de la subsidiaria; consolidación con Current (balance), **Average
  (resultados)**, Historical, y Budget rate. [tipos](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_N1405625.html)
- **ChartMogul**: MRR a la tasa del inicio del período; **no** genera expansión/contracción por FX, lo aísla como
  "Exchange Rate Impact". [help](https://help.chartmogul.com/hc/en-us/articles/201520952-How-ChartMogul-handles-subscriptions-billed-in-foreign-currencies)
- **Patrón**: una moneda por suscripción en los billing engines; solo rev-subledgers (Zuora Revenue) y Relvo mezclan.
  Siempre 3–4 monedas: transacción, facturación, funcional, reporte.

**Evaluación de la idea de Domi (S1-16) [Opinión]**: correcta y más flexible que el mercado, coherente con A.3, si:
(1) se llama **`metrics_currency`** (no "moneda del contrato"), default = moneda funcional del emisor; (2) **dos tasas
distintas**: `billing_fx` por línea (escalera fijo/oficial/manual, A.3) y `metrics_fx` por política del holding
(`booking_rate` congelada al firmar — sirve para TCV y comisiones — o `period_rate`); (3) MRR/ARR en **moneda
constante** y a tasa del período, con la diferencia como **"Impacto FX"** (responde M8); (4) la UF es indexación: un
contrato 100% en UF puede tener UF como moneda de métricas. Riesgo: usar el FX fijo del ítem también para métricas
esconde la realidad cambiaria.

## 4. FX para registrar ingresos en moneda funcional

**[Norma]** IAS 21 ¶21 / ASC 830-20-30-1: tasa de la **fecha de la transacción**; ¶22: **promedio del período** como
aproximación **si la tasa no fluctúa significativamente**. [IAS 21](https://www.ifrs.org/content/dam/ifrs/publications/html-standards/english/2024/issued/ias21.html)
**IFRIC 22**: el ingreso diferido (facturado por adelantado) es **no monetario** → se libera a la tasa de la
facturación y **no se re-mide**. [IFRIC 22](https://www.ifrs.org/content/dam/ifrs/publications/html-standards/english/2025/issued/ifric22.html)
La **cuenta por cobrar** es monetaria: re-medición al cierre (**no realizada**) y al cobro (**realizada**).
[PwC 21.3](https://viewpoint.pwc.com/dt/us/en/pwc/accounting_guides/financial_statement_/financial_statement___18_US/chapter_21_foreign_c_US/213_transaction_gain_US.html)
Una **tasa fija contractual** es precio pactado para facturar; no reemplaza la tasa contable. **UF (Chile)**: el
reajuste va a "resultado por unidades de reajuste", separado de diferencias de cambio.

**Mercado**: Stripe usa mid-market a la facturación para el ingreso y la del pago para el cobro (diferencia = FX
gain/loss). Alguna fija la tasa a la fecha de factura.

**Recomendación [Opinión]**: cada entrada del RSM guarda `functional_amount + fx_rate + fx_rate_source
(invoice_date | period_average | manual)`. Política por razón social: default **tasa a fecha de factura** (IFRIC 22
cuando se factura anticipado); `period_average` permitido con advertencia si la volatilidad supera un umbral. Tres
cuentas separadas: diferencia **no realizada**, **realizada** y **reajuste UF**.

## 5. Aprobación

- La aprobación comercial vive en la **cotización** (Salesforce CPQ Advanced Approvals por umbral de descuento;
  Chargebee CPQ no deja enviar sin aprobar; en el core de Chargebee solo aprueba price points).
  [SF](https://help.salesforce.com/s/articleView?id=sales.cpq_advanced_approvals.htm&language=en_US&type=5)
- Contract de Salesforce: `Draft → In Approval Process → Activated` (+ estados de Contract Management). Alguna aprueba
  **versiones**. Zenskar aprueba facturas. Chargebee: `active / non_renewing / paused / cancelled` sin aprobación.
- **Patrón**: aprobación comercial en la cotización; operativa (si existe) en la versión/cambio del contrato o en la
  factura. Estados base `draft → active → (paused) → expired | cancelled` + `non_renewing`.

**Recomendación [Opinión]**: estados `draft | pending_approval | active | paused | non_renewing | expired | cancelled`;
aprobación **opcional por holding** con reglas simples (descuento > X% sobre lista, FX/moneda fuera de política,
evergreen o plazo de pago > N días, TCV > Y) sobre el alta **y cada cambio**; si viene de una cotización aprobada, la
hereda. Mínimo útil: un aprobador por regla, aprobar/rechazar con comentario, evento en el log.

## 6. Documento fiscal

- **Odoo l10n_latam** (CL, PE, AR): el tipo se **calcula por defecto** según emisor + receptor + régimen (CL: tipo de
  contribuyente; PE: RUC → factura, DNI → boleta) y se recalcula al cambiar el partner.
  [Chile](https://www.odoo.com/documentation/17.0/applications/finance/fiscal_localizations/chile.html) ·
  [Perú](https://www.odoo.com/documentation/19.0/applications/finance/fiscal_localizations/peru.html)
- NetSuite MX: campos fiscales por país de la subsidiaria, en la transacción. Relvo: `fiscal_classification` en el
  vínculo razón social–cliente. Zenskar/Alguna/Stripe/Chargebee: no existe.
- **Patrón**: se define en la **razón social receptora** y se sugiere por combinación emisor × receptor; editable por
  documento si es compatible.

**Recomendación [Opinión]**: default desde `client_entity_clients.fiscal_classification` (A.1); receptor extranjero →
sugiere exportación; en el contrato se muestra **derivado**, con "cambiar" (override guardado en la ruta de
facturación, A.5); incompatibilidades → advertencia con corrección en un clic.

## Resumen de recomendaciones

| Tema | Recomendación | Impacto en modelo (sin eliminar campos) |
|---|---|---|
| Rev-rec no recurrentes | Método en el producto con default por tipo; override por línea con motivo | `revenue_rules` (existe) + `products.default_rev_method`, `contract_items.rev_method_override` + parámetros |
| Granularidad | Política por razón social: diario / mes parejo / mes prorrateado | `companies.revrec_granularity` |
| Precio vs facturación | `price_period` ≠ `billing_frequency`; `amount_basis`; descuento sobre lista | `contract_items.price_period`, `amount_basis`, `list_price_id` |
| Término | `fixed | evergreen` + renovación; evergreen sin TCV, RSM solo de lo facturado | `contracts.term_type`, `initial_term_months`, `renewal_mode`; `end_date` nullable |
| Multimoneda | Moneda por línea + `metrics_currency` en el contrato | `contracts.metrics_currency`; la `currency` actual = default de línea |
| Tasa de métricas | `billing_fx` por línea ≠ `metrics_fx` por política + "Impacto FX" | `holdings.metrics_fx_policy`, snapshot `metrics_fx_rate` |
| FX contable | Tasa a fecha de factura o promedio con advertencia; diferido no se re-mide; realizada / no realizada / reajuste UF | RSM: `functional_amount`, `fx_rate`, `fx_rate_source`; `companies.revrec_fx_policy`; cuentas contables |
| Aprobación | Opcional por holding, por umbral, en alta y versiones; heredada de la cotización | estado `pending_approval` (+ `non_renewing`), `approval_rules`, eventos |
| Documento fiscal | Derivado de la razón social receptora; override por ruta | `fiscal_classification` (A.1) + override en la ruta (A.5) |

No se pudieron leer completas: la doc de monedas de Zuora (bloqueo), el detalle de documentos de Odoo 15 y los
campos CFDI de NetSuite (se usaron resúmenes de búsqueda enlazados).
