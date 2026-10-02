# Spec · Revenue y Métricas v2 (módulo `metrics` + `/lab/revenue` + `/lab/metricas`)

> 01-10-2026 · Domi + Claude (sesión paralela, solo lectura). Estado: **aprobada por Domi 01-10** (con revisión de industria); en construcción.
> Fuentes: inventario completo del front viejo (`sapira-ai`: `/revenue`, `/reportes`, Dashboard), funciones SQL del devengo
> (`revenue_schedule_rebuild_contract_ccy`, `revenue_schedule_apply_fx_for_contract`, `assign_momentum_to_revenue_schedule`,
> `apply_pending_renewal_tail`, `rsm_rebuild_from_subscription`, `rsm_metrics`), entity `revenue_schedule_monthly`,
> [`spec-multimoneda-contrato.md`](./spec-multimoneda-contrato.md) §5, [`mapa-v2-contratos.md`](./mapa-v2-contratos.md) (L2: MRR sin pendiente),
> `HoldingMetricsService` (MRR del Dashboard), mockup O2C "7a Revenue / 7b Métricas" (`design-bundle`) y revisión de industria (§8).
> Datos verificados con SELECT sobre el holding demo Hanka (`05583c6e-…`). Nada de esto escribe en base.

## 0. Alcance y reglas

- **Solo lectura**: endpoints `GET` nuevos en `api-sapira/src/modules/metrics` (hoy solo tiene `HoldingMetricsService`); BFF
  `front-sapira/app/api/revenue/*` y `/api/metricas/*`; UI en `/lab/revenue` y `/lab/metricas`. Sin migraciones, funciones ni triggers.
- **Fuera**: `contracts/**`, `lab/contratos/**`, Dashboard (se ajusta después para leer estos endpoints), esquema.
- **Reglas duras** (del pedido):
  1. Todo monto agregado sale de las columnas `*_system_ccy` (sistema) o `*_ccy` (compañía) del RSM; `*_contract_ccy` solo con un contrato
     filtrado. **Nunca** `monthly_price`, `final_price` ni `total_value` de ítems sumados.
  2. `momentum` es **dato abierto**: la API no tiene lista cerrada; devuelve el valor que venga (hoy NEW, UPSELL, CROSS-SELL, DOWNSELL,
     CHURN, RENEWAL, BOP, PENDING_RENEWAL; mañana REACTIVATION, PAUSE, RESUME). El mapeo a categorías (§1.4) es una tabla con fallback
     "Otros", nunca un `switch` cerrado.
  3. **Filas sin convertir** (§1.3) nunca entran a un total: salen aparte en `unconverted` y la UI lo muestra.
- Holding por `HoldingScopeGuard` + `@HoldingId()`; nunca `holding_id` en query.
- Listas paginadas: la API responde como el resto de la casa (`{ data, items, pages, currentPage, limit }`) y la BFF normaliza a
  `{ data, total, currentPage, pages, limit }` con `lib/api/pagination.ts`. Matrices (movimientos, series, cohortes) no se paginan: son
  acotadas por rango (máx. 36 meses, como el roll-forward de NetSuite) y por `top` (filas de dimensión, con "Otros").

## 1. Definiciones únicas (las usan Revenue, Métricas y, después, Dashboard)

### 1.1 Moneda de lectura
`currency=system` (default, moneda del holding) · `currency=company` **solo con `company_id`** (si no, 400: sumar compañías en monedas
distintas es el bug de `rsm_metrics`) · `currency=contract` **solo con `contract_id`**. Es el mismo selector de tres monedas de Recurly
(transaccional / compañía / reporte). La respuesta trae siempre `currency` (ISO), nunca un `$`/`USD` fijo.

### 1.2 MRR y derivados (por mes `M`, sobre filas RSM del holding)
| Métrica | Definición | Hoy (bug que se corrige) |
|---|---|---|
| **MRR** | Σ `mrr_period_*` con `momentum IS DISTINCT FROM 'PENDING_RENEWAL'` | Card del viejo y Dashboard incluyen pendientes; waterfall no → 3 cifras distintas |
| **Pendiente de renovar** | Σ `mrr_period_*` con `momentum = 'PENDING_RENEWAL'`, + ítems/clientes | Igual que Contratos L2 (`NOT_PENDING_RENEWAL`) |
| **CMRR** (contratado) | Σ `cmrr_period_*` (sin pendientes): incluye firmados no iniciados (`COALESCE(booking_date,start_date) ≤ fin de mes`, lo hace el rebuild) | La matriz vieja re-filtraba por booking del contrato (3 respuestas) |
| **ARR / CARR** | 12 × MRR / CMRR del mes | — |
| **Clientes activos** | clientes con MRR del mes **> 0** | Viejo: cualquier fila RSM (incluye MRR 0, pendientes, colas de churn) |
| **ARPA** | MRR / clientes activos | No existía |
| **TCV (bookings)** | Σ `contracts.total_value_system_currency` por mes de `booking_date`, contratos no borrador ni borrados | No existía en Reportes |

**Por qué había dos MRR y cómo se trata en v2 (D3).** En dic-2025 (`implementacion-mrr-contracted-cmrr.md` de `sapira-ai`) se separó
*MRR reconocido* (`mrr_period_*` = lo devengado del mes: con consumo variable de `quantities`, descuentos por NC y prorrateo) de *MRR
contratado* (`mrr_period_contracted_*` = el plan, `monthly_price`). El 22-04-2026 (`rebuild_mrr_period_eom_unified`) el rebuild igualó
`mrr_period` al contratado para corregir el mes de término (Cerrejón); desde ahí solo el path legacy de `quantities`
(`revenue_schedule_update_period_quantities`) los vuelve a separar. En Hanka: 0 de 909 filas difieren. Lo que el "reconocido" quería
mostrar sigue siendo real, pero no es MRR (la industria excluye uso medido y descuentos puntuales del MRR: Stripe, ChartMogul). v2:
- **MRR** = el plan (columna `mrr_period_contracted_*`, la que no pisa nadie) + **CMRR**. Un solo MRR en Métricas.
- **Ingreso recurrente reconocido del mes** (Σ `recognized_period_*` de ítems recurrentes) en Revenue, junto al MRR, con la brecha
  "MRR vs reconocido" explicada (prorrateo, NC de descuento, consumo). En Hanka hay 30 filas donde difieren.
