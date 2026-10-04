# Análisis · tipos de cambio y MRR histórico (ex MRR legacy)

> Análisis **solo lectura** de producción y código (2026-10-04, Claude para Domi). No se corrigió nada. Origen: Domi revisó el
> front nuevo y vio que (1) faltan tipos de cambio y (2) el MRR histórico tiene que estar en reportes y Métricas para que no "se vea
> feo". Complementa [`auditoria-datos-switch.md`](./auditoria-datos-switch.md), [`spec-revenue-y-metricas.md`](./spec-revenue-y-metricas.md)
> §1.8 / D1–D8 y [`spec-multimoneda-contrato.md`](./spec-multimoneda-contrato.md). Al resolver un punto se marca aquí.

## 0. Cómo se midió

- Cada consulta: `BEGIN TRANSACTION READ ONLY; <SELECT>; ROLLBACK;` contra `.env.prod.db` (nunca `SET SESSION`).
- Holdings: SimpliRoute (SR), TiMining (TM), uPlanner (UP). Hanka (demo) y Lenosoft se miran solo de pasada.
- Montos "USD" = moneda del sistema de los tres holdings (todos `system_currency = USD`, política `fixed_period`).
- Convenciones de tasa (no son bugs, pero confunden): `holding_fx_period_rates` guarda "1 [to] = rate [from]" (CLP→USD = 930);
  `exchange_rates` y `contract_fx_period_rates` (item) guardan "1 [from] = rate [to]"; `invoices.fx_contract_to_system` y
  `mrr_legacy.fx_contract_to_system` se **dividen**; `revenue_schedule_monthly.fx_contract_to_system` se **multiplica**.

---

## Parte 1 · Tipos de cambio

### 1.1 Resumen

| # | Hallazgo | Holding | Tamaño | Dónde se ve |
|---|---|---|---|---|
| F1 | **7 facturas multimoneda con el monto en moneda de sistema = monto en CLP** (`fx_contract_to_system = 1`) | SR | **35.451.609 "USD"** (≈ 38 mil USD reales) | Facturación: Resumen (Facturado, Por cobrar), Calendario, Cuentas por cobrar, export |
| F2 | **Faltan tasas fijas del holding 2027+** (y TM CLF 2027) | UP, TM, SR | 357 filas del devengo, 18 contratos | Ingresos › Futuro y Excepciones, Métricas CMRR/renovaciones ≥ 2027 (aviso "Sin tipo de cambio") |
| F3 | **338 filas del devengo viejas con tasa 1,0** (`missing_fx_rate` calculado antes del arreglo S5-10) | UP, TM, SR | UP COP ene-2027: 102.352.909 "USD" de MRR en un mes | Hoy nada (meses futuros, Métricas/Ingresos las excluyen); **Dashboard y Cliente 360 las sumarían al llegar ene-2027** |
| F4 | Facturas creadas antes de cargar la tasa fija, nunca recalculadas (`total_system_currency` NULL) | UP (12 pagadas), TM (3 por emitir 2027) | 12 facturas pasadas | Facturación: "N facturas sin conversión no suman" |
| F5 | **EUR/USD diario invertido desde 2026-01-02** (serie Banco Central `F072.EUR.USD` = euros por dólar, guardada como EUR→USD) | todos (latente) | 208 días y 10 promedios mensuales 2026 con 0,85 en vez de 1,17 | Hoy nadie la usa (ningún holding `monthly_avg` con EUR); rompería un holding o fallback diario con EUR |
| F6 | Huecos en tasas diarias y promedios: USD/ARS ago–dic 2025 (y 2024 guardado como `USD/ARG`), USD/BRL y USD/UYU oct–dic 2025, USD/EUR desde may-2026 | todos (latente) | 5 pares | Solo afecta `monthly_avg` o fallback diario; los 3 holdings usan tasa fija |
| F7 | Monedas en uso sin ninguna fuente: AUD (TM tiene contrato), GBP (SR, Hanka); EUR sin tasa fija en SR | TM, SR | TM AUD cubierto por tasa fija hasta 2027 | Ninguno hoy |

### 1.2 Monedas y política por holding

| Holding | Sistema / política | Monedas de contratos (n) | Monedas de facturas | Tasa fija del holding cubre |
|---|---|---|---|---|
| SR | USD / `fixed_period` | USD 134, CLF 250, MXN 102, PEN 44, COP 30, UYU 5, CLP 2 (hasta 2028-04) | USD, CLP, MXN, COP, PEN, CLF, UYU | ARS BRL CLF CLP COP MXN PEN UYU **2024–2027**; sin EUR/GBP (en `currencies_in_use`, sin contratos) |
| TM | USD / `fixed_period` | USD 42, AUD 1, CLF 1, CLP 1 (hasta 2029-03) | USD, CLP, AUD | AUD 2024–2027, **CLF solo 2025–2026**, CLP 2025–2027 |
| UP | USD / `fixed_period` | USD 42, CLF 12, COP 6, MXN 1, EUR 1 (hasta 2029-11) | USD, CLP, CLF, COP, MXN, EUR | CLF CLP COP MXN PEN EUR **solo 2024–2026**; sin ARS (en uso, sin contratos) |

`contract_fx_period_rates`: solo Hanka (demo) y 1 tasa de compañía USD→MXN en SR (sep-2026). Ninguna tasa en 0 ni negativa.

### 1.3 Devengo (Ingresos / Métricas): qué falta

Filas del RSM con `fx_to_system_source = 'missing_fx_rate'` (todas en meses futuros):

