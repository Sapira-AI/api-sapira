# Módulo 7 · Revenue / períodos — 5 tablas de prod (2026-08-22)

> Convención y reglas: `../README.md`. Rarezas verificadas: `../NOTAS-ESPEJO.md`. Veredictos de producto: `docs/v2-rediseno/04-spec-modelo-dominio-v2/00-tablas-por-modulo.md` (no aplican en este paso).
> Origen de TODO lo que está en esta carpeta: lectura en vivo de prod `hklompkypzqtglprfobu` vía MCP de Supabase el 2026-08-22 — `list_tables verbose` + `execute_sql` de solo lectura sobre `pg_catalog` (`scripts/espejo/snapshots/revenue.{pgmeta,catalog}.json`); metadata real de las entities existentes en `revenue.existing.json` (`scripts/espejo/extract-existing-metadata.ts`). Generado con `scripts/espejo/generate-espejo.py`.

## A · Tablas que YA tenían entity en el repo (0) — no se tocaron ni se duplicaron

Ninguna: todas las tablas de este módulo carecían de entity.

## B · Tablas SIN entity → espejos creados (5), APAGADOS

| Tabla (filas, RLS) | Espejo · clase | Cols | PK | UNIQUE | CHECK | FKs (→ tabla, ON DELETE) | Índices | Triggers | Policies |
|---|---|---|---|---|---|---|---|---|---|
| `revenue_schedule_monthly` (18415, RLS on) | `revenue-schedule-monthly.espejo.ts` · `RevenueScheduleMonthly` | 57 | `revenue_schedule_monthly_pkey` (id) | `revenue_schedule_monthly_contract_item_period_momentum_key` | `revenue_schedule_monthly_momentum_check`, `rsm_contract_or_subscription_required` | `revenue_schedule_monthly_subscription_item_id_fkey` → subscription_items<br>`fk_revenue_schedule_holding` → company_holdings<br>`fk_revenue_schedule_contract` → contracts<br>`fk_revenue_schedule_company` → companies<br>`fk_revenue_schedule_item` → contract_items<br>`revenue_schedule_monthly_subscription_id_fkey` → subscriptions | `idx_revenue_schedule_momentum`, `idx_revenue_schedule_monthly_company_period`, `idx_revenue_schedule_monthly_contract`, `idx_revenue_schedule_monthly_holding_period`, `idx_revenue_schedule_monthly_is_total_row`, `idx_rsm_cmrr_period` (parcial), `idx_rsm_company_period`, `idx_rsm_contract_period`, `idx_rsm_mrr_contracted_period` (parcial), `idx_rsm_subscription_id` (parcial), `idx_rsm_subscription_item_id` (parcial) | trg_assign_momentum · BEFORE INSERT OR UPDATE OF contract_item_id, period_month FOR EACH ROW → assign_momentum_to_revenue_schedule()<br>update_revenue_schedule_monthly_updated_at · BEFORE UPDATE FOR EACH ROW → update_revenue_schedule_monthly_updated_at() | 4 |
| `revenue_rules` (0, RLS on) | `revenue-rule.espejo.ts` · `RevenueRule` | 6 | `revenue_rules_pkey` (id) | — | `revenue_rules_target_type_check` | `revenue_rules_company_id_fkey` → companies | — | — | 4 |
| `mrr_adjustments` (1, RLS on) | `mrr-adjustment.espejo.ts` · `MrrAdjustment` | 15 | `mrr_adjustments_pkey` (id) | — | — | `mrr_adjustments_company_id_fkey` → companies (CASCADE)<br>`mrr_adjustments_contract_id_fkey` → contracts (CASCADE) | `idx_mrr_adj_company`, `idx_mrr_adj_contract`, `idx_mrr_adj_effective_date` | trg_mrr_adjustments_updated_at · BEFORE UPDATE FOR EACH ROW → update_updated_at_column() | 4 |
| `accounting_period_cutoff` (18, RLS on) | `accounting-period-cutoff.espejo.ts` · `AccountingPeriodCutoff` | 12 | `accounting_period_cutoff_pkey` (id) | `accounting_period_cutoff_holding_id_company_id_key` | `accounting_period_cutoff_last_action_check` | `accounting_period_cutoff_last_action_by_fkey` → users (SET NULL)<br>`accounting_period_cutoff_holding_id_fkey` → company_holdings (RESTRICT)<br>`accounting_period_cutoff_company_id_fkey` → companies (RESTRICT) | `idx_cutoff_lookup` | trg_accounting_period_cutoff_updated_at · BEFORE UPDATE FOR EACH ROW → trg_set_updated_at_accounting_period_cutoff()<br>trg_cutoff_validate_company_holding · BEFORE INSERT OR UPDATE OF holding_id, company_id FOR EACH ROW → trg_validate_cutoff_company_holding_match() | 3 |
| `accounting_period_events` (14, RLS on) | `accounting-period-event.espejo.ts` · `AccountingPeriodEvent` | 12 | `accounting_period_events_pkey` (id) | — | `accounting_period_events_action_check`, `accounting_period_events_reason_check` | `accounting_period_events_holding_id_fkey` → company_holdings (RESTRICT)<br>`accounting_period_events_company_id_fkey` → companies (RESTRICT)<br>`accounting_period_events_performed_by_fkey` → users (RESTRICT) | `idx_period_events_company_time` (expresión, no declarado), `idx_period_events_performed_by` (expresión, no declarado) | trg_events_validate_company_holding · BEFORE INSERT FOR EACH ROW → trg_validate_cutoff_company_holding_match() | 2 |