- **Consumo variable**: hoy el consumo v2 (`consumption_entries`, Pricing v2) **no llega al devengo**: el rebuild reconoce
  `final_price / term` y lo facturado sale de las líneas, así que en ítems medidos el diferido/por facturar refleja la diferencia
  plan ↔ consumo. Es decisión del devengo (R8); Métricas lo muestra aparte ("Ingreso por uso" desde lo facturado) y no lo mete al MRR.

### 1.3 Filas sin convertir (`unconverted`)
Una fila RSM no se suma si:
- `calc_version = 'missing_fx_rate'` (falta la tasa `item` del multimoneda: montos NULL), o
- en la moneda leída, `fx_to_system_source` / `fx_to_company_source` empieza por `missing_fx_rate` (hoy `apply_fx` igual escribe el monto
  **× 1.0** con esa marca: el viejo lo sumaba como si CLP fuera USD).
- **Excepto** (01-10, misma regla que el rebuild desde api v0.0.69): una fila de un mes en que el ítem no está activo (antes de su
  inicio o después de su fin) y con todos los montos del período en 0/NULL no es un hueco de tipo de cambio aunque traiga la marca
  (`inactiveEmptyRowSql`); no entra al aviso, a las líneas sin convertir ni a Excepciones.
- **Pendiente de renovar** (KPI de `mrr/overview` y total de `mrr/by-dimension`): suma de las filas `PENDING_RENEWAL` del mes en
  `mrr_period*` de la moneda leída, la misma regla que el KPI "Por renovar" de Contratos (`ContractsService.summary`), sin depender
  de las líneas convertidas del rango (`loadPendingRenewal`).

Toda respuesta con montos trae `unconverted: { rows, items, contracts: [{ contract_id, contract_number, client_name, months[], reason:
'item_fx_rate' | 'system_fx_rate' | 'company_fx_rate' }] }` y la UI pone un aviso "N contratos sin tipo de cambio: no están en los
totales" con enlace al 360. En Hanka hoy: 1 fila (contrato multimoneda sin tasa `item`, 09-2026).

### 1.4 Movimientos de MRR (cuadran por construcción)

**Qué hace la industria (§8.1).** El gráfico estándar de suscripciones **no es un waterfall**: es "MRR movements" (ChartMogul, Baremetrics,
Stripe, Recurly, Zenskar): una barra por mes con ganancias sobre cero y pérdidas bajo cero, línea de MRR neto y tabla debajo con drill-down.
El **waterfall/puente** de verdad (barras flotantes inicio → movimientos → cierre) es de finanzas y directorio (NetSuite, Maxio) y casi
ningún producto de suscripciones lo ofrece para un rango: es diferenciador. El gráfico del viejo mezclaba ambos (apilaba el BOP sobre los
movimientos, sin puente), por eso costaba leerlo. v2 tiene **los dos**, sobre el mismo cálculo.

**Cálculo.** Por ítem (`contract_item_id` o `subscription_item_id`) entre `M-1` y `M` con el MRR de §1.2; cada delta se clasifica:

| Caso del ítem | Subcategoría (`key`, abierta) |
|---|---|
| Aparece (`M-1` = 0, `M` ≠ 0) | `momentum` de su fila en `M` si no es `BOP`; si es `BOP` (p. ej. CMRR de firmado que inicia), la `categoria` del ítem; si no hay, `OTHER` |
| Fila explícita de movimiento en `M` (cola `CHURN` del rebuild, futuras `PAUSE`/`RESUME`) | ese `momentum` |
| Desaparece y lo renueva otro ítem que aparece en `M` (`renewed_by_item_id` / `renews_item_id`) | `RENEWAL`: neto = precio nuevo − anterior. A igual precio **no es movimiento** ("sin impacto", NetSuite) |
| Desaparece sin renovación ni churn (vence y pasa a pendiente) | `EXPIRED` ("vencido sin renovar" = *contract churn* de NetSuite) |
| Sigue vivo y cambia el monto en moneda de sistema/compañía | `FX` ("Efecto tipo de cambio"; con `currency=contract` no existe) |

**Categorías canónicas** (las 5 de ChartMogul/Stripe + FX), con la subcategoría original visible al expandir (modelo NetSuite):

| Categoría | Subcategorías hoy | Color |
|---|---|---|
| Nuevo | `NEW` | familia ganancia |
| Expansión | `UPSELL`, `CROSS-SELL`, `RENEWAL` con alza | familia ganancia |
| Reactivación | `REACTIVATION` (y `RESUME` cuando exista) | familia ganancia |
| Contracción | `DOWNSELL`, `RENEWAL` con baja | familia pérdida |
| Churn | `CHURN`, `EXPIRED` (y `PAUSE` cuando exista, D1) | familia pérdida |
| Tipo de cambio | `FX` | neutro, fila propia que **nunca** cuenta como expansión/contracción (consenso ChartMogul/Stripe/Chargebee) |
| Otros | cualquier `momentum` desconocido | neutro, con su nombre |

La tabla de mapeo vive en la API (`metrics-categories.ts`) y viaja en la respuesta (`categories[]`), así una subcategoría nueva aparece sin
tocar el front. `opening(M) = closing(M-1)` (se lee el mes anterior al rango: **nunca** arranca en 0) y `closing = opening + Σ movimientos`;
la respuesta trae `check` (debe ser 0) para tests y para el aviso de calidad.

Verificado en Hanka (sistema): ene-2026 hoy suma la renovación dos veces (BOP cae 446 y `RENEWAL` suma 446); jun→dic-2026 `PENDING_RENEWAL`
(974) aparece como movimiento todos los meses y nov→dic-2026 el MRR baja 760 sin movimiento que lo explique. Con §1.4 los tres cuadran.