| Holding | Moneda | Meses | Filas | Contratos | ¿Hay tasa hoy? | Causa |
|---|---|---|---|---|---|---|
| UP | CLF | 2027-01 → 2029-03 | 223 | 8 | No | Falta tasa fija UP 2027–2029 |
| UP | COP | 2027-01 → 2028-06 | 104 | 4 | No | ídem |
| UP | MXN | 2027-01 → 2027-07 | 7 | 1 | No | ídem |
| TM | CLF | 2027-01 → 2027-11 | 11 | 1 | No | Falta tasa fija TM CLF 2027 |
| TM | CLP | 2027-01 → 2027-03 | 6 | 1 | **Sí** (920, cargada 26-08) | Fila no recalculada |
| SR | CLF | 2028-01 → 2028-03 | 11 | 4 | No | Falta tasa fija SR 2028 |
| SR | PEN | 2028-01 | 1 | 1 | No | ídem |
| SR | MXN | 2027-01 | 2 | 1 | **Sí** (19) | Fila no recalculada |

- 338 de esas filas tienen además `fx_contract_to_system = 1` y montos en sistema = montos en moneda de contrato (calculadas antes
  del arreglo S5-10 del 01-10, que en prod **sí** está aplicado en `revenue_schedule_apply_fx_for_contract`; 27 de UP ya están en NULL).
  Montos inflados acumulados: UP 1.332.709.668, TM 3.120.941, SR 14.108 "USD".
- Métricas e Ingresos las **excluyen** (`unconvertedSql` mira `missing_fx_rate`) y muestran el aviso "Sin tipo de cambio" +
  Excepciones › "Falta tipo de cambio". Lo que queda fuera del Futuro (convertido a la tasa 2026 como referencia): UP ≈ 397 mil
  USD en CLF + 349 mil en COP + 15 mil en MXN; TM ≈ 40 mil en CLF + 3,4 mil en CLP.
- **Dashboard y Cliente 360 no aplican ese filtro** (`holding-metrics.service.ts`, `client-metrics.service.ts` suman
  `mrr_period_system_ccy` directo). Hoy no se nota porque leen el mes en curso; en **ene-2027** el MRR de UP saltaría en
  ≈ 102 millones "USD" y el de TM en ≈ 1 millón si nada se recalcula.

### 1.4 Facturación (montos en moneda de sistema y envío al ERP)

- **F1 · SR, 7 facturas** de 4 contratos USD con ítems USD + CLF unificados a una factura CLP (CTR-2026-110, -151, -173-WSP,
  -Tercerizado; ítems `manual_unify`/`spot_unify`): la cabecera quedó con `contract_currency = 'CLP'` (el contrato es USD),
  `fx_contract_to_system = 1` y `total_system_currency` = total en CLP. 5 emitidas (Vencida/Enviada, jul–sep 2026) + 2 Por Emitir.
  Facturación suma `invoices.total_system_currency` (`billing-read.service.ts`), así que Facturado/Por cobrar en USD de SR llevan
  **≈ 35,4 millones de más**. Causa probable: la cabecera de la factura unificada multimoneda toma la moneda de factura como
  moneda de contrato (`multicurrency-invoices.ts` / `unify_invoices_multi_contract`); el trigger `auto_populate_invoice_fx_to_system`
  ve "CLP" y el camino API `api-written-fields.ts` no la corrige. Hay que confirmarlo en código antes de tocar.
- **F4 · UP, 12 facturas pagadas** (9 EUR 2025, 2 CLF 2024, 1 MXN 2024) creadas en mar-2026 cuando aún no existían las tasas fijas
  (cargadas 14-04): quedaron con `total_system_currency` NULL y nada las recalcula (el trigger solo corre en INSERT/UPDATE). Hoy
  `calculate_system_fx_rate` ya devuelve tasa para todas. TM: 3 facturas CLP Por Emitir 2027 en el mismo caso (tasa cargada 26-08).
- **Envío al ERP: no bloqueado por FX.** Va en moneda de factura; las líneas multimoneda Por Emitir sin `fx_contract_to_invoice`
  (≈ 1.000 en SR, la mayoría futuras) toman la tasa diaria al emitir, y CLF/CLP, USD/CLP, COP, MXN, PEN y UYU diarias están al día
  (hasta 02-10 / 04-10). Las 7 de F1 tienen bien los montos en CLP; solo está mal su monto en USD.

### 1.5 Fuentes y scheduler (`src/modules/banco-central/**`)

- Pares que sincroniza el Banco Central de Chile: USD/CLP, USD/ARS, USD/COP, USD/MXN, USD/UYU, USD/BRL, **EUR/USD** (serie
  `F072.EUR.USD.N.O.D`, que en realidad es EUR por USD → **F5**), CLF/CLP; CLF/USD se calcula (CLF→CLP→USD). USD/PEN viene de Perú
  API (SUNAT). **No hay fuente para AUD ni GBP** (GBP y los cruces ARS/BRL/UYU… son de una sola carga `exchangerate-api` del 02-01).
- El cron corre cada hora y sincroniza **solo el día de hoy** (`startDate = endDate = today`) con 3 reintentos: si un día falla no
  hay recuperación automática. Los huecos de oct–dic 2025 coinciden con el cambio del sistema viejo (`BANCOCENTRALCHILE`, `USD/ARG`)
  al nuevo, que empezó USD/ARS en 2025 y EUR/USD recién el 2026-01-02. `fx_api_sync_log` solo tiene 3 filas (el scheduler nuevo no
  escribe ahí).
- `exchange_rates_monthly_avg` tiene 14 meses futuros (nov-2026 → dic-2027, `data_points = 1`, calculados el 14-09) para CLF/CLP,
  CLP/USD, COP/USD, MXN/USD, PEN/USD y cruces a CLP: proyecciones cargadas a mano (no las escribe ningún código versionado).
