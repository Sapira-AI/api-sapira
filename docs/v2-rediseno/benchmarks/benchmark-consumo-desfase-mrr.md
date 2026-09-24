# Benchmark — consumo con desfase, MRR de uso y granularidad del devengo

> 24-09-2026 · insumo de S5 (decisiones S5-5 y S5-6) de [`../auditoria-contratos.md`](../auditoria-contratos.md).
> Complementa [`benchmark-devengo-cronogramas-contabilidad.md`](./benchmark-devengo-cronogramas-contabilidad.md) §2-3.
> Etiquetas: **[Norma]** · **[Mercado]** · **[Opinión]**. No verificado: páginas de Stripe sobre uso (404; se usó su
> soporte y resultados de búsqueda); sin documentación pública de Amberflo ni ProfitWell sobre revenue de uso.

## 1. Consumo que se mide después del cierre

**[Norma]** El ingreso va en el **mes en que ocurre el consumo**, no en el de la factura. La solución práctica "right to
invoice" (IFRS 15 B16 / ASC 606-10-55-18) define **cuánto** se reconoce, no **cuándo**: el derecho a cobrar el uso de agosto
existe al 31-08 aunque la cantidad se conozca en septiembre
([PwC](https://viewpoint.pwc.com/dt/us/en/pwc/accounting_guides/revenue_from_contrac/revenue_from_contrac_US/chapter_6_recognizin_US/64measures_of_progre_US/641output_methods_US/6411right_to_invoice_US.html) ·
[Deloitte](https://dart.deloitte.com/USDART/home/codification/revenue/asc606-10/roadmap-revenue-recognition/chapter-7-step-4-allocate-transaction/7-5-allocation-variable-consideration)).
Con mínimos comprometidos y true-up se vuelve al modelo general (estimar la contraprestación variable con su restricción).
Lectura: al cerrar sin el dato se **estima** (no facturado / activo del contrato) y la diferencia contra el real es un **cambio
de estimación en el período abierto**, sin reabrir (IAS 8).

**[Mercado]**

| Enfoque | Quién | Cómo |
|---|---|---|
| Devengo en el mes del uso + reverso al facturar | Stripe · Orb · Zuora Revenue · NetSuite ARM | Stripe reconoce en el mes de la actividad y revierte al finalizar la factura; **Orb** registra el uso tardío como **catch-up el primer día del período abierto** (el cierre "garantiza que no habrá cambios"); Zuora lleva el uso sin factura a Unbilled Revenue; NetSuite asienta Unbilled / Deferred |
| Reconocer al facturar | Metronome · Maxio | La factura final es el reconocido; Maxio incluye el uso "en el mes facturado" |

Stripe tiene un toggle de **catch-up**: si el servicio empezó antes de la factura, reconoce todo lo pasado en el mes de la
factura "para no cambiar el pasado". **[Opinión]** Los sistemas de revenue no dejan el mes sin ingreso: estiman al cierre y
corrigen en el mes siguiente; "al facturar" es una simplificación aceptable solo si el desfase es parejo y no material.

## 2. MRR / ARR de consumo

- **ChartMogul**: separar fijo y uso en planes distintos y fechar el uso con el **período de servicio real**
  ([dev](https://dev.chartmogul.com/docs/implementing-usage-based-billing)).
- **Chargebee**: por defecto el uso entra al MRR en el **mes de la factura** (desfase visible) y tiene toggle para excluirlo
  ([doc](https://www.chargebee.com/docs/billing/2.0/kb/reports-and-analytics/how-is-metered-billing-calculated-in-mrr)).
- **Baremetrics**: el uso **no va en el MRR**; métrica aparte "Usage Revenue"
  ([doc](https://help.baremetrics.com/en/articles/12542396-usage-revenue)).
- Práctica común: ARR de uso = últimos 3 meses × 4 (o último × 12)
  ([Ordway](https://ordwaylabs.com/blog/calculate-arr-usage-pricing/)); m3ter separa mínimo comprometido de excedente y
  suaviza con promedio de 3–6 meses. Snowflake y Twilio no reportan ARR (usan crecimiento de ingreso, NRR, RPO).

**[Opinión]** Uso asignado al **mes de servicio**; **MRR comprometido** (fijos + mínimos) separado del **MRR de uso**
(promedio móvil de 3 meses); en el waterfall, una línea "variación de consumo", sin expansion/contraction; churn solo al
terminar el contrato.

## 3. Granularidad del devengo

Stripe (política global): por segundo, **por día (default)**, **mes parejo** y mes con primer y último prorrateados. Ejemplo
oficial, 120 USD por 4 meses del 15-jun al 13-oct
([ejemplos](https://docs.stripe.com/revenue-recognition/revenue-settings/examples)):

| Granularidad | Jun | Jul | Ago | Sep | Oct |
|---|---|---|---|---|---|
| Por día | 16 | 31 | 31 | 30 | 12 |
| **Mes parejo** | **30** | **30** | **30** | **30** | — |
| Primer y último prorrateados | 15,50 | 30,66 | 30,66 | 30,68 | 12,50 |

**Confirma la regla de Sapira (S5-5)**: en mes parejo, el mes de inicio cuenta completo y el total es la cantidad de meses del
ítem. NetSuite: "even periods" vs "exact days". Cambiar la granularidad reescribe asientos (Stripe recomienda reabrir antes).

## Recomendación para Sapira

| Tema | Recomendación | Impacto en modelo |
|---|---|---|
| Cierre sin la cantidad real | Fila de devengo **estimada** al cierre (mínimo contractual → promedio 3 meses → último real → manual) como no facturado | `quantity_source: estimated\|actual`, `estimation_method` en el devengo |
| Llega el real después | Sin reabrir: **true-up** en el primer período abierto, vinculado al mes de servicio | fila `kind: true_up` con `adjusts_period` |
| Política configurable | Por razón social: `variable_close: estimate` (recomendado) o `as_billed_lag` (simplificación registrada) | parámetro junto a la granularidad |
| `quantities` | Guardar el **mes de servicio** separado del mes de factura | `quantities.service_period` + `billing_period` |
| MRR de variables | Comprometido (CMRR) vs uso (promedio 3 meses, aparte); toggle para excluir el uso del MRR principal | `committed_mrr`, `usage_mrr_t3m` desde el devengo por mes de servicio |
| Waterfall | El uso va en "variación de consumo"; ramp-up como new; churn solo al terminar el contrato | categorías separadas para ítems de uso |
| Granularidad | `monthly_even` default (regla actual) + `daily` y opcional `monthly_prorated_first_last` por razón social; cambios solo en períodos abiertos | política por compañía |
| Mínimos y excedentes | Con mínimo + true-up, revisar B16; si no aplica, estimar con la restricción | flag `has_minimum_commitment` |