Cada espejo contiene, leído en vivo: columnas con tipo real (`timestamp with/without time zone`, `varchar` + `length`, `numeric` + `precision/scale`, enums de Postgres con sus valores, `text[]`, `jsonb`, `uuid`…), nullable, default y comentario; PK con nombre (`primaryKeyConstraintName`); `@Unique`/`@Check`/`@Index` con nombre real (índices parciales con `where`; los índices con expresión, orden u otro método se documentan en el JSDoc pero no se declaran porque `@Index` no los representa); una relación `@ManyToOne` por FK con `onDelete` real y `foreignKeyConstraintName` — hacia la entity existente (`@/modules/...`) si la tabla destino ya la tiene, o hacia el espejo de su módulo; cabecera JSDoc con filas, RLS, comentario de tabla, tablas que la referencian, triggers y policies (nombre, comando, roles). Las expresiones `USING`/`WITH CHECK` de las policies quedan en `scripts/espejo/snapshots/revenue.catalog.json` (`policies_detail`) para el paso 4.

**Cómo están apagados (código técnico)**: el archivo termina en `.espejo.ts`, no en `.entity.ts`. `database.module.ts` carga entities con `entities: [__dirname + '/../../**/*.entity{.ts,.js}']`, así que no los ve, y ningún módulo los incluye en `TypeOrmModule.forFeature([...])`. `database.module.spec.ts` falla si aparece un `.entity.ts` dentro de `entities/<modulo>/`. Para encenderlos en el paso 3: renombrar a `.entity.ts` y registrarlos en el `forFeature` del módulo que los use.

## C · Columnas exactas de cada espejo (5 tablas)

<details><summary><code>revenue_schedule_monthly</code> → <code>revenue-schedule-monthly.espejo.ts</code> · 57 columnas</summary>