- **La causa de fondo de "faltan tipos de cambio" no es el scheduler**: los 3 holdings usan `fixed_period` y lo que falta son
  **tasas fijas del holding para 2027+** (UP, TM CLF) y 2028 (SR), más filas y facturas que no se recalcularon al cargarlas.

---

## Parte 2 · MRR histórico (ex MRR legacy)

### 2.1 Quién lo tiene

Solo **SimpliRoute**: 11.848 filas (`mrr_legacy`), 684 clientes, 2024-01 → 2027-02. TM y UP no tienen `mrr_legacy`: su historia
está en contratos `is_legacy` (42 y 59) con devengo desde 2024, así que para ellos el problema no aplica.

| Filas SR | n |
|---|---|
| Recurrentes / no recurrentes | 11.789 / 59 |
| Migradas a contrato (`migrated_to_contract_id`) | 9.684 (530 contratos) |
| `skip_activation` (sin contrato a propósito) | 1.591 |
| Sin monto en sistema (`mrr_legacy_system_currency` NULL) | 46, todas no recurrentes y sin monto: no afectan |

### 2.2 Cuánto pesa (SR, USD, corte U14 aplicado)

| Mes | MRR histórico | Contratos (RSM) | Suscripciones | Sin histórico | **Con histórico** |
|---|---|---|---|---|---|
| 2024-06 | 5.097 | — | — | 0 | 5.097 |
| 2024-12 | 352.384 | — | — | 0 | 352.384 |
| 2025-01 | 476.952 | — | 29.081 | 29.081 | **506.033** |
| 2025-06 | 532.798 | — | 30.261 | 30.261 | **563.059** |
| 2025-12 | 540.018 | 14.838 | 34.333 | 49.171 | **589.188** |
| 2026-03 | 524.128 | 31.068 | 40.967 | 72.035 | **596.163** |
| 2026-05 | 379.587 | 193.433 | — | 193.433 | **573.020** |
| 2026-06 | 228.719 | 294.610 | — | 294.610 | **523.329** |
| 2026-08 | 79.574 | 512.090 | — | 512.090 | **591.665** |
| 2026-10 | 46.343 | 520.093 | — | 520.093 | **566.437** |

Sin el histórico SR "crece" de 29 mil a 520 mil USD en 2025–2026: crecimiento falso. Con el histórico la serie es plana
(≈ 506–617 mil), que es la realidad.

### 2.3 Dónde se usa hoy

| Lugar | ¿Incluye MRR histórico? | Detalle |
|---|---|---|
| Dashboard (`holding-metrics.service.ts`) | Sí, con corte U14 | Suma `mrr_period_system_ccy` + legacy recurrente |
| Clientes (indicadores, 360) | Sí, con corte U14 | "Mes en curso · contratos, suscripciones y MRR histórico" |
| Métricas `/metrics/*` (resumen, movimientos/puente, por dimensión, clientes, churn, cohortes, retención) | Sí (`loadLegacyRows`, corte U14, D2) | Filtro "Origen" con "MRR histórico" |
| Métricas › Renovaciones y Bookings | No | Correcto: el histórico no tiene renovación ni TCV |
| **Ingresos** (`revenue-metrics.service.ts`: resumen, rollforward, futuro, por dimensión, detalle, asientos) | **No** (filtra `source != 'legacy'`) | SR 2025 muestra ≈ 30 mil USD/mes reconocidos (solo Stripe) contra ≈ 550 mil de MRR |
| Ingresos › Excepciones | Solo `legacy_unlinked` | "MRR histórico sin contrato" |
| Reportes (`/reportes`) | No aplica | Solo existe Integración ERP; el "reportes" del front viejo es Métricas |

### 2.4 Qué se ve feo

1. **Arranque falso en 2024 (Métricas, cohortes, retención 12 m).** Las facturas legacy de SR empiezan en ene-2025
   (`invoices_legacy`); las filas 2024 son solo las que caen hacia atrás. Se ve 3.873 USD en ene-2024 → 477 mil en ene-2025 (2 → 398
   clientes): cohortes 2024 vacías, NRR/GRR y "Nuevo" inflados en dic-2024/ene-2025 si el rango toca 2024.
2. **Empalme histórico → contrato (abr–ago 2026).** De 529 contratos con histórico migrado: 405 empalman exacto (bien, no es
   movimiento por D2), 82 se solapan (el corte U14 los recorta, bien), **29 dejan meses sin MRR** (50.281 USD de último mes
   histórico: el puente los muestra como baja + nuevo) y **13 contratos sin MRR en el devengo** (9.863 USD: el histórico sigue
   sumando y al terminar es baja). La caída de jun-2026 (523 mil vs 573 mil en may) sale de aquí.
3. **Bajas de histórico sin contrato.** Líneas recurrentes no migradas que terminan: las `skip_activation` (179 clientes) son bajas
   reales; las **pendientes de activar** (56 clientes) también salen como churn, con picos de 26.761 USD en jun-2026 y 14.050 en
   sep-2026. 4 líneas pendientes siguen vigentes en oct-2026 (13.170 USD) y 1 skip (23 USD).
4. **Ingresos sin historia** (punto 2.3): para SR el devengo 2025 y la relación "recurrente reconocido vs MRR" de Ingresos no
   cuadran con Métricas ni con el Dashboard.
5. **Nombre inconsistente.** Filtro, Clientes y Excepciones dicen "MRR histórico"; chips de Métricas/Ingresos
   (`MetricsUi.tsx`, `RevenueUi.tsx`), insights, motivo `legacy_without_company_ccy` y el API (`sourceLabel` → "Legacy",
   motivo de churn "Legacy sin contrato") dicen "MRR legacy"/"Legacy".
6. **Moneda de compañía.** Con `currency=company` el histórico queda en "sin convertir" (no tiene columna en moneda de compañía):
   el total de Métricas por compañía de SR cae a lo del devengo.