### 1.5 Retención y churn (fórmulas de ChartMogul/Stripe, §8.1)
- **Del período** (mes o rango), con `opening` = MRR al inicio:
  - NRR = (opening + expansión + reactivación − contracción − churn) / opening;
  - GRR = (opening − contracción − churn) / opening (nunca > 100%);
  - Gross MRR churn = (contracción + churn) / opening · Net MRR churn = [(contracción + churn) − (expansión + reactivación)] / opening;
  - Quick ratio = (nuevo + expansión + reactivación) / (contracción + churn), **N/A** si el divisor es 0 (no 0);
  - Net new MRR = Σ movimientos sin FX; crecimiento = (closing − opening) / opening.
- **Interanual por cliente (YoY)**: sobre clientes con MRR > 0 en `M-12`: NRR_12 = Σ MRR_M / Σ MRR_{M-12};
  GRR_12 = Σ min(MRR_M, MRR_{M-12}) / Σ MRR_{M-12}. Es la principal en B2B (D6). El viejo llamaba "NDR" a la mensual y no tenía GRR.
- **Logo churn**: clientes con MRR > 0 en `M-1` y 0 en `M` / clientes activos en `M-1`. Downsell **no** es cliente perdido.
- **Motivos**: `contracts.churn_reason_id` → `churn_reasons` del holding (incluye inactivas; sin motivo = "Sin motivo").

### 1.6 Cohortes
Cohorte = mes (o trimestre) del primer MRR > 0 del cliente. Heatmap triangular cohorte × meses desde inicio, `basis=revenue` (puede pasar
de 100%) o `basis=logos`, igual que Stripe y ChartMogul. Segmentable con los mismos filtros.

### 1.7 Devengo (Revenue)
- **Reconocido / facturado del período**: Σ `recognized_period_*` / Σ `billed_period_*`.
- **Diferido y por facturar al cierre**: **por contrato** con el acumulado del último mes ≤ `M` de cada ítem (`net = Σ billed_cum −
  Σ recognized_cum`; diferido = max(net,0), por facturar = max(−net,0)), igual que el *netting* por contrato de Zuora. El viejo sumaba
  `*_eom` por fila, que el rebuild declara no sumables (clamp por fila, espejos con signo opuesto, cola de churn con acumulado repetido).
- **Roll-forward** (tabla puente estándar de Stripe/Maxio/Recurly/Chargebee), por período y compañía:
  diferido inicial + facturado − reconocido contra diferido ± reclasificación con por-facturar = diferido final; y el espejo para por
  facturar (activo contractual). Cada cifra abre la lista de clientes → contratos → ítems ("explicar esta cifra", Stripe).
- **Reconocimiento futuro (RPO)**: meses futuros del RSM (`recognized_period`) separados en *ya facturado* (consume el diferido del ítem en
  orden) y *por facturar* (backlog contratado), 12 meses + "Posterior" y corte corto/largo plazo. Es el waterfall proyectado de
  NetSuite/Recurly y la revelación de IFRS 15 §120. El waterfall histórico mes-de-factura × mes-de-reconocimiento (Stripe) **no** se puede
  sacar del RSM sin el vínculo factura → reconocimiento: queda anotado (D-API-3).
- **Diferencia de cambio** (solo `currency=system`): Σ `invoices.amount_system_currency` de las facturas emitidas del mes ligadas a
  contratos (tasa de emisión) − Σ `billed_period_system_ccy` (tasa del devengo). Informativa (M9). Fila propia en el resumen y el
  roll-forward, como el ajuste cambiario de Chargebee. En moneda de compañía no se puede (la factura no guarda monto en moneda de compañía):
  D-API-2. Ojo norma: por IFRIC 22 el diferido es no monetario y no se revalúa; hoy el RSM lo traduce con la tasa de cada mes (R7).
- **Cierre**: fecha de corte por compañía desde `accounting_period_cutoff` (solo lectura) y meses abiertos/cerrados distinguidos en
  gráficos (patrón Stripe). Cerrar/reabrir sigue en Configuración.
- **Rango de fechas** en meses (`from=YYYY-MM`, `to=YYYY-MM`), sin `toISOString()`: el viejo corría un mes en Chile.

### 1.8 MRR legacy (D2, revisado con SimpliRoute)

**Qué es** (`sapira-ai/docs/contratos/flujo-mrr-legacy.md`, `copilot/mrr-legacy-y-contratos.md`): MRR histórico registrado desde
facturas legacy para el go-live (una fila por mes × línea, `mrr_legacy = subtotal / term`), que después se activa como contrato
(`migrated_to_contract_id`) o se marca "No aplica" (`skip_activation` + motivo en texto libre). Solo lo usa SimpliRoute (11.848 filas).

**Lo que pesa** (SimpliRoute, USD, SELECT 01-10; "Legacy v2" de esta tabla excluía además los "No aplica" por duplicado, regla
descartada en L1: la cifra final queda entre "Legacy hoy" menos el doble conteo y esta columna):
| Mes | RSM (contratos) | Legacy hoy | Legacy v2 | Dashboard viejo | MRR v2 |
|---|---|---|---|---|---|
| 2025-06 | 30.261 | 532.798 | 530.152 | 563.059 | 560.412 |
| 2025-12 | 49.171 | 540.018 | 536.542 | 589.188 | 585.713 |
| 2026-06 | 294.610 | 244.164 | 223.499 | 540.327 | 518.109 |
| 2026-08 | 512.090 | 95.843 | 79.574 | 609.487 | 591.665 |

Sin legacy, SimpliRoute pasaría de 30 mil a 520 mil USD de MRR en 15 meses, un crecimiento falso: el legacy **es su historia** y va
al MRR. Lo que está mal hoy es el doble conteo (≈16 mil USD en ago-2026, igual que la auditoría) y los duplicados.

**Regla v2 (lectura, sin esquema)** — la regla de corte única de la auditoría S8a/U14:
- Cuenta `mrr_legacy_system_currency` de filas `is_recurring`, **salvo** la fila migrada a un contrato en meses **≥ primer mes con
  MRR del contrato** (ahí ya cuenta el RSM). ✅ Domi 01-10: el "No aplica" (`skip_activation` + motivo) significa **"no aplica
  activación"** (a ese MRR legacy no se le crea contrato); el motivo es un comentario y no cambia el cálculo del MRR; esa historia cuenta mientras tiene filas y, cuando termina sin contrato, es una baja más (ver waterfall). Los
  duplicados de datos se corrigen fuera de este desarrollo (L2).