| Columna | Tipo Postgres | Nulo | Default | Comentario |
|---|---|---|---|---|
| `id` 🔑 | uuid | no | gen_random_uuid() |  |
| `holding_id` | uuid | no | — |  |
| `contract_id` | uuid | sí | — |  |
| `contract_item_id` | uuid | sí | — |  |
| `period_month` | date | no | — |  |
| `company_id` | uuid | no | — |  |
| `company_currency` | text | no | — |  |
| `contract_currency` | text | no | — |  |
| `system_currency` | text | no | 'USD'::text |  |
| `recognized_period_ccy` | numeric(15,2) | sí | 0 |  |
| `recognized_cum_ccy` | numeric(15,2) | sí | 0 |  |
| `billed_period_ccy` | numeric(15,2) | sí | 0 |  |
| `billed_cum_ccy` | numeric(15,2) | sí | 0 |  |
| `deferred_balance_eom_ccy` | numeric(15,2) | sí | 0 |  |
| `unbilled_balance_eom_ccy` | numeric(15,2) | sí | 0 |  |
| `mrr_period_ccy` | numeric(15,2) | sí | 0 |  |
| `recognized_period_contract_ccy` | numeric(15,2) | sí | — |  |
| `recognized_cum_contract_ccy` | numeric(15,2) | sí | — |  |
| `billed_period_contract_ccy` | numeric(15,2) | sí | — |  |
| `billed_cum_contract_ccy` | numeric(15,2) | sí | — |  |
| `deferred_balance_eom_contract_ccy` | numeric(15,2) | sí | — |  |
| `unbilled_balance_eom_contract_ccy` | numeric(15,2) | sí | — |  |
| `mrr_period_contract_ccy` | numeric(15,2) | sí | — |  |
| `recognized_period_system_ccy` | numeric(15,2) | sí | — |  |
| `recognized_cum_system_ccy` | numeric(15,2) | sí | — |  |
| `billed_period_system_ccy` | numeric(15,2) | sí | — |  |
| `billed_cum_system_ccy` | numeric(15,2) | sí | — |  |
| `deferred_balance_eom_system_ccy` | numeric(15,2) | sí | — |  |
| `unbilled_balance_eom_system_ccy` | numeric(15,2) | sí | — |  |
| `mrr_period_system_ccy` | numeric(15,2) | sí | — |  |
| `calc_version` | text | no | 'v1.0'::text |  |
| `source_snapshot_hash` | text | sí | — |  |
| `created_at` | timestamp with time zone | no | now() |  |
| `updated_at` | timestamp with time zone | no | now() |  |
| `deferred_balance_period_ccy` | numeric | sí | 0 |  |
| `unbilled_balance_period_ccy` | numeric | sí | 0 |  |
| `product_name` | text | sí | — |  |
| `fx_contract_to_company` | numeric | sí | 1 |  |
| `fx_contract_to_system` | numeric | sí | 1 |  |
| `fx_to_company_source` | text | sí | — |  |
| `fx_to_company_date` | date | sí | — |  |
| `fx_to_system_source` | text | sí | — |  |
| `fx_to_system_date` | date | sí | — |  |
| `is_total_row` | boolean | no | false |  |
| `deferred_balance_period_contract_ccy` | numeric | sí | 0 |  |
| `unbilled_balance_period_contract_ccy` | numeric | sí | 0 |  |
| `deferred_balance_period_system_ccy` | numeric | sí | 0 |  |
| `unbilled_balance_period_system_ccy` | numeric | sí | 0 |  |
| `momentum` | text | sí | — | Momentum del MRR: NEW/UPSELL/etc en primer periodo, BOP en periodos subsiguientes |
| `mrr_period_contracted_contract_ccy` | numeric(15,2) | sí | 0 | MRR Contracted: Valor mensual del contrato original (monthly_price del contract_item). Solo items recurrentes con start_date <= period_month. No se ajusta con quantities ni descuentos puntuales. |
| `cmrr_period_contract_ccy` | numeric(15,2) | sí | 0 | CMRR (Committed MRR): Valor mensual contractual proyectado (monthly_price del contract_item). Incluye TODOS los items recurrentes del contrato sin importar start_date. No se ajusta con quantities ni descuentos puntuales. |
| `mrr_period_contracted_ccy` | numeric(15,2) | sí | 0 | MRR Contracted en moneda de compañía (convertido con FX). |
| `cmrr_period_ccy` | numeric(15,2) | sí | 0 | CMRR en moneda de compañía (convertido con FX). |
| `mrr_period_contracted_system_ccy` | numeric(15,2) | sí | 0 | MRR Contracted en moneda de sistema (convertido con FX). |
| `cmrr_period_system_ccy` | numeric(15,2) | sí | 0 | CMRR en moneda de sistema (convertido con FX). |
| `subscription_id` | uuid | sí | — | FK a subscriptions. Usado para registros RSM de suscripciones externas. Mutuamente excluyente con contract_id. |
| `subscription_item_id` | uuid | sí | — | FK a subscription_items. Permite desglose de RSM por item de suscripción. |

