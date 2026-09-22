# 📊 Feature nueva v1.2 — Presupuesto vs Proyección vs Real (ventas, facturación, caja)

> **Pedido de Domi (22-08)**: agregar **budgets** de ventas, de facturación y de caja (ingresos) para tener un reporte **budget vs forecast vs real** — por ejemplo para el seguimiento de cumplimiento de los vendedores, que es muy importante. Es un feature que no existe y ningún benchmark trae completo. Formato HOY → DELTA.

## HOY (verificado)

- **No existe budget** en el modelo (ninguna tabla; `revenue_rules` vacía no tiene relación). En la web, "Budget" y "Cashflow" figuran en **Labs** como "coming soon".
- **Real** ya existe en tres planos: ventas = cotizaciones Firmadas/Contrato creado con `booking_date` (panel Vendedores: ranking, ciclo de venta, tasa de cierre — explícitamente "no calcula comisiones"); facturación = facturas emitidas (RSM billed, reportes); caja = pagos registrados/conciliados (tab Cuentas por Cobrar).
- **Forecast parcial**: la tab AR tiene **proyección de cobros semanal** (por vencimiento); existen facturas **Por Emitir** programadas (= proyección de facturación implícita) y **Pending Renewal** (renovaciones pendientes con métricas).
- Dimensiones disponibles: vendedor (`sellers`, `quotes.seller_id`), compañía emisora, producto, segmento/industria/mercado, cliente, moneda sistema (RSM `*_period_system_ccy`).

## DELTA — el modelo de tres planos

| Plano                     | Qué es                                      | Fuente                          | Ventas                                                                                                  | Facturación                                                                         | Caja                                                                                                 |
| ------------------------- | ------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| **Presupuesto** (budget)  | Meta definida por el negocio                | carga/edición del usuario       | cuota por vendedor / período / producto / segmento                                                      | monto por mes / compañía / cliente                                                  | ingreso esperado por mes / compañía                                                                  |
| **Proyección** (forecast) | Lo que los datos vivos dicen que va a pasar | calculado, con snapshot mensual | pipeline de cotizaciones ponderado por etapa (probabilidad por `quote_stage`) + renovaciones pendientes | facturas Por Emitir programadas + contratos activos (RSM futuro) + consumo estimado | facturas emitidas por vencimiento × comportamiento de pago (DSO por cliente) + Por Emitir × términos |
| **Real**                  | Lo que pasó                                 | ya existe                       | cotizaciones firmadas por `booking_date` (+ upsell/downsell como ventas netas)                          | facturas emitidas (RSM billed)                                                      | pagos conciliados                                                                                    |

**Reporte**: budget vs forecast vs real por período y dimensión, con **% de cumplimiento, desvío y proyección de cierre** ("a este ritmo el vendedor X termina el trimestre al 78%"). Primera vista prioritaria: **cumplimiento por vendedor** (cuota vs pipeline vs cerrado). Segunda: facturación y caja por compañía (para finanzas).

## Modelo de datos propuesto (paso 2)

- ➕ **`budgets`**: `tenant/holding_id, kind (ventas|facturacion|caja), name, version/escenario (base|optimista|…), currency (moneda sistema), period_granularity (mes), status (draft|active|archived)`.
- ➕ **`budget_lines`**: `budget_id, period (mes), dimension_type (vendedor|compañía|producto|segmento|cliente|total), dimension_id, amount` — una línea por celda; carga por planilla/import con preview y edición inline.
- ➕ **`forecast_snapshots`** (opcional, recomendado): foto mensual del forecast calculado por dimensión, para medir **precisión de la proyección** en el tiempo (forecast vs real posterior). El forecast vivo no se almacena, se calcula.
- Reutiliza: `sellers`, `quotes`/`quote_stages` (ponderación por etapa = nuevo atributo `win_probability` en la etapa), facturas Por Emitir, RSM, AR/DSO, `companies`.
- Las **métricas de budget** son candidatas naturales a **billable metric/consumo interno** para alertas (ver agentes).

## Cómo se conecta con lo demás

- **Agentes de alerta** (doc de agentes, F1): "vendedor X al 40 % de su cuota a mitad de mes", "facturación proyectada del mes 15 % bajo presupuesto", "caja proyectada no cubre el presupuesto de ingresos" — alertas accionables con recomendación.
- **Reportes**: entra como sección nueva en `/reportes` (moneda sistema, regla vigente) y como tab en el panel de Vendedores (P2 #8 del ROADMAP se rediseña alrededor de esto).
- **Copilot/insights**: preguntas como "¿quién va bajo cuota este trimestre?" salen del mismo modelo.
- Reemplaza los items de **Labs "Budget" y "Cashflow"** de la web por producto real.

## Benchmarks (qué hay y qué no)

- **Alguna**: `insights` con AR aging, billings, revenue y **MRR/ARR/ACV por suscripción** — reporting, sin budget.
- **Maxio Core (SaaSOptics)**: `renewal_probability`, `renewal_factor` y perfiles de auto-renovación en cada Transaction → forecast de renovaciones; sin cuotas de venta.
- **Zenskar**: Insights agent (MRR trend, breakdown por producto/segmento), `Equally by months with estimated transaction price` + true-up (estimación como parte del devengo).
- **Relvo**: solo aging de cobranza.
- **Conclusión**: nadie tiene **budget de ventas ligado a cotizaciones y vendedores** — es diferenciador de Sapira porque el ciclo parte en la venta (B1 del doc 03). Forecast de caja por DSO y de facturación por Por Emitir sí tienen análogos parciales.

## Decisiones para Domi

1. **Dimensiones mínimas de la v1**: propuesta = vendedor (ventas) + compañía emisora (facturación y caja); producto/segmento/cliente en v2.
2. **Qué cuenta como "real" de ventas**: cotización firmada por `booking_date` (propuesto, ya existe) — ¿en valor total del contrato, en MRR, o ambos?
3. **Ponderación del pipeline**: probabilidad por etapa de cotización (configurable por tenant) vs probabilidad por cotización.
4. **Escenarios** (base/optimista/pesimista) desde la v1 o solo "base".
5. **Moneda**: siempre moneda sistema (regla vigente de reportes) — confirmar.