- Origen visible: `source = contract | subscription | legacy` (chip "Legacy" y filtro), igual que suscripciones (D4).
- Waterfall ✅ Domi 01-10: el legacy se trata por línea `(cliente, producto, moneda)`.
  - **Legacy que pasa a su contrato** (`migrated_to_contract_id`, el contrato arranca y el legacy termina el mes anterior): **no es
    movimiento**, es el mismo MRR que cambia de origen. Se compara en **moneda de contrato** (`mrr_legacy` vs MRR del contrato): si hay
    diferencia real, ese neto va a **Expansión o Contracción** (subcategoría `LEGACY_MIGRATION`); la diferencia en moneda de sistema que no
    viene de la moneda de contrato va a **Tipo de cambio**. Sin diferencia, no aparece en el gráfico.
  - **Legacy que termina sin contrato** (`LEGACY_END`, p. ej. "no aplica activación"): **Contracción** si el cliente sigue con MRR,
    **Churn** si queda en 0 (misma regla que `DOWNSELL` vs `CHURN`). Si al cliente se le creó un contrato **sin** el vínculo
    `migrated_to_contract_id`, Métricas no puede saber que es el mismo MRR y lo verá como baja + nuevo: se lista en Excepciones
    ("legacy terminado y contrato nuevo del mismo cliente en el mismo mes") para revisarlo.
- Moneda: solo `currency=system` (el legacy no tiene columna en moneda de compañía); con `currency=company` el legacy queda en
  `unconverted` con motivo `legacy_without_company_ccy`.

**Puntos revisados con Domi (01-10)**:
- **L1** ✅ Los motivos de "No aplica" son comentarios; Métricas no los interpreta.
- **L2** ✅ Fuera de este desarrollo: revisar las filas "No aplica" por duplicado, cambio de moneda o de razón social (dato).
- **L3** ✅ Sin cambio: la moneda de contrato del legacy es fija por diseño (la factura legacy en su moneda corresponde a X en moneda de
  contrato) y la de sistema usa la política del sistema; dentro del mismo período de FX fijo del sistema no hay salto. Una diferencia en
  moneda de contrato al migrar es real (Expansión/Contracción), no de tipo de cambio.

## 2. Inventario del front viejo (`sapira-ai`) y veredicto

Lecturas: todo era `.from()` directo a `revenue_schedule_monthly`, `mrr_legacy`, `contracts`, `contract_items`, `clients`, `companies`,
`subscriptions`, `invoices`, `churn_reasons`, `company_account_mappings`, `financial_settings`; el único RPC era `get_current_user_holding_id`.
Ninguna lectura paginaba: **todas** se cortaban en 1.000 filas (`max_rows`). En v2 todo pasa por los endpoints de §3.

### 2a · `/revenue` (Reconocimiento de ingresos)
| Pantalla / pieza | Qué hace hoy | Veredicto |
|---|---|---|
| KPIs (reconocido del rango, diferido y por facturar al cierre) | Suma por fila, último mes con datos (no el elegido), rango corrido +1 mes, `$` fijo | **Mejorado**: §1.7 por contrato, mes elegido, moneda real, `unconverted` |
| Resumen: barras apiladas por dimensión (cliente comercial, razón social, países, producto, compañía, recurrente) top 10 + Otros; tabla detallada con filtros; CSV | Producto ↔ recurrente por nombre en minúsculas; filtros armados con lo ya filtrado | **Mejorado**: dimensiones desde la API (recurrente por `contract_items.is_recurring`), filtros con opciones del servidor, export XLSX |
| Detalle mensual: 20 columnas, vista contrato/compañía/sistema, filtros compañía/cliente/fechas/producto, CSV | Filtro de cliente roto con suscripciones; orden DESC + corte 1.000 pierde meses viejos; `$` en UF/CLP | **Mejorado**: tabla paginada en servidor con totales, mismas 3 monedas (contrato solo por contrato), export completo |
| Asientos contables por compañía con cuentas de `company_account_mappings` o defaults fijos, Cuadrado/Descuadre, CSV | "Todas" suma compañías en monedas distintas; descuadres falsos en suscripciones y NC fuera de ventana | **Mejorado**: siempre por compañía y en su moneda, cuentas del mapping (sin mapping → "sin configurar", no defaults escondidos), balance verificado |
| Configuración de reglas (`financial_settings`) | Editable sin permiso; el rebuild **no lee** esos campos | **Se oculta ahora y se construye de verdad después** (D5): está en v2 (auditoría S1-6/M6: granularidad del devengo **por compañía**; S5-5 tramos; benchmark Zenskar: librería de reglas, `revenue_rules` existe vacía). Antes de mostrarla, el devengo tiene que aplicarla (R9) |
| `EnableMonthlyScheduleCard`, `useRevenueJournal`, `revenue_monthly_journal/summary` | Código muerto; leen filas TOTAL inexistentes | **Se elimina** (retiro al switch, R6) |
| Roll-forward, reconocimiento futuro (RPO), cierre, excepciones | No existen | **Nuevos** (§1.7, estándar de la industria) |
| Pestaña Revenue del contrato (`ContratoRevenueTab`, cálculo en el cliente) | Segunda fuente de verdad: suma monedas distintas, no cuenta "Emitida" | Fuera de alcance: Contratos 360 › Devengo (D-CTR-2) |

