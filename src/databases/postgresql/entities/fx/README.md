# Módulo 2 · FX y datos económicos — 7 tablas de prod (2026-08-22)

> Convención y reglas: `../README.md`. Rarezas verificadas: `../NOTAS-ESPEJO.md`. Veredictos de producto: `docs/v2-rediseno/04-spec-modelo-dominio-v2/00-tablas-por-modulo.md` (no aplican en este paso).
> Origen de TODO lo que está en esta carpeta: lectura en vivo de prod `hklompkypzqtglprfobu` vía MCP de Supabase el 2026-08-22 — `list_tables verbose` + `execute_sql` de solo lectura sobre `pg_catalog` (`scripts/espejo/snapshots/fx.{pgmeta,catalog}.json`); metadata real de las entities existentes en `fx.existing.json` (`scripts/espejo/extract-existing-metadata.ts`). Generado con `scripts/espejo/generate-espejo.py`.

## A · Tablas que YA tenían entity en el repo (4) — no se tocaron ni se duplicaron

Estas entities están **prendidas en producción** exactamente como estaban (`database.module.ts` las carga por el glob `src/**/*.entity.ts` y sus módulos las registran en `forFeature`). "Estado vs prod" = diff entre lo que la entity declara hoy (metadata TypeORM real) y la DB en vivo; es el insumo para completarlas en el paso 3 con Leon.

| Tabla (filas) | Entity existente (archivo · clase) | Estado vs prod | Columnas que faltan en la entity | Columnas que sobran | Diferencias en columnas existentes | Constraints / índices / FKs que la entity no declara |
|---|---|---|---|---|---|---|
| `exchange_rates` (8513) | `src/modules/banco-central/entities/exchange-rate.entity.ts` · `ExchangeRateEntity` | ⚠️ difiere de prod | — | — | `from_currency`: tipo `varchar` vs DB `text`<br>`to_currency`: tipo `varchar` vs DB `text`<br>`created_at`: tipo `timestamp` vs DB `timestamp with time zone`<br>`created_at`: default `CURRENT_TIMESTAMP` vs DB `now()`<br>`source_type`: tipo `varchar` vs DB `text`<br>`source_type`: default `BANCOCENTRAL` vs DB `'system'::text`<br>`api_source`: tipo `varchar` vs DB `text`<br>`api_source`: default `None` vs DB `'system'::text`<br>`is_indirect_conversion`: NOT NULL en la entity vs nullable en DB | nombre de PK `exchange_rates_pkey`<br>índice `idx_exchange_rates_currencies`<br>índice `idx_exchange_rates_date`<br>índice con expresión `idx_exchange_rates_lookup` |
| `exchange_rates_monthly_avg` (445) | `src/modules/banco-central/entities/exchange-rate-monthly-avg.entity.ts` · `ExchangeRateMonthlyAvgEntity` | ⚠️ difiere de prod | — | — | `from_currency`: tipo `varchar` vs DB `text`<br>`to_currency`: tipo `varchar` vs DB `text`<br>`min_rate`: NOT NULL en la entity vs nullable en DB<br>`max_rate`: NOT NULL en la entity vs nullable en DB<br>`data_points`: NOT NULL en la entity vs nullable en DB<br>`calculated_at`: tipo `timestamp` vs DB `timestamp with time zone`<br>`calculated_at`: NOT NULL en la entity vs nullable en DB<br>`calculated_at`: default `CURRENT_TIMESTAMP` vs DB `now()` | nombre de PK `exchange_rates_monthly_avg_pkey`<br>índice `idx_exchange_rates_monthly_avg_currencies`<br>índice `idx_exchange_rates_monthly_avg_period` |
| `indicadores_economicos` (42) | `src/modules/banco-central/entities/indicador-economico.entity.ts` · `IndicadorEconomicoEntity` | ⚠️ difiere de prod | — | — | `status_code`: NOT NULL en la entity vs nullable en DB | nombre de PK `indicadores_economicos_pkey`<br>índice `idx_indicadores_economicos_codigo`<br>índice `idx_indicadores_economicos_fecha` |
| `generic_export_vats` (8) | `src/databases/postgresql/entities/generic-export-vat.entity.ts` · `GenericExportVat` | ⚠️ difiere de prod | `description` text<br>`country_code` varchar | `holding_id`<br>`tax_id`<br>`company_name`<br>`address`<br>`country`<br>`vat_rate`<br>`metadata` | `vat`: tipo `text` vs DB `varchar`<br>`vat`: length `None` vs DB `50`<br>`updated_at`: nullable en la entity vs NOT NULL en DB<br>`updated_at`: default `None` vs DB `now()` | nombre de PK `generic_export_vats_pkey`<br>UNIQUE `generic_export_vats_vat_key` (vat)<br>índice `idx_generic_export_vats_is_active`<br>índice `idx_generic_export_vats_vat` |

