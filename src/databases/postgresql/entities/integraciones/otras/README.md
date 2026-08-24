# Módulo 10 · Integraciones — otras — 4 tablas de prod (2026-08-22)

> Convención y reglas: `../../README.md`. Rarezas verificadas: `../../NOTAS-ESPEJO.md`. Veredictos de producto: `docs/v2-rediseno/04-spec-modelo-dominio-v2/00-tablas-por-modulo.md` (no aplican en este paso).
> Origen de TODO lo que está en esta carpeta: lectura en vivo de prod `hklompkypzqtglprfobu` vía MCP de Supabase el 2026-08-22 — `list_tables verbose` + `execute_sql` de solo lectura sobre `pg_catalog` (`scripts/espejo/snapshots/integraciones-otras.{pgmeta,catalog}.json`); metadata real de las entities existentes en `integraciones-otras.existing.json` (`scripts/espejo/extract-existing-metadata.ts`). Generado con `scripts/espejo/generate-espejo.py`.

## A · Tablas que YA tenían entity en el repo (3) — no se tocaron ni se duplicaron

Estas entities están **prendidas en producción** exactamente como estaban (`database.module.ts` las carga por el glob `src/**/*.entity.ts` y sus módulos las registran en `forFeature`). "Estado vs prod" = diff entre lo que la entity declara hoy (metadata TypeORM real) y la DB en vivo; es el insumo para completarlas en el paso 3 con Leon.

| Tabla (filas) | Entity existente (archivo · clase) | Estado vs prod | Columnas que faltan en la entity | Columnas que sobran | Diferencias en columnas existentes | Constraints / índices / FKs que la entity no declara |
|---|---|---|---|---|---|---|
| `bigquery_connections` (1) | `src/databases/postgresql/entities/bigquery-connection.entity.ts` · `BigQueryConnection` | ⚠️ difiere de prod | — | — | `is_active`: NOT NULL en la entity vs nullable en DB<br>`created_at`: NOT NULL en la entity vs nullable en DB<br>`updated_at`: NOT NULL en la entity vs nullable en DB | nombre de PK `bigquery_connections_pkey`<br>UNIQUE `bigquery_connections_holding_id_name_key` (holding_id, name)<br>FK `bigquery_connections_holding_id_fkey` → company_holdings ON DELETE CASCADE<br>FK `bigquery_connections_user_id_fkey` → users ON DELETE CASCADE<br>índice `idx_bigquery_connections_holding_id`<br>índice `idx_bigquery_connections_is_active`<br>índice `idx_bigquery_connections_user_id` |
| `field_mappings` (4) | `src/databases/postgresql/entities/field-mapping.entity.ts` · `FieldMapping` | ⚠️ difiere de prod | — | — | `is_active`: NOT NULL en la entity vs nullable en DB<br>`created_at`: NOT NULL en la entity vs nullable en DB<br>`updated_at`: NOT NULL en la entity vs nullable en DB | nombre de PK `field_mappings_pkey`<br>UNIQUE `unique_field_mapping` (holding_id, mapping_type, source_model, target_table)<br>CHECK `field_mappings_mapping_type_check`<br>FK `field_mappings_created_by_fkey` → users<br>FK `field_mappings_holding_id_fkey` → company_holdings<br>índice `idx_field_mappings_active` (parcial)<br>índice `idx_field_mappings_hierarchical` (parcial)<br>índice `idx_field_mappings_holding_id`<br>índice `idx_field_mappings_mapping_type`<br>índice `idx_field_mappings_source_model`<br>índice `idx_field_mappings_target_table` |
| `integration_logs` (1378) | `src/databases/postgresql/entities/integration-log.entity.ts` · `IntegrationLog` | ⚠️ difiere de prod | `mapping_id` uuid<br>`created_by` uuid<br>`batch_id` uuid<br>`result` jsonb | `operation`<br>`request_data`<br>`response_data`<br>`error_message`<br>`duration_ms`<br>`created_at`<br>`user_id`<br>`external_id` | `source_table`: nullable en la entity vs NOT NULL en DB<br>`target_table`: nullable en la entity vs NOT NULL en DB<br>`started_at`: tipo `timestamp with time zone` vs DB `timestamp without time zone`<br>`started_at`: default `None` vs DB `now()`<br>`completed_at`: tipo `timestamp with time zone` vs DB `timestamp without time zone`<br>`status`: default `None` vs DB `'running'::text`<br>`integration_type`: tipo `text` vs DB `varchar`<br>`integration_type`: NOT NULL en la entity vs nullable en DB<br>`integration_type`: length `None` vs DB `100`<br>`metadata`: default `None` vs DB `'{}'::jsonb` | nombre de PK `integration_logs_pkey`<br>CHECK `integration_logs_status_check`<br>FK `integration_logs_holding_id_fkey` → company_holdings<br>FK `integration_logs_mapping_id_fkey` → field_mappings<br>FK `integration_logs_created_by_fkey` → users<br>índice `idx_integration_logs_batch_id`<br>índice `idx_integration_logs_connection_id`<br>índice `idx_integration_logs_holding_id`<br>índice `idx_integration_logs_integration_type`<br>índice `idx_integration_logs_progress_total`<br>índice `idx_integration_logs_started_at`<br>índice `idx_integration_logs_status` |