### 2b · `/reportes` (Métricas)
| Pantalla / pieza | Qué hace hoy | Veredicto |
|---|---|---|
| KPI MRR/ARR | Incluye pendientes y colas de churn; delta 0% los meses de 31 días (`setMonth`) | **Mejorado** §1.2 |
| KPI CMRR/CARR | Tooltip falso ("excluye sin booking") | **Mejorado** §1.2 |
| KPI Churn rate | Churn+downsell / BOP mensual | **Mejorado**: gross/net MRR churn y logo churn §1.5 |
| KPI Pendiente de renovar (MRR/CMRR) | Correcto en concepto; delta roto | **Igual**, con delta correcto |
| Gráfico "MRR Waterfall" (recognized/contracted/arr/cmrr/carr) | No es waterfall: barras apiladas con el BOP encima; no cuadra (renovación doble, vencidos invisibles, primer mes en 0, pendiente como movimiento); 3 fetch | **Se reemplaza** por *Movimientos de MRR* (estándar) + *Puente* (waterfall real) §1.4; selector MRR/CMRR |
| Drill-down por cliente / segmento / mercado (tabs New/Upsell/Downsell/Churn), CSV | RENEWAL dentro de Upsell, sin cross-sell | **Mejorado**: clic en cualquier barra o celda, misma clasificación que el gráfico, agrupable por cliente/contrato/ítem/segmento/mercado |
| MRR Breakdown Avanzado (matriz + detalle) | Inicial ≠ Final anterior; suscripciones perdidas; ARR sin ×12 | **Se fusiona**: es la tabla bajo el gráfico de movimientos |
| MRR por dimensión (9 dimensiones, filtro, mapa de calor, XLSX) | Pendiente y legacy mezclados en el total | **Igual** + pendientes en columna aparte |
| Clientes activos (activos, nuevos, perdidos, retención) | Activo = cualquier fila; primer mes todos "nuevos"; segmentos/mercados fijos | **Mejorado** §1.2/§1.5, opciones del servidor |
| Churn analysis (perdidos, MRR perdido, motivos, detalle) | Downsell como cliente perdido; tasas fijas en 0; "Razón principal" al azar | **Mejorado** §1.5 |
| Ítems pendientes de renovación (árbol, antigüedad) | Ignora el rango; "contratos" cuenta clientes | **Mejorado**: + panel de renovaciones próximas 90/180/365 días con MRR en riesgo (nativo B2B) |
| Métricas SaaS (NDR, net new, quick ratio, growth, churn, expansion + sparklines) | NDR mal rotulada, sin GRR; benchmark de churn invertido | **Mejorado** §1.5 (+ NRR/GRR YoY, ARPA), con "¿cómo se calcula?" |
| Asistente de reportes IA | Botón sin handler | **Se elimina** ahora; "Explicar este mes" queda en backlog (§4.3) |
| Export CSV de la página | Roto | **Se reemplaza** por export por sección (XLSX) |
| Cohortes, TCV, GRR/NRR YoY | No existían | **Nuevo** §1.5–1.6 |
| MRR legacy (`mrr_legacy`) sumado a todo | Doble conteo con el contrato que lo migró (U14) y duplicados marcados que siguen sumando | **Mejorado** (D2, §1.8): entra al MRR con el corte U14, origen "Legacy"; el paso a su contrato no es movimiento salvo diferencia real en moneda de contrato |
| Suscripciones (Stripe) en RSM | MRR = facturado del mes (anual = 12× un mes); CHURN positivo | **Igual, como MRR** (D4): origen "Suscripciones" visible y filtrable; el devengo se corrige en la API (D-CTR-3) |

### 2c · Bugs del viejo que v2 corrige de raíz (resumen)
Corte silencioso a 1.000 filas · FX faltante sumado a 1.0 · tres MRR distintos · pendiente contado dos veces · "waterfall" que no es
waterfall ni cuadra · saldos por fila no sumables · rango corrido un mes por UTC y "mes anterior" = mismo mes en meses de 31 días ·
`$`/USD fijo en 10 componentes · listas de momentum duplicadas y distintas en 8 archivos · segmentos y mercados fijos · activo = cualquier
fila · downsell como churn de clientes · benchmark de churn invertido · NDR mal rotulada · filtros de cliente rotos · reglas cosméticas.

## 3. Endpoints (`/metrics`, solo GET)

Comunes: `from`, `to` (`YYYY-MM`, default últimos 12 meses), `currency` (§1.1), filtros `company_id[]`, `client_id[]`, `contract_id`,
`product[]`, `segment[]`, `market[]`, `industry[]`, `country[]`. Toda respuesta con montos: `currency`, `unconverted` (§1.3), `as_of`
(última actualización del RSM leída: `max(updated_at)`, para el "calculado hace X" de Stripe).

**Revenue**
| Ruta | Respuesta |
|---|---|
| `GET /metrics/revenue/summary` | `{ kpis: { recognized, billed, deferred_eom, unbilled_eom, fx_difference? }, months: [{ period, recognized, billed, deferred_eom, unbilled_eom, fx_difference?, closed }], top: { clients, products, companies }, cutoffs: [{ company_id, company_name, cutoff_date }] }` |
| `GET /metrics/revenue/rollforward?period=YYYY-MM\|from&to` | `{ deferred: { opening, billed, recognized, reclass, fx_difference?, closing }, unbilled: { opening, recognized_unbilled, billed, reclass, closing }, check }` |
| `GET /metrics/revenue/forward?as_of=YYYY-MM` | `{ months: [{ period, from_deferred, unbilled_backlog }], thereafter, short_term, long_term }` (RPO) |
| `GET /metrics/revenue/by-dimension?dimension=client\|client_entity\|client_country\|entity_country\|product\|company\|recurring&measure=recognized\|billed&top=10` | `{ dimension, periods[], rows: [{ key, label, values[], total }], others, totals[] }` |
| `GET /metrics/revenue/schedule` (paginado, `sortBy`, `sortOrder`, `limit` ≤ 1000) | filas período × contrato × ítem con compañía, contrato, cliente, razón social, países, producto, las 3 monedas y sus montos, `fx_source`, `unconverted` por fila; + `totals` del filtro. Sirve también para "explicar esta cifra" (mismos filtros que la celda) |
| `GET /metrics/revenue/journal?company_id&from&to` | `{ company, currency, accounts: { revenue, unbilled, deferred, configured }, months: [{ period, closed, entries: [{ code, name, debit, credit }], balanced, difference }] }` |
| `GET /metrics/revenue/exceptions` (paginado) | contratos sin tipo de cambio, ítems sin regla de devengo (RSM vacío con facturas), diferido negativo, compañías sin mapping de cuentas, cambios en meses cerrados (`updated_at` > corte) |

