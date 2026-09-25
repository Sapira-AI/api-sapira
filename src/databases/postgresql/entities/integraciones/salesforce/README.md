# Módulo 10 · Integraciones — Salesforce — 12 tablas de prod (2026-09-24)

> Convención y reglas: `../../README.md`. Rarezas verificadas: `../../NOTAS-ESPEJO.md`. Veredictos de producto: `docs/v2-rediseno/04-spec-modelo-dominio-v2/00-tablas-por-modulo.md` (no aplican en este paso).
> Origen de TODO lo que está en esta carpeta: lectura en vivo de prod `hklompkypzqtglprfobu` vía MCP de Supabase el 2026-09-24 — `list_tables verbose` + `execute_sql` de solo lectura sobre `pg_catalog` (`scripts/espejo/snapshots/integraciones-salesforce.{pgmeta,catalog}.json`); metadata real de las entities existentes en `integraciones-salesforce.existing.json` (`scripts/espejo/extract-existing-metadata.ts`). Generado con `scripts/espejo/generate-espejo.py`.

## A · Tablas que YA tenían entity en el repo (11) — no se tocaron ni se duplicaron

Estas entities están **prendidas en producción** exactamente como estaban (`database.module.ts` las carga por el glob `src/**/*.entity.ts` y sus módulos las registran en `forFeature`). "Estado vs prod" = diff entre lo que la entity declara hoy (metadata TypeORM real) y la DB en vivo; es el insumo para completarlas en el paso 3 con Leon.

| Tabla (filas) | Entity existente (archivo · clase) | Estado vs prod | Columnas que faltan en la entity | Columnas que sobran | Diferencias en columnas existentes | Constraints / índices / FKs que la entity no declara |
|---|---|---|---|---|---|---|
| `salesforce_connections` (3) | `src/databases/postgresql/entities/integraciones/salesforce/salesforce-connection.entity.ts` · `SalesforceConnection` | ⚠️ difiere de prod | — | — | — | nombre de PK `salesforce_connections_pkey`<br>CHECK `salesforce_connections_auth_type_check` |
| `salesforce_accounts_stg` (111) | `src/databases/postgresql/entities/integraciones/salesforce/salesforce-accounts-stg.entity.ts` · `SalesforceAccountsStg` | ⚠️ difiere de prod | — | — | — | nombre de PK `salesforce_accounts_stg_pkey`<br>CHECK `salesforce_accounts_stg_status_check` |
| `salesforce_opportunities_stg` (149) | `src/databases/postgresql/entities/integraciones/salesforce/salesforce-opportunities-stg.entity.ts` · `SalesforceOpportunitiesStg` | ⚠️ difiere de prod | — | — | — | nombre de PK `salesforce_opportunities_stg_pkey`<br>CHECK `salesforce_opportunities_stg_status_check` |
| `salesforce_line_items_stg` (162) | `src/databases/postgresql/entities/integraciones/salesforce/salesforce-line-items-stg.entity.ts` · `SalesforceLineItemsStg` | ⚠️ difiere de prod | — | — | — | nombre de PK `salesforce_line_items_stg_pkey`<br>CHECK `salesforce_line_items_stg_status_check` |
| `salesforce_object_mappings` (1483) | `src/databases/postgresql/entities/integraciones/salesforce/salesforce-object-mapping.entity.ts` · `SalesforceObjectMapping` | ⚠️ difiere de prod | — | — | `last_synced_at`: default `CURRENT_TIMESTAMP` vs DB `now()` | nombre de PK `salesforce_object_mappings_pkey` |
| `salesforce_field_mappings` (42) | `src/databases/postgresql/entities/integraciones/salesforce/salesforce-field-mapping.entity.ts` · `SalesforceFieldMapping` | ⚠️ difiere de prod | — | — | — | nombre de PK `salesforce_field_mappings_pkey`<br>CHECK `salesforce_field_mappings_object_type_check` |
| `salesforce_product_mappings` (61) | `src/databases/postgresql/entities/integraciones/salesforce/salesforce-product-mapping.entity.ts` · `SalesforceProductMapping` | ⚠️ difiere de prod | — | — | — | nombre de PK `salesforce_product_mappings_pkey` |
| `salesforce_quote_type_mappings` (6) | `src/databases/postgresql/entities/integraciones/salesforce/salesforce-quote-type-mapping.entity.ts` · `SalesforceQuoteTypeMapping` | ⚠️ difiere de prod | — | — | — | nombre de PK `salesforce_quote_type_mappings_pkey` |
| `salesforce_sync_runs` (41) | `src/databases/postgresql/entities/integraciones/salesforce/salesforce-sync-run.entity.ts` · `SalesforceSyncRun` | ⚠️ difiere de prod | — | — | — | nombre de PK `salesforce_sync_runs_pkey`<br>CHECK `salesforce_sync_runs_status_check`<br>CHECK `salesforce_sync_runs_type_check` |
| `salesforce_sync_run_items` (296) | `src/databases/postgresql/entities/integraciones/salesforce/salesforce-sync-run-item.entity.ts` · `SalesforceSyncRunItem` | ⚠️ difiere de prod | — | — | — | nombre de PK `salesforce_sync_run_items_pkey`<br>CHECK `salesforce_sync_run_items_status_check` |
| `salesforce_opportunities_cache` (0) | `src/databases/postgresql/entities/integraciones/salesforce/salesforce-opportunity-cache.entity.ts` · `SalesforceOpportunityCache` | ⚠️ difiere de prod | — | — | `sync_date`: default `('now'::text)::date` vs DB `CURRENT_DATE` | nombre de PK `salesforce_opportunities_cache_pkey`<br>índice con expresión `idx_sf_opp_cache_close_date`<br>índice con expresión `idx_sf_opp_cache_sync_date` |