7. (Relacionado, no FX) **Dashboard ≠ Métricas en el mes**: Dashboard suma las filas `PENDING_RENEWAL`; Métricas las muestra
   aparte. Oct-2026: UP 306.934 vs 227.562, TM 424.083 vs 317.979, SR 520.093 vs 516.437 (sin histórico). Ya anotado en la spec §6.

---

## Parte 3 · Propuesta

### 3.1 Antes del switch

| # | Qué | Quién decide |
|---|---|---|
| A1 | **Cargar tasas fijas faltantes** (Administración › Monedas): UP CLF/CLP/COP/MXN/PEN/EUR 2027–2029, TM CLF 2027, SR todas 2028. Recomendado: cargar hasta el fin del contrato más largo (2029-11) con la tasa 2026 como provisional y nota "revisar". | **Domi**: valor de cada tasa (opción a: repetir 2026; opción b: proyección actual; opción c: pedirla a cada cliente) |
| A2 | **Recalcular sin rebuild** las filas `missing_fx_rate` de los 18 contratos afectados (`revenue_schedule_apply_fx_for_contract` por contrato, ya con S5-10) después de A1. Limpia F2 y F3 juntas. | Ejecuta Claude con OK |
| A3 | **Dashboard y Cliente 360 excluyen `missing_fx_rate`** igual que Métricas (o pasan a `mrr/overview`, spec §6). Evita el salto de ene-2027 aunque falte una tasa. | Claude, con OK (Clientes está cerrado: requiere OK explícito) |
| A4 | ✅ 04-10 (código, sin aplicar): resuelto con la **regla de moneda de factura** (§4.2), que reemplaza este plan. **Corregir F1** (7 facturas SR): primero arreglar el flujo de unificación multimoneda para que la cabecera conserve la moneda de contrato y su `fx_contract_to_system`; después recalcular esas 7 (5 ya emitidas: solo campos de sistema, sin tocar montos en CLP ni el ERP). | **Domi**: OK para tocar facturas emitidas de un cliente en prod |
| A5 | **Recalcular F4**: endpoint/acción "recalcular moneda de sistema" para facturas con `total_system_currency` NULL cuando ya hay tasa (UP 12, TM 3), y que la carga de una tasa fija dispare ese recálculo para su holding y período. | Claude |
| A6 | **Unificar el nombre** a "MRR histórico" en todo el front y en las etiquetas que entrega el API (`sourceLabel`, motivo de churn "MRR histórico sin contrato", chips, insights, motivo de moneda de compañía). Sin tocar nombres internos. | Claude (copy ya decidido) |
| A7 | **Inicio de historia de SR** para Métricas: no mostrar meses anteriores a la primera factura histórica completa. | **Domi**: opción a: `metrics_history_start` por holding en Preferencias (SR = 2025-01); opción b: usar automáticamente el primer mes de `invoices_legacy`; opción c: dejar 2024 visible con aviso "historia parcial" |
| A8 | **Ingresos con MRR histórico**: | **Domi**: opción a (recomendada): en Ingresos › Resumen y Por dimensión, una fila/serie "MRR histórico" como ingreso recurrente reconocido (`mrr_legacy` ya es subtotal/term, lineal) con origen visible, fuera de asientos y diferido; opción b: Ingresos arranca en el go-live de cada cliente y muestra un aviso "Antes de <mes>: ver MRR histórico en Métricas"; opción c: no tocar |
| A9 | **Revisar los empalmes**: listado para Domi de los 29 contratos con hueco (50 mil USD) y los 13 sin MRR en el devengo (9,9 mil), y de las 56 líneas pendientes de activar que terminaron (bajas de jun y sep-2026). Ingresos › Excepciones ya marca parte como "MRR histórico sin contrato". | **Domi** caso a caso (no tocar datos de clientes sin OK) |

### 3.2 Después del switch

| # | Qué |
|---|---|
| B1 | **Arreglar EUR/USD** (F5): mapear `F072.EUR.USD` como USD→EUR y reescribir los 208 días y 10 promedios de 2026 (o invertirlos); test que valide orientación de cada serie (EUR/USD ≈ 1,0–1,25). |
| B2 | **Backfill de huecos** (F6): sincronizar USD/ARS ago–dic 2025, USD/BRL y USD/UYU oct–dic 2025; migrar `USD/ARG` → `USD/ARS` y retirar el código viejo. Que el scheduler recupere los últimos N días hábiles faltantes en cada corrida, no solo hoy, y escriba en `fx_api_sync_log`. |
| B3 | **Fuente para AUD y GBP** (F7) o sacarlas de `currencies_in_use` si no se usan; definir quién mantiene los meses futuros de `exchange_rates_monthly_avg` (hoy carga manual del 14-09). |
| B4 | **Alerta de cobertura de tasas fijas**: tarea/alerta del centro de notificaciones "Tu holding no tiene tipo de cambio para <moneda> desde <mes>" cuando un contrato vigente o una factura programada cae fuera de las tasas fijas (antes de que aparezca el aviso en Ingresos). |
| B5 | **Una sola convención de tasa** documentada (o columnas renombradas) entre `holding_fx_period_rates`, `contract_fx_period_rates`, `exchange_rates`, `invoices`, `mrr_legacy` y RSM, con helper único en TS. |
| B6 | **MRR histórico en moneda de compañía** (columna o conversión al leer) para que Métricas por compañía no lo pierda. |
| B7 | **Retiro del histórico**: cuando todas las líneas vigentes estén migradas o con `skip_activation`, congelar `mrr_legacy` (solo lectura) y dropear los triggers heredados al switch (regla de costura). |

### 3.3 Orden sugerido

