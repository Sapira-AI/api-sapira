# Módulo 10 · Integraciones — Odoo — 6 tablas de prod (2026-08-22)

> Convención y reglas: `../../README.md`. Rarezas verificadas: `../../NOTAS-ESPEJO.md`. Veredictos de producto: `docs/v2-rediseno/04-spec-modelo-dominio-v2/00-tablas-por-modulo.md` (no aplican en este paso).
> Origen de TODO lo que está en esta carpeta: lectura en vivo de prod `hklompkypzqtglprfobu` vía MCP de Supabase el 2026-08-22 — `list_tables verbose` + `execute_sql` de solo lectura sobre `pg_catalog` (`scripts/espejo/snapshots/integraciones-odoo.{pgmeta,catalog}.json`); metadata real de las entities existentes en `integraciones-odoo.existing.json` (`scripts/espejo/extract-existing-metadata.ts`). Generado con `scripts/espejo/generate-espejo.py`.

## A · Tablas que YA tenían entity en el repo (5) — no se tocaron ni se duplicaron

Estas entities están **prendidas en producción** exactamente como estaban (`database.module.ts` las carga por el glob `src/**/*.entity.ts` y sus módulos las registran en `forFeature`). "Estado vs prod" = diff entre lo que la entity declara hoy (metadata TypeORM real) y la DB en vivo; es el insumo para completarlas en el paso 3 con Leon.

