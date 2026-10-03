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

## Construido 02-10: esquema

Decisión de Domi (02-10): el modelo genérico se crea **una sola vez** y el primer uso es el **presupuesto de ingresos a caja** de Cobranza
(antes "meta anual de cobranza", que iba a un jsonb en `invoice_collection_settings`: esa migración, `1790750000000-CashInGoals`, se
reemplazó **sin haberse aplicado en ningún ambiente**). Migración `1790750000000-Budgets` — **escrita, NO aplicada** (proceso de
`GUIA-CAMBIOS-DE-ESQUEMA.md`: commit → QA con `schema:status` + `schema:log` → producción → `schema:snapshot`).

| Objeto | Efecto exacto |
|---|---|
| Tabla `budgets` | `id uuid PK default gen_random_uuid()` · `holding_id uuid NOT NULL` → `company_holdings` ON DELETE CASCADE (`budgets_holding_id_fkey`) · `kind text NOT NULL` · `name text NOT NULL` · `scenario text NOT NULL DEFAULT 'base'` · `currency text NOT NULL` (moneda de sistema al guardar) · `period_granularity text NOT NULL DEFAULT 'month'` · `fiscal_year smallint NOT NULL` (= año calendario) · `status text NOT NULL DEFAULT 'active'` · `notes text` · `created_by uuid` · `created_at` / `updated_at timestamptz NOT NULL DEFAULT now()` |
| CHECK de `budgets` | `budgets_kind_check` (cash_in, billing, bookings, mrr, new_mrr, expansion_mrr, contraction_mrr, churn_mrr) · `budgets_scenario_check` (base, optimistic, pessimistic) · `budgets_period_granularity_check` (month, quarter, year) · `budgets_status_check` (draft, active, archived) |
| Índice único parcial | `uq_budgets_holding_kind_year_scenario (holding_id, kind, fiscal_year, scenario) WHERE status <> 'archived'` (un presupuesto vivo; archivar libera el lugar) |
| Tabla `budget_lines` | `id uuid PK` · `holding_id uuid NOT NULL` → `company_holdings` CASCADE · `budget_id uuid NOT NULL` → `budgets` ON DELETE CASCADE (`budget_lines_budget_id_fkey`) · `period_start date NOT NULL` (primer día del mes, trimestre o año) · `dimension_type text NOT NULL DEFAULT 'total'` · `dimension_id uuid` · `dimension_key text` · `amount numeric(18,2) NOT NULL` · `created_at` / `updated_at` |
| CHECK de `budget_lines` | `budget_lines_dimension_type_check` (total, company, seller, product, segment, market, client) · `budget_lines_dimension_check` (total sin id ni clave; company/seller/product/client con `dimension_id`; segment/market con `dimension_key`) · `budget_lines_amount_check` (`amount >= 0`) · `budget_lines_period_start_check` (día 1) |
| Índices de `budget_lines` | `uq_budget_lines_cell` único de expresión `(budget_id, period_start, dimension_type, COALESCE(dimension_id, '0000…'::uuid), COALESCE(dimension_key, ''))` (también asset `special-index/uq_budget_lines_cell.sql`; la entity lo avisa con `synchronize: false`) · `idx_budget_lines_budget (budget_id)` · `idx_budget_lines_holding_period (holding_id, period_start)` |
| RLS | `ENABLE ROW LEVEL SECURITY` en ambas (en la migración). Policies como assets: `rls/tenant_isolation_{select,insert,update,delete}_budgets.sql` (`holding_id = get_current_user_holding_id()`) y `rls/tenant_isolation_{select,insert,update,delete}_budget_lines.sql` (holding de la línea **y** `budget_id` de un presupuesto del holding, misma forma que `contract_item_pauses`) |
| Triggers (assets) | `triggers/trg_budgets_updated_at.sql`, `triggers/trg_budget_lines_updated_at.sql` (`update_updated_at_column()`) |
| `down` | Se niega si hay presupuestos o líneas; si no, `DROP TABLE budget_lines` y `DROP TABLE budgets` |
| Entities e inventarios | `entities/revenue/budget.entity.ts` (`Budget`), `entities/revenue/budget-line.entity.ts` (`BudgetLine`); `espejo.existing.ts`, `scripts/espejo/existing-entities.json`, `scripts/espejo/module-map.json` (grupo `revenue`). No son espejos: hasta aplicar y refrescar el snapshot, el snapshot de prod no las tiene |

**API** (`src/modules/budgets`, `HoldingScopeGuard`): `GET /budgets?kind&fiscal_year` · `GET /budgets/:id` (con líneas y total por mes) ·
`PUT /budgets` (upsert por kind · año · escenario entre los no archivados; reemplaza **todas** las líneas en una transacción; valida montos
≥ 0 con 2 decimales, períodos alineados a la granularidad y dentro del año, reglas de dimensión, entidades del holding y que cada dimensión
sume el total del período) · `POST /budgets/:id/archive`. **Permisos**: por ahora todos los kinds usan los de Facturación
(`VIEW_FACTURACION` / `EDIT_FACTURACION`); cuando Ventas y Métricas tengan permisos propios, bookings y MRR se separan.

**Primer uso (Cobranza)**: `GET/PUT /billing/receivables/goal` lee y escribe el presupuesto `cash_in` del año (anual = una línea `year` o la
suma de 12 mensuales; reparto opcional por compañía) y la proyección de cobros trae el presupuesto por período (mes = el del mes o anual ÷
12; semana/día prorrateados por días) y por compañía. Ver `mapa-v2-facturacion.md`.

**Pendiente** (no construido): escenarios optimista/pesimista en pantalla, presupuestos de facturación, bookings y MRR (el modelo ya los
admite), carga por planilla y `forecast_snapshots`.

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