A1 → A2 → A3 (devengo y Dashboard limpios) · A4/A5 (Facturación) · A6/A7/A8 (presentación del histórico, con decisiones de Domi)
· A9 en paralelo con Domi. Después: B1–B7.

---

## Parte 4 · Avance 04-10 (tasa proyectada y F1) — código en `domi`, sin commit, **nada aplicado en QA ni producción**

### 4.1 Tasa fija proyectada (F2/F3, decisión de Domi)

**Industria.** La conversión de períodos futuros a la moneda de consolidación se hace con una **tasa de presupuesto** fijada por la
empresa (no con la spot, que no es alcanzable a meses vista) y se mantiene constante ("constant currency") para comparar; cuando el
presupuesto del período siguiente no existe, las herramientas de FP&A y de revenue arrastran la última tasa conocida y la marcan como
estimación, y al cargar la tasa oficial reexpresan lo afectado. La propuesta de Domi es exactamente eso (última tasa fija del par,
extendida hacia adelante, sin escribirla, marcada y recalculada al registrar la nueva). Diferencia con otras prácticas: no usamos
spot/forward ni promedio móvil, y un hueco **entre** dos tasas registradas no se proyecta (es un error de carga y sigue como "Sin tipo de cambio").

**Qué se hizo.**
- `functions/holding_fixed_fx_rate.sql` (nuevo): una sola búsqueda de tasa fija del holding (directa → inversa → **proyectada** si la fecha
  es de un mes posterior al mes en curso y posterior a todas las tasas del par). Devuelve la fila cruda, `is_inverse` y `projected`.
- `revenue_schedule_apply_fx_for_contract` y `calculate_system_fx_rate` (facturas) la usan, cada uno con su convención; fuente
  `holding_fixed_period[_inverse]_projected`. `contract_item_fx_rate` **no** se tocó: es la tasa pactada ítem → contrato de cada contrato
  multimoneda, no la del holding (si falta es un contrato mal cargado).
- API: `fx_projected` (monedas, meses, contratos y la tasa que se extiende) en `metrics/mrr/overview`, `metrics/revenue/summary`,
  `metrics/revenue/forward` y el Dashboard (`fx-projected.ts`). Las filas proyectadas **suman** (no son "Sin tipo de cambio").
- Configuración › Monedas: crear/editar/borrar una tasa fija recalcula en la misma transacción devengo y facturas desde su período
  (`contracts/holding-fx-recalc.ts`, sin trigger); la respuesta trae `recalculated`. Ver `src/modules/settings/README.md`.

**Solo hacia adelante (decisión de Domi 04-10, definitiva).** La proyección aplica solo a meses **posteriores al mes en curso**. Un mes
pasado o el actual sin tasa sigue sin tasa ("Sin tipo de cambio", fuente `missing_fx_rate`): es un error de datos y se corrige cargando
la tasa, no se tapa. "Mes en curso" = el del "hoy" del holding: `now()` en `holding_settings.timezone` (default America/Santiago), la
misma zona con que la API calcula cierres, vencimientos y jobs. Se descartó `CURRENT_DATE`: en Supabase la sesión está en UTC y el mes
cambiaría 3–4 horas antes que en Chile (el último día del mes desde las 20–21 h se proyectaría el mes que todavía no empieza en hora
local, y el día 1 a las 00–03 h el mes recién empezado aún se trataría como futuro). Consecuencia: una fila calculada con tasa proyectada
conserva esa tasa cuando su mes pasa a ser el actual, hasta el siguiente recálculo (registrar la tasa lo dispara; un rebuild o
`apply_fx` también). Un recálculo programado a inicio de mes queda como propuesta (no implementado).

**Prueba en la copia local** (`sapira_fx`, rebuild de los 674 contratos con el fallback, 0 errores; antes de la regla "solo hacia adelante"):

| | Antes (prod) | Rebuild sin fallback | Rebuild + fallback |
|---|---|---|---|
| Filas `missing_fx_rate` en el sistema (SR/TM/UP) | 365 | 359 | **0** (359 proyectadas) |
| Filas con tasa 1,0 en moneda ≠ moneda de sistema | **338** | 0 | **0** |
| UP MRR COP ene-2027 | 102.352.909 | sin convertir | 26.813 |
| UP CLF ene-2027 / jun-2028 | 593 / 150 | sin convertir | 35.039 / 6.494 |
| TM CLF jun-2027 | 86 | sin convertir | 3.624 |
| SR CLF feb-2028 | 20 | sin convertir | 875 |

Fuera de esas 359 filas, el devengo es idéntico al rebuild sin fallback (17.477 filas comparadas). **Corrida final con la regla "solo
hacia adelante"** (`sapira_final`, [`rebuild-devengo-comparacion.md`](./rebuild-devengo-comparacion.md) §9, 04-10, mes en curso oct-2026):
0 filas sin tasa del sistema; proyectadas SimpliRoute 14 (2028-01..03), TiMining 11 (2027-01..11), uPlanner 334 (2027-01..2029-03), **0
en meses pasados o el actual** (ningún par tiene un mes hasta oct-2026 sin tasa, así que la regla no cambia las cifras de hoy). Sin rebuild, `apply_fx` desde
2027-01 de los 21 contratos con filas sin tasa también deja 0 sin tasa y 0 con tasa 1 (49 ms). Registrar en la copia la tasa UP CLF 2027
(0,0228) por el servicio de Configuración recalculó 8 contratos y 23 facturas en 56 ms: 2027 pasa a `holding_fixed_period` y 2028–2029 se
proyectan desde 2027; al borrarla vuelve a proyectarse desde 2026.