## B · Tablas SIN entity previa → espejos generados (1): 1 promovidas, 0 apagadas

| Tabla (filas, RLS) | Archivo · clase | Cols | PK | UNIQUE | CHECK | FKs (→ tabla, ON DELETE) | Índices | Triggers | Policies |
|---|---|---|---|---|---|---|---|---|---|
| `salesforce_sync_logs` (0, RLS on) | `salesforce-sync-log.entity.ts` · `SalesforceSyncLog` | 9 | `salesforce_sync_logs_pkey` (id) | — | — | `salesforce_sync_logs_holding_id_fkey` → company_holdings (CASCADE) | `idx_salesforce_sync_logs_holding_id`, `idx_salesforce_sync_logs_created_at` (expresión, no declarado), `idx_salesforce_sync_logs_sync_date` (expresión, no declarado) | — | 1 |

Cada espejo contiene, leído en vivo: columnas con tipo real (`timestamp with/without time zone`, `varchar` + `length`, `numeric` + `precision/scale`, enums de Postgres con sus valores, `text[]`, `jsonb`, `uuid`…), nullable, default y comentario; PK con nombre (`primaryKeyConstraintName`); `@Unique`/`@Check`/`@Index` con nombre real (índices parciales con `where`; los índices con expresión, orden u otro método se documentan en el JSDoc pero no se declaran porque `@Index` no los representa); una relación `@ManyToOne` por FK con `onDelete` real y `foreignKeyConstraintName` — hacia la entity existente (`@/modules/...`) si la tabla destino ya la tiene, o hacia el espejo de su módulo; cabecera JSDoc con filas, RLS, comentario de tabla, tablas que la referencian, triggers y policies (nombre, comando, roles). Las expresiones `USING`/`WITH CHECK` de las policies quedan en `scripts/espejo/snapshots/integraciones-salesforce.catalog.json` (`policies_detail`) para el paso 4.

**Estado: todas promovidas.** Cada archivo termina en `.entity.ts`, así que `database.module.ts` las carga por el glob `entities: [__dirname + '/../../**/*.entity{.ts,.js}']` y quedan disponibles para `TypeOrmModule.forFeature([...])` en el módulo que las use. Cada promoción está registrada a mano en `promotedMirrorEntities` de `database.module.spec.ts`. **Desde el 2026-09-22 el generador ya NO las reescribe**: la entity es la fuente de verdad de su tabla y se edita a mano (entity → `migration:generate` → revisar → `migration:run`). Lo que el generador sigue emitiendo para ellas es el snapshot contra el que las mide su spec, el barrel y este README: si el spec queda en rojo, el repo y prod difieren, y el snapshot se refresca con `yarn schema:snapshot` DESPUÉS de aplicar el cambio a prod.

## C · Columnas exactas de cada espejo (1 tablas)

<details><summary><code>salesforce_sync_logs</code> → <code>salesforce-sync-log.entity.ts</code> · 9 columnas</summary>

| Columna | Tipo Postgres | Nulo | Default | Comentario |
|---|---|---|---|---|
| `id` 🔑 | uuid | no | gen_random_uuid() |  |
| `holding_id` | uuid | sí | — |  |
| `sync_date` | date | no | CURRENT_DATE | Fecha de los datos sincronizados (no la fecha de ejecución) |
| `opportunities_count` | integer | sí | 0 | Número de oportunidades encontradas en la sincronización |
| `accounts_count` | integer | sí | 0 |  |
| `success` | boolean | sí | false |  |
| `error_message` | text | sí | — |  |
| `execution_time_ms` | integer | sí | — | Tiempo de ejecución en milisegundos |
| `created_at` | timestamp with time zone | sí | now() |  |

</details>

## Verificación (sin conexión a la DB)

- `integraciones-salesforce.entities.spec.ts`: metadata TypeORM en memoria vs `integraciones-salesforce.prod-snapshot.ts` — columnas + nullabilidad, PK, FKs (tabla y ON DELETE), UNIQUE, CHECK e índices declarables — y que ningún espejo duplica una tabla de `scripts/espejo/existing-entities.json`.
- `../../../database.module.spec.ts`: `synchronize: false`, nadie habilita sincronización, y un espejo solo se carga en runtime si su promoción figura en `promotedMirrorEntities`.