| Tabla (filas) | Entity existente (archivo · clase) | Estado vs prod | Columnas que faltan en la entity | Columnas que sobran | Diferencias en columnas existentes | Constraints / índices / FKs que la entity no declara |
|---|---|---|---|---|---|---|
| `odoo_connections` (3) | `src/modules/odoo/entities/odoo-connection.entity.ts` · `OdooConnection` | ⚠️ difiere de prod | — | — | `created_at`: NOT NULL en la entity vs nullable en DB<br>`updated_at`: NOT NULL en la entity vs nullable en DB | nombre de PK `odoo_connections_pkey`<br>UNIQUE `odoo_connections_holding_id_name_key` (holding_id, name)<br>FK `odoo_connections_holding_id_fkey` → company_holdings ON DELETE CASCADE<br>FK `odoo_connections_user_id_fkey` → users ON DELETE CASCADE<br>índice `idx_odoo_connections_holding_id`<br>índice `idx_odoo_connections_is_active`<br>índice `idx_odoo_connections_user_id` |
| `odoo_invoices_stg` (10233) | `src/modules/odoo/entities/odoo-invoices-stg.entity.ts` · `OdooInvoicesStg` | ⚠️ difiere de prod | — | — | `processing_status`: default `create` vs DB `'pending'::text`<br>`created_at`: NOT NULL en la entity vs nullable en DB<br>`created_at`: default `CURRENT_TIMESTAMP` vs DB `now()`<br>`updated_at`: NOT NULL en la entity vs nullable en DB<br>`updated_at`: default `CURRENT_TIMESTAMP` vs DB `now()` | nombre de PK `odoo_invoices_stg_pkey`<br>UNIQUE `odoo_invoices_stg_holding_id_odoo_id_key` (holding_id, odoo_id)<br>CHECK `odoo_invoices_stg_processing_status_check`<br>FK `odoo_invoices_stg_holding_id_fkey` → company_holdings<br>índice `idx_odoo_invoices_stg_batch_id`<br>índice `idx_odoo_invoices_stg_error` (parcial)<br>índice `idx_odoo_invoices_stg_holding_status`<br>índice `idx_odoo_invoices_stg_odoo_id_status`<br>índice `idx_odoo_invoices_stg_processing_status`<br>índice `idx_odoo_invoices_stg_sync_batch`<br>índice `idx_odoo_invoices_stg_sync_session` (parcial) |
| `odoo_invoice_lines_stg` (14888) | `src/modules/odoo/entities/odoo-invoice-lines-stg.entity.ts` · `OdooInvoiceLinesStg` | ⚠️ difiere de prod | — | — | `created_at`: NOT NULL en la entity vs nullable en DB<br>`created_at`: default `CURRENT_TIMESTAMP` vs DB `now()`<br>`updated_at`: NOT NULL en la entity vs nullable en DB<br>`updated_at`: default `CURRENT_TIMESTAMP` vs DB `now()` | nombre de PK `odoo_invoice_lines_stg_pkey`<br>UNIQUE `odoo_invoice_lines_stg_holding_id_odoo_line_id_key` (holding_id, odoo_line_id)<br>CHECK `odoo_invoice_lines_stg_processing_status_check`<br>FK `odoo_invoice_lines_stg_invoice_staging_id_fkey` → odoo_invoices_stg ON DELETE CASCADE<br>FK `odoo_invoice_lines_stg_holding_id_fkey` → company_holdings<br>índice `idx_odoo_invoice_lines_stg_batch_id` (parcial)<br>índice `idx_odoo_invoice_lines_stg_error` (parcial)<br>índice `idx_odoo_invoice_lines_stg_holding_status`<br>índice `idx_odoo_invoice_lines_stg_invoice_staging_id`<br>índice `idx_odoo_invoice_lines_stg_odoo_invoice_id`<br>índice `idx_odoo_invoice_lines_stg_odoo_line_id`<br>índice `idx_odoo_invoice_lines_stg_processing_status`<br>índice `idx_odoo_invoice_lines_stg_sync_session` (parcial) |
| `odoo_partners_stg` (816) | `src/modules/odoo/entities/odoo-partners-stg.entity.ts` · `OdooPartnersStg` | ⚠️ difiere de prod | — | — | `id`: tipo `Number` vs DB `bigint`<br>`id`: default `None` vs DB `nextval('odoo_partners_stg_id_seq'::regclass)`<br>`created_at`: NOT NULL en la entity vs nullable en DB<br>`created_at`: default `CURRENT_TIMESTAMP` vs DB `now()`<br>`updated_at`: NOT NULL en la entity vs nullable en DB<br>`updated_at`: default `CURRENT_TIMESTAMP` vs DB `now()` | nombre de PK `odoo_partners_stg_pkey`<br>UNIQUE `odoo_partners_stg_odoo_id_holding_id_key` (odoo_id, holding_id)<br>CHECK `odoo_partners_stg_processing_status_check`<br>FK `odoo_partners_stg_holding_id_fkey` → company_holdings<br>índice `idx_odoo_partners_stg_batch_id`<br>índice `idx_odoo_partners_stg_holding_id`<br>índice `idx_odoo_partners_stg_odoo_id`<br>índice `idx_odoo_partners_stg_odoo_id_status`<br>índice `idx_odoo_partners_stg_processed_at`<br>índice `idx_odoo_partners_stg_processing_status`<br>índice con expresión `idx_odoo_partners_stg_raw_data_gin` |
| `odoo_product_mappings` (41) | `src/modules/odoo/entities/odoo-product-mapping.entity.ts` · `OdooProductMapping` | ⚠️ difiere de prod | — | — | `created_at`: NOT NULL en la entity vs nullable en DB<br>`updated_at`: NOT NULL en la entity vs nullable en DB<br>`metadata`: NOT NULL en la entity vs nullable en DB | nombre de PK `odoo_product_mappings_pkey`<br>UNIQUE `unique_odoo_mapping` (holding_id, sapira_product_id, odoo_product_id)<br>FK `odoo_product_mappings_holding_id_fkey` → company_holdings ON DELETE CASCADE<br>índice `idx_odoo_mappings_holding`<br>índice `idx_odoo_mappings_holding_odoo`<br>índice `idx_odoo_mappings_odoo_product`<br>índice `idx_odoo_mappings_sapira_product` |

## B · Tablas SIN entity → espejos creados (1), APAGADOS