**Propuesta de front (sin implementar).** Aviso informativo (no de error) junto a la moneda en Métricas, Ingresos y Dashboard:
"CLF → moneda de sistema desde ene-2027: tasa proyectada (última tasa fija, 0,0231 del 2026) hasta que registres la del 2027" con enlace a
Administración › Monedas; en Ingresos › Futuro, los meses proyectados con trama punteada y el mismo texto en el tooltip. En Monedas, por
par: "2027 en adelante sin tasa: se usa la del 2026" + "Registrar tasa 2027"; al guardar, aviso "Recalculamos N contratos y M facturas
desde ene-2027". La alerta B4 avisaría antes de que empiece el año sin tasa.

### 4.2 Regla por estado del monto en moneda de sistema de las facturas (reemplaza la corrección F1 y la regla "sin vueltas")

**Decisión de Domi (04-10, tarde; reemplaza la de la mañana "siempre desde la moneda de factura").** El monto en **moneda de sistema** de
una factura (`amount_system_currency`, `total_system_currency`, `fx_contract_to_system`) depende de su estado:

- **Por Emitir** (aún no hay documento): siempre desde la **moneda de contrato**: el monto del encabezado (`amount_contract_currency`
  en `invoices.contract_currency`; sin ella, la del contrato).
- **Cualquier otro estado** (Emitida, Enviada, Vencida, Pagada, Cancelada, NC…): desde la **moneda de factura**, lo que realmente se
  cobra (`amount_invoice_currency` en `invoice_currency`). Sin neto en moneda de factura (o neto 0 con monto en contrato ≠ 0), el
  encabezado.

Conversión con `calculate_system_fx_rate(holding, moneda de origen, moneda de sistema, fecha de emisión —o programada, u original—,
política del holding)`; misma moneda → mismo monto; total = monto × (1 + IVA %). `fx_contract_to_system` guarda la tasa moneda de origen →
sistema. La regla **"sin vueltas" (01-10) queda reemplazada**: una línea en moneda de sistema dentro de una factura en otra moneda ya no
entra directo. Las diferencias por tipo de cambio (realizada al cobro, no realizada al cierre, facturas en otra moneda que la de la
compañía, líneas en moneda de sistema) son un ítem abierto de [`ROADMAP-V2.md`](../../ROADMAP-V2.md).

- **Al emitir** el monto pasa de la moneda de contrato a la de factura. La emisión la escriben el envío al ERP (`InvoiceSchedulerService`,
  `invoiceRepository.update({ status: 'Emitida' })`) y el webhook del ERP (`OdooWebhookService`), los dos **sin** la marca
  `sapira.writer`: el trigger (`BEFORE INSERT OR UPDATE`) recalcula en ese mismo UPDATE de estado. Verificado en la copia: 3 Por Emitir
  (CLF → CLP, USD → COP) pasan a la tasa de la moneda de factura al emitir y vuelven a la de contrato si se revierten. Una transacción v2
  que cambie el estado llama `refreshInvoiceSystemAmounts` (hoy ninguna saca una factura de Por Emitir; el pago exige que esté emitida).
- **NC espejo**: copian la tasa efectiva de su original; sobre el neto en moneda de factura solo si la original ya es documento
  (`MIRROR_BY_INVOICE_SQL`), si no sobre el monto en contrato.
- **Consolidación**: el consolidado nace Por Emitir → desde el encabezado; en modo `mixed` (contratos en monedas distintas) el
  encabezado ya está en moneda de factura, así que se convierte ese monto (igual que el trigger o cualquier edición posterior).
- **Dónde**: `refreshInvoiceSystemAmounts`, `mirrorInvoiceSystemAmounts` e `INVOICE_SYSTEM_SOURCE_CURRENCY_SQL`
  (`contracts/api-written-fields.ts`; los usan alta, edición, consolidación, reorganización, OC parcial, anulación/reemisión, consumos,
  multimoneda, NC y `recalculateHoldingFx`) y el trigger `auto_populate_invoice_fx_to_system` (front actual y emisión; sigue dividiendo
  siempre: para los holdings `fixed_period` da lo mismo). En la copia, la migración y la API dan exactamente lo mismo en las 1.511
  facturas recalculadas.

**Migración** `1791200000000-InvoiceSystemAmountsFromInvoiceCurrency` (rehecha el 04-10 con la regla por estado; no aplicada en ningún
entorno). Solo escribe los cuatro campos de sistema, solo filas cuyo valor cambia, sin meses cerrados (`get_cutoff_date` + 1 mes) y con
tasa:

1. **Documentos** (todo estado salvo Por Emitir y Cancelada; **incluye Pagadas** de meses abiertos) cuya conversión cambia con la regla
   (moneda de factura ≠ contrato, encabezado mixto, neto ≠ monto en contrato, o líneas "sin vueltas"). Fuera, datos a corregir aparte:
   10 de TiMining (EMI-01) con el bruto como neto y 4 con el monto del encabezado sin convertir (1 factura y 2 NC de SR, 1 NC de uPlanner).
   **Canceladas fuera**: no suman en ningún reporte y varias traen montos inconsistentes entre monedas (una NC de TiMining con −500.000
   en contrato y −561,72 en factura); el trigger y la API les aplican la regla si se vuelven a tocar.
2. **Por Emitir: quedan como estaban** (ya están desde la moneda de contrato) **salvo las unificadas multimoneda** (encabezado en otra
   moneda que el contrato): las 6 Por Emitir de las 14 de SimpliRoute **también estaban mal desde el contrato**: el trigger viejo leía la
   moneda del contrato (USD o CLF) y la aplicaba al monto del encabezado, que está en CLP (p. ej. CTR-2026-90-LuvEnv: 3.956.367 CLP ×
   tasa CLF = 202.454.388 "USD"). Desde la moneda de contrato **del encabezado** (CLP) quedan bien: 402.981.631 → 28.638. Las 8 emitidas
   de las 14 van por la regla de documentos.