**Métricas**
| Ruta | Respuesta |
|---|---|
| `GET /metrics/mrr/overview?as_of=YYYY-MM` | `{ kpis: { mrr, arr, cmrr, carr, pending_renewal: { mrr, cmrr, items, clients, contracts }, active_clients, arpa, net_new_mrr, growth, gross_mrr_churn, net_mrr_churn, logo_churn, nrr, grr, nrr_yoy, grr_yoy, quick_ratio }` cada uno `{ value, previous, delta, formula }`, `sparklines` (12 meses) `}` |
| `GET /metrics/mrr/movements?basis=mrr\|cmrr` | `{ categories: [{ key, label, kind: gain\|loss\|neutral, subkeys[] }], months: [{ period, opening, movements: [{ category, key, amount, items, clients }], closing, check, partial }] }` — alimenta movimientos, puente y tabla |
| `GET /metrics/mrr/movements/detail?period\|from&to&category[]&key[]&group_by=client\|contract\|item\|segment\|market` (paginado) | drill-down: cliente, segmento, mercado, contrato, producto, subcategoría, monto |
| `GET /metrics/mrr/by-dimension?dimension=client\|product\|segment\|industry\|market\|company\|item_type\|unit_of_measure\|country&top=` | matriz + columna `pending_renewal` aparte |
| `GET /metrics/clients/activity` | `{ months: [{ period, active, new, reactivated, churned, logo_churn }] }` |
| `GET /metrics/churn` (paginado detalle) | `{ months: [{ period, clients_lost, mrr_lost, contraction }], by_reason: [{ reason, clients, mrr, pct }], data }` |
| `GET /metrics/renewals?window=90\|180\|365\|overdue` (paginado) | ítems por vencer o vencidos sin decisión: cliente, contrato, compañía, producto, fin, días, MRR; `summary { items, contracts, clients, mrr }` |
| `GET /metrics/cohorts?basis=revenue\|logos&grain=month\|quarter` | `{ cohorts: [{ cohort, size, initial_mrr, values: [pct…] }] }` |
| `GET /metrics/bookings?group_by=month\|company\|client` | TCV por mes de booking (§1.2) |
| `GET /metrics/filters` | opciones reales del holding: compañías, clientes, productos, segmentos, mercados, industrias, países, motivos de churn, moneda del sistema |

Implementación: SQL parametrizado con `DataSource.query` (patrón `quotes`), un constructor de filtros común, reglas de §1 como funciones
puras (`metrics-rules.ts`: clasificación por ítem, categorías, NRR/GRR, netting por contrato, RPO) testeadas con Jest; servicios
`revenue-metrics.service.ts` y `mrr-metrics.service.ts`. `HoldingMetricsService` sigue para el Dashboard hasta su ajuste.

## 4. UI (mockup O2C 7a/7b + patrones de §8; tema claro, `components/ui`, mismas piezas del lab)

### 4.1 `/lab/revenue` — por defecto: último mes abierto, moneda de sistema (o de la compañía si se filtra una)
Barra: rango de meses · compañía · moneda (sistema / compañía) · filtros en panel lateral · "calculado hace X". Aviso de `unconverted` y
de excepciones arriba cuando aplique. Pestañas:
1. **Resumen**: KPIs (reconocido, facturado, diferido, por facturar, diferencia de cambio) · reconocido vs facturado 12 meses con meses
   cerrados sólidos y abiertos rayados · por dimensión (top 10 + Otros) · top clientes/productos/compañías · cierre por compañía.
2. **Roll-forward**: tablas puente de diferido y por facturar; cada cifra → clientes → contratos → ítems (drawer "Explicar esta cifra").
3. **Reconocimiento futuro**: RPO a 12 meses + posterior, separado en diferido y por facturar, corto/largo plazo.
4. **Detalle mensual**: tabla paginada (3 monedas), totales, export XLSX.
5. **Asientos**: por compañía, cuentas del mapping, cuadra/no cuadra por mes, meses cerrados marcados, export.
6. **Excepciones** (contador en la pestaña): lista de §3 con enlace al 360.

### 4.2 `/lab/metricas` — por defecto: últimos 12 meses, MRR, moneda de sistema
Barra: rango · base MRR/CMRR · compañía · segmentos (filtros guardados) · comparar con período anterior. Secciones:
1. **KPIs** con delta, sparkline y "¿cómo se calcula?" (fórmula exacta de §1.5): MRR⇄ARR, CMRR⇄CARR, net new MRR, NRR YoY, GRR YoY, logo
   churn, ARPA, pendiente de renovar (→ renovaciones).
2. **Movimientos de MRR** (estándar): barras por mes ganancias arriba/pérdidas abajo, línea de MRR, mes en curso rayado, leyenda que
   oculta categorías; **tabla** debajo (inicio, categorías expandibles a subcategorías, FX, cierre) — reemplaza la matriz vieja. Clic en
   barra o celda → drill-down.
3. **Puente** (waterfall real, diferenciador): rango elegido, inicio → categorías → tipo de cambio → cierre, barras flotantes.
4. **Retención**: NRR/GRR del período y YoY, gross/net MRR churn, quick ratio, con benchmarks correctos (churn bajo = bueno).
5. **Renovaciones**: próximas 90/180/365 días y vencidas sin decisión, con MRR en riesgo.
6. **MRR por dimensión** con mapa de calor.
7. **Clientes**: activos, nuevos, reactivados, perdidos.
8. **Churn y motivos**.
9. **Cohortes** (heatmap triangular, MRR o logos).
10. **Bookings (TCV)**.

### 4.3 Configurabilidad: qué entra ahora y qué queda en backlog
| Ahora (v1 del lab) | Backlog (anotado, con dueño a definir) |
|---|---|
| Filtros por compañía, cliente, producto, segmento, mercado, industria, país, moneda; **vistas guardadas** (mismo patrón que `ContratosVistasMenu`) y estado en la URL (compartible, como Paddle) | Comparar hasta 5 segmentos lado a lado (Baremetrics) |
| Comparar con período anterior en KPIs y gráficos | Metas por métrica y anotaciones (ChartMogul/Baremetrics) |
| Ocultar/mostrar categorías; gráfico ⇄ tabla | Resumen semanal por correo/Slack con mayores aumentos y pérdidas (ChartMogul) |
| "¿Cómo se calcula?" en cada KPI | "Explicar este mes" con IA sobre los movimientos (copiloto) |
| Export XLSX por sección | — (D7: el momento del churn es regla fija, no configuración) |