## B · Tablas SIN entity → espejos creados (3), APAGADOS

| Tabla (filas, RLS) | Espejo · clase | Cols | PK | UNIQUE | CHECK | FKs (→ tabla, ON DELETE) | Índices | Triggers | Policies |
|---|---|---|---|---|---|---|---|---|---|
| `holding_fx_period_rates` (71, RLS on) | `holding-fx-period-rate.espejo.ts` · `HoldingFxPeriodRate` | 11 | `holding_fx_period_rates_pkey` (id) | `holding_fx_period_rates_unique_period` | `holding_fx_period_rates_period_check`, `holding_fx_period_rates_rate_check` | `holding_fx_period_rates_created_by_fkey` → users<br>`holding_fx_period_rates_holding_id_fkey` → company_holdings (CASCADE) | `idx_holding_fx_period_rates_currencies`, `idx_holding_fx_period_rates_holding`, `idx_holding_fx_period_rates_period` | update_holding_fx_period_rates_updated_at · BEFORE UPDATE FOR EACH ROW → update_updated_at_column()<br>validate_holding_fx_period_rates_trigger · BEFORE INSERT OR UPDATE FOR EACH ROW → validate_holding_fx_period_rates() | 4 |
| `contract_fx_period_rates` (1, RLS on) | `contract-fx-period-rate.espejo.ts` · `ContractFxPeriodRate` | 12 | `contract_fx_period_rates_pkey` (id) | — | `contract_fx_period_rates_check`, `contract_fx_period_rates_rate_check` | `contract_fx_period_rates_contract_id_fkey` → contracts (CASCADE)<br>`fk_contract_fx_period_rates_holding_id` → company_holdings (CASCADE) | `idx_contract_fx_rates_contract_id`, `idx_contract_fx_rates_currencies`, `idx_contract_fx_rates_holding_contract`, `idx_contract_fx_rates_period` | trg_contract_fx_rates_updated_at · BEFORE UPDATE FOR EACH ROW → update_updated_at_column() | 4 |
| `fx_api_sync_log` (3, RLS on) | `fx-api-sync-log.espejo.ts` · `FxApiSyncLog` | 10 | `fx_api_sync_log_pkey` (id) | — | `fx_api_sync_log_status_check` | `fx_api_sync_log_holding_id_fkey` → company_holdings | — | — | 2 |

Cada espejo contiene, leído en vivo: columnas con tipo real (`timestamp with/without time zone`, `varchar` + `length`, `numeric` + `precision/scale`, enums de Postgres con sus valores, `text[]`, `jsonb`, `uuid`…), nullable, default y comentario; PK con nombre (`primaryKeyConstraintName`); `@Unique`/`@Check`/`@Index` con nombre real (índices parciales con `where`; los índices con expresión, orden u otro método se documentan en el JSDoc pero no se declaran porque `@Index` no los representa); una relación `@ManyToOne` por FK con `onDelete` real y `foreignKeyConstraintName` — hacia la entity existente (`@/modules/...`) si la tabla destino ya la tiene, o hacia el espejo de su módulo; cabecera JSDoc con filas, RLS, comentario de tabla, tablas que la referencian, triggers y policies (nombre, comando, roles). Las expresiones `USING`/`WITH CHECK` de las policies quedan en `scripts/espejo/snapshots/fx.catalog.json` (`policies_detail`) para el paso 4.