3. **NC espejo** (no Canceladas) cuya original cambió o que están en otra moneda que su contrato.

Respaldo en `sapira_backups.invoice_system_fx_1791200000000` (el esquema es una constante, `src/databases/postgresql/backups.ts`, por
confirmar con Domi); `down` restaura las filas que no cambiaron después. Probada en la copia: up 0,12 s, idempotente, `down` deja todo
idéntico (0 diferencias) y borra tabla y esquema.

**Impacto en la copia** (prod 04-10, moneda de sistema USD, hoy = 04-10; 5.930 facturas con contrato):

| Holding | Estado | Cambian | Antes | Después |
|---|---|---:|---:|---:|
| SimpliRoute | Por Emitir | 7 (6 multimoneda + 1 NC) | 402.980.657 | 27.643 |
| SimpliRoute | Vencida | 1.022 | 360.347.330 | 774.770 |
| SimpliRoute | Enviada | 142 | 8.664.359 | 126.192 |
| SimpliRoute | Emitida / Pagada | 63 / 11 | 43.859 / 3.106 | 45.339 / 3.111 |
| TiMining | Pagada | 83 | 4.635.162 | 4.558.340 |
| uPlanner | Pagada / Vencida | 113 / 9 | 4.219.337 / 55.197 | 4.638.145 / 57.412 |
| Hanka | Pagada / Vencida | 59 / 2 | 72.406 / 3.848 | 72.516 / 3.682 |
| **Total** | | **1.511** | 781.025.260 | 10.307.150 |

- **Las 14 multimoneda de SR**: 771.126.652 → 56.439. **El resto (1.497)**: 4,9 M → 5,0 M en SR+Hanka y por par contrato → factura:
  uPlanner USD→COP +216 mil (+11 %), TiMining USD→CLP −77 mil (−1,7 %), uPlanner USD→MXN +24 mil, SR CLF→CLP +17 mil (+2,4 %). uPlanner
  suma 172.882 de 2 Pagadas CLF→CLP de 2024 que estaban sin monto en sistema (F4).
- Frente a la regla de la mañana ("siempre moneda de factura"), las Por Emitir de TiMining (2) y uPlanner (6) y 337 de SimpliRoute ya no
  cambian: siguen desde la moneda de contrato hasta que se emitan.
- Lenosoft (sistema CLP, `monthly_avg`): sin cambios.

KPIs de Facturación (copia, hoy = 04-10, moneda de sistema; por emitir = año 2026):

| Holding | Facturado jul / ago / sep 2026 | Por cobrar | Vencido | Por emitir 2026 |
|---|---|---:|---:|---:|
| SimpliRoute antes | 1.077.159 / 359.550.284 / 8.937.108 | 369.931.910 | 360.984.892 | 405.660.235 |
| **SimpliRoute después** | **427.154 / 619.969 / 404.121** | **1.822.731** | **1.412.400** | **2.707.242** |
| TiMining antes → después | 417.005 → 404.042 / 1.303 / 0 | 1.303 | 1.303 | 1.311.438 (sin cambio) |
| uPlanner antes → después | 180.303 → 182.667 / 4.074 → 4.195 / 0 | 55.197 → 57.412 | 55.197 → 57.412 | 1.720.067 (sin cambio) |
| Hanka antes → después | 24.007 → 23.994 / 24.118 → 24.106 / 22.182 → 22.170 | 22.117 → 21.952 | 19.600 → 19.434 | 107.229 (sin cambio) |

**Pendiente de Domi**: el esquema del respaldo (`backups.ts`) y la corrección de datos de los 14 documentos fuera de alcance (EMI-01 y
los 4 sin convertir); si se carga la tasa CLP 2024 de TiMining.

### 4.3 Moneda de compañía solo en meses terminados + cierre del día 1 (decisión de Domi 04-10)

**Regla** (`revenue_schedule_apply_fx_for_contract`): con política de promedio mensual, la moneda de compañía del devengo (todas las
columnas `_ccy`: MRR, devengado, diferido, facturado, CMRR) solo se llena en **meses terminados** (mes del holding,
`holding_settings.timezone`, default America/Santiago, el mismo criterio que `holding_fixed_fx_rate`) cuyo promedio está **cerrado**
(`exchange_rates_monthly_avg` recalculado después de terminar el mes y con `data_points > 1`). El mes en curso, los futuros y el recién
terminado aún sin cierre quedan **sin convertir**: columnas NULL, `fx_to_company_source = 'pending_month_close'`, sin `missing_fx_rate`
en `calc_version`. Un mes anterior sin promedio cerrado sí es un hueco (`missing_fx_rate`). Política **fija** del contrato: se llena
siempre. **Moneda de sistema: sin cambios.**

**Proceso del día 1** (`src/modules/banco-central`: `FxMonthCloseScheduler` + `FxMonthCloseService`, cron `0 10 1-5 * *` Santiago;
a mano `POST /banco-central/exchange-rates/close-month`, super admin, `{ month?, force? }`): (a) por par, si las tasas diarias del mes
están completas (días hábiles − 3 y última tasa a ≤ 3 días del último hábil) recalcula su promedio y lo deja cerrado; si no, no lo
cierra y lo registra; revisa también los meses terminados de los últimos 12 sin cerrar; (b) por holding y contrato (`withApiWriter`,
contrato bloqueado, nunca antes de `get_cutoff_date`) llama `revenue_schedule_apply_fx_for_contract` para los contratos con meses
terminados pendientes, con moneda de compañía de la regla anterior en meses en curso o futuros, o con tasa de sistema proyectada;
(c) si quedan filas del mes sin moneda de compañía, alerta `fx_sync_failure` por holding (clave `fx-month-close:AAAA-MM`), si no la
cierra. Idempotente.