## B · Tablas SIN entity → espejos creados (1), APAGADOS

| Tabla (filas, RLS) | Espejo · clase | Cols | PK | UNIQUE | CHECK | FKs (→ tabla, ON DELETE) | Índices | Triggers | Policies |
|---|---|---|---|---|---|---|---|---|---|
| `integration_configs` (0, RLS on) | `integration-config.espejo.ts` · `IntegrationConfig` | 7 | `integration_configs_pkey` (id) | — | `integration_configs_status_check` | `fk_integration_configs_holding_id` → company_holdings (CASCADE)<br>`integration_configs_company_id_fkey` → companies | `idx_integration_configs_holding_id` | — | 4 |

Cada espejo contiene, leído en vivo: columnas con tipo real (`timestamp with/without time zone`, `varchar` + `length`, `numeric` + `precision/scale`, enums de Postgres con sus valores, `text[]`, `jsonb`, `uuid`…), nullable, default y comentario; PK con nombre (`primaryKeyConstraintName`); `@Unique`/`@Check`/`@Index` con nombre real (índices parciales con `where`; los índices con expresión, orden u otro método se documentan en el JSDoc pero no se declaran porque `@Index` no los representa); una relación `@ManyToOne` por FK con `onDelete` real y `foreignKeyConstraintName` — hacia la entity existente (`@/modules/...`) si la tabla destino ya la tiene, o hacia el espejo de su módulo; cabecera JSDoc con filas, RLS, comentario de tabla, tablas que la referencian, triggers y policies (nombre, comando, roles). Las expresiones `USING`/`WITH CHECK` de las policies quedan en `scripts/espejo/snapshots/integraciones-otras.catalog.json` (`policies_detail`) para el paso 4.

**Cómo están apagados (código técnico)**: el archivo termina en `.espejo.ts`, no en `.entity.ts`. `database.module.ts` carga entities con `entities: [__dirname + '/../../**/*.entity{.ts,.js}']`, así que no los ve, y ningún módulo los incluye en `TypeOrmModule.forFeature([...])`. `database.module.spec.ts` falla si aparece un `.entity.ts` dentro de `entities/<modulo>/`. Para encenderlos en el paso 3: renombrar a `.entity.ts` y registrarlos en el `forFeature` del módulo que los use.

## C · Columnas exactas de cada espejo (1 tablas)

<details><summary><code>integration_configs</code> → <code>integration-config.espejo.ts</code> · 7 columnas</summary>

| Columna | Tipo Postgres | Nulo | Default | Comentario |
|---|---|---|---|---|
| `id` 🔑 | uuid | no | gen_random_uuid() |  |
| `company_id` | uuid | sí | — |  |
| `service_name` | text | sí | — |  |
| `status` | text | sí | 'Disconnected'::text |  |
| `last_sync_at` | timestamp without time zone | sí | — |  |
| `created_at` | timestamp without time zone | sí | now() |  |
| `holding_id` | uuid | sí | — |  |

</details>

## Verificación (sin conexión a la DB)

- `integraciones-otras.entities.spec.ts`: metadata TypeORM en memoria vs `integraciones-otras.prod-snapshot.ts` — columnas + nullabilidad, PK, FKs (tabla y ON DELETE), UNIQUE, CHECK e índices declarables — y que ningún espejo duplica una tabla de `scripts/espejo/existing-entities.json`.
- `../../../database.module.spec.ts`: `synchronize: false`, nadie habilita sincronización, ningún `.entity.ts` dentro de `entities/<modulo>/`.