| Tabla (filas, RLS) | Espejo · clase | Cols | PK | UNIQUE | CHECK | FKs (→ tabla, ON DELETE) | Índices | Triggers | Policies |
|---|---|---|---|---|---|---|---|---|---|
| `odoo_object_mappings` (0, RLS on) | `odoo-object-mapping.espejo.ts` · `OdooObjectMapping` | 9 | `odoo_object_mappings_pkey` (id) | `unique_odoo_object_per_holding` | — | `odoo_object_mappings_holding_id_fkey` → company_holdings (CASCADE) | `idx_odoo_object_mappings_holding`, `idx_odoo_object_mappings_odoo_lookup`, `idx_odoo_object_mappings_sapira_lookup` | trigger_update_odoo_mapping_timestamp · BEFORE UPDATE FOR EACH ROW → update_odoo_mapping_updated_at() | 4 |

Cada espejo contiene, leído en vivo: columnas con tipo real (`timestamp with/without time zone`, `varchar` + `length`, `numeric` + `precision/scale`, enums de Postgres con sus valores, `text[]`, `jsonb`, `uuid`…), nullable, default y comentario; PK con nombre (`primaryKeyConstraintName`); `@Unique`/`@Check`/`@Index` con nombre real (índices parciales con `where`; los índices con expresión, orden u otro método se documentan en el JSDoc pero no se declaran porque `@Index` no los representa); una relación `@ManyToOne` por FK con `onDelete` real y `foreignKeyConstraintName` — hacia la entity existente (`@/modules/...`) si la tabla destino ya la tiene, o hacia el espejo de su módulo; cabecera JSDoc con filas, RLS, comentario de tabla, tablas que la referencian, triggers y policies (nombre, comando, roles). Las expresiones `USING`/`WITH CHECK` de las policies quedan en `scripts/espejo/snapshots/integraciones-odoo.catalog.json` (`policies_detail`) para el paso 4.

**Cómo están apagados (código técnico)**: el archivo termina en `.espejo.ts`, no en `.entity.ts`. `database.module.ts` carga entities con `entities: [__dirname + '/../../**/*.entity{.ts,.js}']`, así que no los ve, y ningún módulo los incluye en `TypeOrmModule.forFeature([...])`. `database.module.spec.ts` falla si aparece un `.entity.ts` dentro de `entities/<modulo>/`. Para encenderlos en el paso 3: renombrar a `.entity.ts` y registrarlos en el `forFeature` del módulo que los use.

## C · Columnas exactas de cada espejo (1 tablas)

<details><summary><code>odoo_object_mappings</code> → <code>odoo-object-mapping.espejo.ts</code> · 9 columnas</summary>

| Columna | Tipo Postgres | Nulo | Default | Comentario |
|---|---|---|---|---|
| `id` 🔑 | uuid | no | gen_random_uuid() |  |
| `holding_id` | uuid | no | — |  |
| `odoo_object_type` | text | no | — | Tipo de objeto en Odoo (invoice, client, etc) |
| `odoo_object_id` | text | no | — | ID del objeto en Odoo |
| `sapira_table_name` | text | no | — | Nombre de la tabla en Sapira |
| `sapira_record_id` | uuid | no | — | ID del registro en Sapira |
| `created_at` | timestamp with time zone | no | now() |  |
| `updated_at` | timestamp with time zone | no | now() |  |
| `last_synced_at` | timestamp with time zone | no | now() |  |

</details>

## Verificación (sin conexión a la DB)

- `integraciones-odoo.entities.spec.ts`: metadata TypeORM en memoria vs `integraciones-odoo.prod-snapshot.ts` — columnas + nullabilidad, PK, FKs (tabla y ON DELETE), UNIQUE, CHECK e índices declarables — y que ningún espejo duplica una tabla de `scripts/espejo/existing-entities.json`.
- `../../../database.module.spec.ts`: `synchronize: false`, nadie habilita sincronización, ningún `.entity.ts` dentro de `entities/<modulo>/`.