**Promedio mensual: corregido el 04-10 (decisión de Domi)** — regla en `src/modules/banco-central/monthly-average.ts` y su README:
todas las fuentes diarias (Banco Central de los dos sistemas y Perú API; no las cargas manuales), una tasa por par y día, solo días hábiles
para todas las monedas, y cerrado solo si se recalculó después de terminado el mes con más de una tasa. Migración
`1791500000000-LimpiaPromediosMensualesManuales`: borra las 319 filas a mano y, aprobado por Domi, las 76 inversas sin tasas propias (CLP/USD, COP/USD, MXN/USD, PEN/USD
ene-2025 → abr-2026 y EUR/USD 2025: los lectores caen a la inversa de la fila directa); 395 en total, firma md5
`f491fa7fd2e695b3aba85d05ac45bd8b`, igual en producción (lectura del 04-10). Recalcula
ene-2025 → sep-2026 (212 filas; cambio medio por par ≤ 0,06 %, máximo 0,65 % USD/PEN oct-2025). Hallazgos que la motivaron
(producción, lectura 04-10):

- Cálculo correcto en lo básico (promedio simple de las tasas diarias del mes, directo; el inverso se toma como 1/promedio), pero:
  la sincronización diaria lo recalcula **cada día con el mes parcial** (hoy, octubre con 2 días: USD/CLP 978,22) y el devengo lo usaba
  así en el mes en curso; filtra por `source_type`, así que las tasas `BANCOCENTRALCHILE` (hasta 10-10-2025) y las de Banco Central de
  USD/PEN anteriores al 17-07-2026 quedan fuera si se recalcula (oct-2025: 14 de 23 días; jul-2026 USD/PEN: 15 de 23); UF y USD/PEN
  promedian días corridos (fines de semana repetidos) y el resto días hábiles.
- **Filas a mano sin tasas diarias** (`data_points = 1`, cargadas el 02-01 y el 14-09): CLP/USD, COP/USD, MXN/USD, PEN/USD y cruces a
  CLP hasta dic-2027; CLF/CLP, CLF/USD y USD/CLP de nov-2026 a dic-2027 (USD/CLP plano 933,921). ARS/USD = 1.452,25 y BRL/USD = 5,0 están
  invertidas. **Hoy en producción** los meses futuros convierten con esas filas planas o con 1,0 (`missing_fx_rate` del asset viejo):
  de 5.768 filas en curso y futuras con moneda de contrato ≠ compañía, 5.622 tienen monto en moneda de compañía (1.959 con promedio
  plano o parcial, 3.709 marcadas `missing_fx_rate` con tasa 1,0 del asset viejo, 88 con tasa fija del contrato).
- Sin fuente diaria para MXN → CLP ni EUR → CLP (uPlanner): quedan sin moneda de compañía; el aviso del día 1 lo dice cada mes.

**Copia local** (prod 04-10, `sapira_cia`; apply_fx de los 674 contratos con el asset anterior del árbol vs. el nuevo + el proceso
corrido "hoy" y simulando el 01-11 con tasas sintéticas de octubre):

| Holding | Filas que cambian | En curso y futuras → sin convertir | Pasadas → sin convertir |
|---|---|---|---|
| SimpliRoute | 2.311 | 2.280 | 31 (jul-2026 USD → PEN: promedio incompleto, 15 de 23 días) |
| uPlanner | 1.714 | 1.687 | 27 (jul-2026 USD → PEN 18; MXN → CLP ene–ago 9, tasa plana 50,03) |
| TiMining | 1.649 | 1.647 | 0 (2 filas cambian solo `calc_version`: sin monto de contrato) |
| Hanka Robotics | 36 | 36 | 0 (la política fija CLF → CLP sigue llena en todos los meses) |
| Lenosoft Limitada | 7 | 7 | 0 |

- El proceso "hoy" cerró los promedios de jul, ago y sep 2026 (29 pares; jul-2026 USD/PEN quedó incompleto) y recalculó 463
  contratos en 1,3 s; septiembre quedó convertido salvo 1 fila MXN → CLP (aviso a uPlanner).
- Simulación 01-11: cerró octubre (9 pares; USD/UYU incompleto a propósito → 60 filas de SimpliRoute pendientes y aviso), convirtió
  octubre (735 filas) y noviembre en adelante siguió sin convertir. Segunda corrida: 0 filas distintas. Con `force` se cerró USD/UYU.
- La moneda de sistema no cambió en ninguna fila (salvo Lenosoft, sistema `monthly_avg`, por el promedio sintético de octubre).

**Efecto en lectura**: en moneda de compañía, Métricas y Ingresos dejan fuera las líneas con algún mes sin convertir dentro del rango
(`splitUnconverted`, `loadRevenueRows`), con el aviso "sin tipo de cambio" (`reason = 'company_fx_rate'`). Un rango que incluye el mes en
curso o meses futuros deja fuera, **en todo el rango**, a los contratos en otra moneda que la de la compañía (MRR de octubre en moneda de
compañía en la copia: SimpliRoute 374 M → 130 M, TiMining 403 M → 1 M). El Dashboard lee moneda de sistema: sin cambios. **Pendiente de
Domi**: si el mes sin cerrar se excluye solo en su mes (no la línea entera) y si el aviso usa un motivo propio ("el mes aún no cierra").

**Para aplicar** (nada aplicado en QA ni prod): asset `revenue_schedule_apply_fx_for_contract.sql` con `--only`, desplegar la API y
correr una vez `POST /banco-central/exchange-rates/close-month` por entorno (cierra jul–sep 2026 y deja sin convertir lo en curso y
futuro). Decidir antes si julio 2026 USD/PEN se cierra con `force` o se completan sus tasas diarias.