</details>
<details><summary><code>revenue_rules</code> → <code>revenue-rule.espejo.ts</code> · 6 columnas</summary>

| Columna | Tipo Postgres | Nulo | Default | Comentario |
|---|---|---|---|---|
| `id` 🔑 | uuid | no | gen_random_uuid() |  |
| `company_id` | uuid | sí | — |  |
| `target_type` | text | sí | — |  |
| `target_name` | text | sí | — |  |
| `method` | text | sí | — |  |
| `created_at` | timestamp without time zone | sí | now() |  |

</details>
<details><summary><code>mrr_adjustments</code> → <code>mrr-adjustment.espejo.ts</code> · 15 columnas</summary>

| Columna | Tipo Postgres | Nulo | Default | Comentario |
|---|---|---|---|---|
| `id` 🔑 | uuid | no | gen_random_uuid() |  |
| `holding_id` | uuid | no | — |  |
| `contract_id` | uuid | no | — |  |
| `company_id` | uuid | no | — |  |
| `type` | text | no | — |  |
| `amount_contract_currency` | numeric | no | — |  |
| `currency` | text | no | — |  |
| `effective_date` | date | no | — |  |
| `approved` | boolean | no | false |  |
| `approved_by` | uuid | sí | — |  |
| `applied_retroactively` | boolean | no | false |  |
| `description` | text | sí | — |  |
| `created_by` | uuid | sí | — |  |
| `created_at` | timestamp with time zone | no | now() |  |
| `updated_at` | timestamp with time zone | no | now() |  |

</details>
<details><summary><code>accounting_period_cutoff</code> → <code>accounting-period-cutoff.espejo.ts</code> · 12 columnas</summary>

| Columna | Tipo Postgres | Nulo | Default | Comentario |
|---|---|---|---|---|
| `id` 🔑 | uuid | no | gen_random_uuid() |  |
| `holding_id` | uuid | no | — |  |
| `company_id` | uuid | no | — |  |
| `cutoff_date` | date | sí | — |  |
| `last_action` | text | sí | — |  |
| `last_action_at` | timestamp with time zone | sí | — |  |
| `last_action_by` | uuid | sí | — |  |
| `last_action_by_name` | text | sí | — |  |
| `last_action_by_email` | text | sí | — |  |
| `last_action_reason` | text | sí | — |  |
| `created_at` | timestamp with time zone | no | now() |  |
| `updated_at` | timestamp with time zone | no | now() |  |

</details>
<details><summary><code>accounting_period_events</code> → <code>accounting-period-event.espejo.ts</code> · 12 columnas</summary>

| Columna | Tipo Postgres | Nulo | Default | Comentario |
|---|---|---|---|---|
| `id` 🔑 | uuid | no | gen_random_uuid() |  |
| `holding_id` | uuid | no | — |  |
| `company_id` | uuid | no | — |  |
| `action` | text | no | — |  |
| `cutoff_date_before` | date | sí | — |  |
| `cutoff_date_after` | date | no | — |  |
| `performed_by` | uuid | no | — |  |
| `performed_by_name` | text | no | — |  |
| `performed_by_email` | text | no | — |  |
| `performed_at` | timestamp with time zone | no | now() |  |
| `reason` | text | no | — |  |
| `created_at` | timestamp with time zone | no | now() |  |

</details>

## Verificación (sin conexión a la DB)

- `revenue.entities.spec.ts`: metadata TypeORM en memoria vs `revenue.prod-snapshot.ts` — columnas + nullabilidad, PK, FKs (tabla y ON DELETE), UNIQUE, CHECK e índices declarables — y que ningún espejo duplica una tabla de `scripts/espejo/existing-entities.json`.
- `../../database.module.spec.ts`: `synchronize: false`, nadie habilita sincronización, ningún `.entity.ts` dentro de `entities/<modulo>/`.