## 5. Propuestas sobre el devengo (las decides tú; no se tocan en esta sesión)

| # | Propuesta | Por qué | Mientras tanto (lectura) |
|---|---|---|---|
| R1 | `revenue_schedule_apply_fx_for_contract`: sin tasa → montos **NULL** (como ya hace el multimoneda), no × 1.0 | Hoy convierte CLP como USD con la marca `missing_fx_rate` | §1.3 lo excluye por la marca |
| R2 | Rama `holding_fixed_period`: el primer `CASE` nunca es NULL (la inversa no se usa y sin tasa da 1.0) y la directa se invierte (convención contraria a "1 [from] = rate [to]") | Tasas de Hanka cargadas como "1 USD = X local" con `from = local` | Nada (los datos de Hanka cuadran con la convención actual) |
| R3 | `apply_pending_renewal_tail`: convertir con la tasa `item` (multimoneda) y no dejar en 0 los `*_system_ccy` de ítems en moneda del sistema | Pendiente mal en multimoneda | Se lee como viene |
| R4 | Cola de churn: la fila `BOP` y la `CHURN` repiten `recognized_cum`/`billed_cum` | Suma de acumulados duplicada | §1.7 toma un acumulado por ítem-mes |
| R5 | `rsm_rebuild_from_subscription`: MRR mensualizado (no el facturado del mes) y CHURN negativo | Anual = 12× en un mes | D4: entra como MRR; lo corrige la sesión de devengo (D-CTR-3) |
| R6 | Retirar al switch `rsm_metrics`, `revenue_monthly_journal`, `revenue_monthly_summary`, `populate_initial_revenue_schedule`, `get_current_mrr_by_holding` | Sin uso o leen filas TOTAL inexistentes | — |
| R7 | Traducción del diferido a moneda de compañía/sistema: tasa histórica de la factura (IFRIC 22: no monetario, no se revalúa) en vez de la tasa de cada mes | Hoy el saldo diferido "se mueve" con el tipo de cambio | Se lee como viene; la diferencia de cambio se informa aparte |
| R8 | Devengo de ítems medidos (Pricing v2): que el rebuild reconozca el consumo del período (`consumption_entries`) en vez de `final_price / term`, y retirar el path legacy `revenue_schedule_update_period_quantities` | Hoy el consumo v2 no llega al reconocido; el viejo `quantities` pisa `mrr_period` | Métricas usa el plan; Revenue muestra la brecha |
| R9 | Reglas de reconocimiento reales: granularidad por compañía (mensual / diaria, S1-6/M6), política de descuentos y método por producto o ítem (lineal, al facturar, por uso, por hito) como librería con prioridad (patrón Stripe/Zenskar), leídas por el rebuild; `financial_settings` se fusiona en la configuración tipada del holding (`spec-tablas-por-modulo.md`) | Hoy la pantalla vieja guarda valores que nadie lee | Pestaña Reglas oculta; la UI de Configuración del holding la toma cuando exista |

## 6. Dependencias (se anotan, no se construyen aquí)

- **D-CTR-1** (Contratos): mover `NOT_PENDING_RENEWAL` a `metrics` y que Contratos lo importe de ahí (hoy vive en `contracts.service.ts`). ✅ Domi 01-10: sí; lo hace la sesión de Contratos cuando `metrics` publique el módulo.
- **D-CTR-2** (Contratos): 360 › Devengo puede leer `GET /metrics/revenue/schedule?contract_id=` en vez de cálculo propio. ✅ Domi 01-10: sí, con condiciones: el endpoint devuelve el RSM por contrato/ítem tal cual (sin agregados ni semántica extra); el 360 muestra por defecto la moneda del contrato y suma el mismo selector de tres monedas (contrato / compañía / sistema) de Revenue; en multimoneda cada ítem muestra además su moneda.
- **D-CTR-4** (Contratos v2, API): para que el CMRR anticipe una baja (D7), los ítems espejo de baja deben nacer con `booking_date` =
  fecha en que se **registra** la baja, no la efectiva. Hoy la API v2 escribe `booking_date: p.effective` en
  `contract-changes.ts:2093` (espejo CHURN/DOWNSELL de `item_remove` / `contract_cancel`) y `:3777` (DOWNSELL de `item_change`). La baja
  `non_renewal` (solo `churn_date`) tampoco baja el CMRR antes del fin. No es solo del front viejo; se corrige en la sesión de Contratos.
  ✅ **Hecho 01-10 (sesión Contratos, v0.0.65)**: los espejos CHURN/DOWNSELL de `item_remove`/`contract_cancel`/pausa y los ajustes de
  `item_change` nacen con `booking_date` = fecha de registro (`ctx.today`); `start_date` sigue siendo la efectiva. Pendiente: `non_renewal`
  (sin ítem espejo) lo anticipa el RSM leyendo `churn_date` (devengo, decisión de Domi).
- **D-CTR-3** (devengo, otra sesión): R5, MRR de suscripciones mensualizado y CHURN negativo, corregido en la API.
- **D-API-2**: monto de la factura en moneda de compañía (diferencia de cambio por compañía).
- **D-API-3**: vínculo factura → reconocimiento para el waterfall histórico mes-de-factura × mes-de-reconocimiento (Stripe).
- **Dashboard**: al cerrar Métricas, `GET /dashboard/home` usa `mrr/overview` (hoy suma pendientes y legacy).

## 7. Decisiones para Domi

1. **D1 · Vencido sin renovar** ✅ Domi 01-10: subcategoría `EXPIRED` dentro de **Churn** y cuenta en GRR/NRR.
2. **D2 · MRR legacy (`mrr_legacy`)** ✅ Domi 01-10 (con la spec), revisada con SimpliRoute (§1.8): **sí entra al MRR**, con la regla de corte U14
   (ya decidida en la auditoría S8a) aplicada al leer, origen "Legacy" visible y filtrable. El paso legacy → su contrato no es
   movimiento; solo una diferencia real en moneda de contrato va a Expansión/Contracción (y la de sistema no explicada, a Tipo de cambio).
   Legacy que termina sin contrato: Contracción o Churn según el cliente.
