# Módulo 10 · Integraciones — otras — 3 tablas de prod (2026-09-24)

> Convención y reglas: `../../README.md`. Rarezas verificadas: `../../NOTAS-ESPEJO.md`. Veredictos de producto: `docs/v2-rediseno/04-spec-modelo-dominio-v2/00-tablas-por-modulo.md` (no aplican en este paso).
> Origen de TODO lo que está en esta carpeta: lectura en vivo de prod `hklompkypzqtglprfobu` vía MCP de Supabase el 2026-09-24 — `list_tables verbose` + `execute_sql` de solo lectura sobre `pg_catalog` (`scripts/espejo/snapshots/integraciones-otras.{pgmeta,catalog}.json`); metadata real de las entities existentes en `integraciones-otras.existing.json` (`scripts/espejo/extract-existing-metadata.ts`). Generado con `scripts/espejo/generate-espejo.py`.

## A · Tablas que YA tenían entity en el repo (2) — no se tocaron ni se duplicaron

Estas entities están **prendidas en producción** exactamente como estaban (`database.module.ts` las carga por el glob `src/**/*.entity.ts` y sus módulos las registran en `forFeature`). "Estado vs prod" = diff entre lo que la entity declara hoy (metadata TypeORM real) y la DB en vivo; es el insumo para completarlas en el paso 3 con Leon.

| Tabla (filas) | Entity existente (archivo · clase) | Estado vs prod | Columnas que faltan en la entity | Columnas que sobran | Diferencias en columnas existentes | Constraints / índices / FKs que la entity no declara |
|---|---|---|---|---|---|---|
| `bigquery_connections` (1) | `src/databases/postgresql/entities/integraciones/otras/bigquery-connection.entity.ts` · `BigQueryConnection` | ⚠️ difiere de prod | — | — | — | nombre de PK `bigquery_connections_pkey` |
| `field_mappings` (4) | `src/databases/postgresql/entities/integraciones/otras/field-mapping.entity.ts` · `FieldMapping` | ⚠️ difiere de prod | — | — | — | nombre de PK `field_mappings_pkey`<br>CHECK `field_mappings_mapping_type_check` |

## B · Tablas SIN entity previa → espejos generados (1): 1 promovidas, 0 apagadas

| Tabla (filas, RLS) | Archivo · clase | Cols | PK | UNIQUE | CHECK | FKs (→ tabla, ON DELETE) | Índices | Triggers | Policies |
|---|---|---|---|---|---|---|---|---|---|
| `integration_configs` (0, RLS on) | `integration-config.entity.ts` · `IntegrationConfig` | 7 | `integration_configs_pkey` (id) | — | `integration_configs_status_check` | `fk_integration_configs_holding_id` → company_holdings (CASCADE)<br>`integration_configs_company_id_fkey` → companies | `idx_integration_configs_holding_id` | — | 4 |

Cada espejo contiene, leído en vivo: columnas con tipo real (`timestamp with/without time zone`, `varchar` + `length`, `numeric` + `precision/scale`, enums de Postgres con sus valores, `text[]`, `jsonb`, `uuid`…), nullable, default y comentario; PK con nombre (`primaryKeyConstraintName`); `@Unique`/`@Check`/`@Index` con nombre real (índices parciales con `where`; los índices con expresión, orden u otro método se documentan en el JSDoc pero no se declaran porque `@Index` no los representa); una relación `@ManyToOne` por FK con `onDelete` real y `foreignKeyConstraintName` — hacia la entity existente (`@/modules/...`) si la tabla destino ya la tiene, o hacia el espejo de su módulo; cabecera JSDoc con filas, RLS, comentario de tabla, tablas que la referencian, triggers y policies (nombre, comando, roles). Las expresiones `USING`/`WITH CHECK` de las policies quedan en `scripts/espejo/snapshots/integraciones-otras.catalog.json` (`policies_detail`) para el paso 4.

**Estado: todas promovidas.** Cada archivo termina en `.entity.ts`, así que `database.module.ts` las carga por el glob `entities: [__dirname + '/../../**/*.entity{.ts,.js}']` y quedan disponibles para `TypeOrmModule.forFeature([...])` en el módulo que las use. Cada promoción está registrada a mano en `promotedMirrorEntities` de `database.module.spec.ts`. **Desde el 2026-09-22 el generador ya NO las reescribe**: la entity es la fuente de verdad de su tabla y se edita a mano (entity → `migration:generate` → revisar → `migration:run`). Lo que el generador sigue emitiendo para ellas es el snapshot contra el que las mide su spec, el barrel y este README: si el spec queda en rojo, el repo y prod difieren, y el snapshot se refresca con `yarn schema:snapshot` DESPUÉS de aplicar el cambio a prod.

## C · Columnas exactas de cada espejo (1 tablas)

<details><summary><code>integration_configs</code> → <code>integration-config.entity.ts</code> · 7 columnas</summary>

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
- `../../../database.module.spec.ts`: `synchronize: false`, nadie habilita sincronización, y un espejo solo se carga en runtime si su promoción figura en `promotedMirrorEntities`.