**Cómo están apagados (código técnico)**: el archivo termina en `.espejo.ts`, no en `.entity.ts`. `database.module.ts` carga entities con `entities: [__dirname + '/../../**/*.entity{.ts,.js}']`, así que no los ve, y ningún módulo los incluye en `TypeOrmModule.forFeature([...])`. `database.module.spec.ts` falla si aparece un `.entity.ts` dentro de `entities/<modulo>/`. Para encenderlos en el paso 3: renombrar a `.entity.ts` y registrarlos en el `forFeature` del módulo que los use.

## C · Columnas exactas de cada espejo (3 tablas)

<details><summary><code>holding_fx_period_rates</code> → <code>holding-fx-period-rate.espejo.ts</code> · 11 columnas</summary>

| Columna | Tipo Postgres | Nulo | Default | Comentario |
|---|---|---|---|---|
| `id` 🔑 | uuid | no | gen_random_uuid() |  |
| `holding_id` | uuid | no | — |  |
| `from_currency` | text | no | — |  |
| `to_currency` | text | no | — |  |
| `rate` | numeric | no | — |  |
| `period_start` | date | no | — |  |
| `period_end` | date | no | — |  |
| `notes` | text | sí | — |  |
| `created_by` | uuid | sí | — |  |
| `created_at` | timestamp with time zone | no | now() |  |
| `updated_at` | timestamp with time zone | no | now() |  |

</details>
<details><summary><code>contract_fx_period_rates</code> → <code>contract-fx-period-rate.espejo.ts</code> · 12 columnas</summary>

| Columna | Tipo Postgres | Nulo | Default | Comentario |
|---|---|---|---|---|
| `id` 🔑 | uuid | no | gen_random_uuid() |  |
| `contract_id` | uuid | no | — |  |
| `holding_id` | uuid | no | — |  |
| `from_currency` | text | no | — |  |
| `to_currency` | text | no | — |  |
| `rate` | numeric(15,6) | no | — |  |
| `period_start` | date | no | — |  |
| `period_end` | date | no | — |  |
| `notes` | text | sí | — |  |
| `created_by` | uuid | sí | — |  |
| `created_at` | timestamp with time zone | sí | now() |  |
| `updated_at` | timestamp with time zone | sí | now() |  |

</details>
<details><summary><code>fx_api_sync_log</code> → <code>fx-api-sync-log.espejo.ts</code> · 10 columnas</summary>

| Columna | Tipo Postgres | Nulo | Default | Comentario |
|---|---|---|---|---|
| `id` 🔑 | uuid | no | gen_random_uuid() |  |
| `holding_id` | uuid | sí | — |  |
| `sync_date` | date | no | — |  |
| `api_source` | text | no | — |  |
| `currencies_synced` | text[] | sí | '{}'::text[] |  |
| `records_created` | integer | sí | 0 |  |
| `records_updated` | integer | sí | 0 |  |
| `status` | text | no | 'pending'::text |  |
| `error_details` | jsonb | sí | — |  |
| `created_at` | timestamp with time zone | no | now() |  |

</details>

## Verificación (sin conexión a la DB)

- `fx.entities.spec.ts`: metadata TypeORM en memoria vs `fx.prod-snapshot.ts` — columnas + nullabilidad, PK, FKs (tabla y ON DELETE), UNIQUE, CHECK e índices declarables — y que ningún espejo duplica una tabla de `scripts/espejo/existing-entities.json`.
- `../../database.module.spec.ts`: `synchronize: false`, nadie habilita sincronización, ningún `.entity.ts` dentro de `entities/<modulo>/`.