3. **D3 · Un solo MRR + CMRR** (ver §1.2): MRR = plan (`mrr_period_contracted_*`); lo que resolvía el "reconocido" pasa a Revenue
   ("ingreso recurrente reconocido" + brecha explicada) y el consumo a "Ingreso por uso" aparte.
4. **D4 · Suscripciones de Stripe** ✅ Domi 01-10: su MRR **es MRR** y entra en todos los totales. La UI solo distingue el origen
   (`source: contract | subscription`, chip "Suscripciones" y filtro por origen). El error del devengo (R5: anual = 12× en un mes, CHURN
   positivo) se corrige en la API desde la sesión de Contratos/devengo (D-CTR-3), no con marcas aquí.
5. **D5 · Reglas de reconocimiento** ✅ Domi 01-10: se mantienen como requisito v2 pero **ocultas** en el lab hasta que el devengo las
   aplique (R9). No se construye pantalla de configuración que no haga nada.
6. **D6 · NRR/GRR** ✅ Domi 01-10: KPI principal = YoY por cliente; la del período en la sección Retención.
7. **D7 · Momento del churn** ✅ Domi 01-10, regla fija (sin configuración): el **MRR** baja cuando termina el servicio y ya no hay
   facturación; el **CMRR** muestra la contracción desde la **fecha de booking** de la baja (cuando se registra). Reactivación vs nuevo:
   según la categoría del ítem, sin ventana configurable. Dependencia D-CTR-4.
8. **D8 · Renovación con cambio de precio** ✅ Domi 01-10 (ya estaba definido así): el neto va a Expansión/Contracción (subcategoría
   "Renovación"); a igual precio no es movimiento.

## 8. Revisión de industria (resumen con fuentes)

### 8.1 Métricas
- **Gráfico estándar = movimientos, no waterfall**: ChartMogul (bandas apiladas, ganancias azul / pérdidas rosado, período en curso rayado,
  clic en celda → movimientos) [help.chartmogul.com/…/6245832909852](https://help.chartmogul.com/hc/en-us/articles/6245832909852); Baremetrics
  (barras + línea neta) [baremetrics.com/blog/new-feature-mrr-growth-chart](https://baremetrics.com/blog/new-feature-mrr-growth-chart); Stripe
  (MRR growth con **FX Adjustment** como componente, celda → eventos) [docs.stripe.com/billing/subscriptions/analytics](https://docs.stripe.com/billing/subscriptions/analytics.md);
  Recurly, Zenskar igual. Roll-forward en **tabla** hasta 36 meses: NetSuite SaaS 360. **Waterfall como tipo de gráfico**: Maxio.
- **Categorías**: New Business, Expansion, Reactivation, Contraction, Churn (ChartMogul, Stripe, Baremetrics, Recurly); NetSuite: renovación
  estándar = "No Impact", sin renovación = "Contract Churn", upsell/downsell con subcategorías
  [docs.oracle.com/…/article_4122558626](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/article_4122558626.html); Chargebee
  agrega Paused/Resume y fluctuación cambiaria [chargebee.com/docs/…/recurring-revenue](https://www.chargebee.com/docs/billing/2.0/reports-and-analytics/recurring-revenue).
- **Fórmulas**: NRR, gross/net MRR churn (ChartMogul [6886664393500](https://help.chartmogul.com/hc/en-us/articles/6886664393500),
  [204898491](https://help.chartmogul.com/hc/en-us/articles/204898491), [4414075567250](https://help.chartmogul.com/hc/en-us/articles/4414075567250));
  quick ratio con reactivación (Baremetrics); cohortes por primer MRR, logos y revenue (Stripe, ChartMogul).
- **Multimoneda**: una moneda de reporte, tasa histórica, FX como fila propia que nunca es expansión/contracción (ChartMogul "Exchange Rate
  Impact" [201520952](https://help.chartmogul.com/hc/en-us/articles/201520952), Stripe, Chargebee).
- **Configurabilidad**: segmentos guardados y comparación (ChartMogul, Baremetrics hasta 5); ajustes de definición de churn/descuentos
  (ChartMogul, Stripe); metas, anotaciones, benchmarks; resúmenes en Slack; "Explain this" con IA (ChartMogul); vista en la URL (Paddle).

### 8.2 Revenue
- **Reportes estándar**: roll-forward de diferido y de por facturar (Stripe Period summary
  [docs.stripe.com/revenue-recognition/reports/period-summary](https://docs.stripe.com/revenue-recognition/reports/period-summary), Maxio,
  Recurly, Chargebee con fila de ajuste cambiario [chargebee.com/docs/revrec/…/standard-reports](https://www.chargebee.com/docs/revrec/reports-analytics/standard-reports));
  waterfall facturación × reconocimiento (Stripe [reports/waterfall](https://docs.stripe.com/revenue-recognition/reports/waterfall)) y
  diferido proyectado corto/largo plazo (NetSuite ARM); asientos debe/haber con "correcciones" de períodos cerrados (Stripe
  [debits-and-credits](https://docs.stripe.com/revenue-recognition/reports/debits-and-credits)).
- **Patrones**: KPIs del período (Recurly, 7 tarjetas); meses abiertos/cerrados por color y "explicar esta cifra" hasta la factura (Stripe
  [audit-numbers](https://docs.stripe.com/revenue-recognition/reports/audit-numbers)); cierre manual con lo tardío como corrección en el
  período abierto (Stripe, Orb); controles y excepciones explícitas (Chargebee, NetSuite "Unplanned"/"Unassigned"); frescura de datos (Stripe).
- **FX**: Chargebee registra contrato vs factura como ajuste de revenue reclasificable; NetSuite ajusta al cierre; IFRIC 22: anticipo no
  monetario, no se revalúa [ifrs.org/…/ifric22](https://www.ifrs.org/content/dam/ifrs/publications/html-standards/english/2021/issued/ifric22-ie.html).
- No accesibles: Zuora Revenue (docs bloqueadas), Leapfin (solo marketing), Mosaic (redirige). Sage Intacct y RightRev solo por terceros.
