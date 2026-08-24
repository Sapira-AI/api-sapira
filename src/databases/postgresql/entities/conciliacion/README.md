# Módulo 9 · Conciliación y pagos — 3 tablas de prod (2026-08-22)

> Convención y reglas: `../README.md`. Rarezas verificadas: `../NOTAS-ESPEJO.md`. Veredictos de producto: `docs/v2-rediseno/04-spec-modelo-dominio-v2/00-tablas-por-modulo.md` (no aplican en este paso).
> Origen de TODO lo que está en esta carpeta: lectura en vivo de prod `hklompkypzqtglprfobu` vía MCP de Supabase el 2026-08-22 — `list_tables verbose` + `execute_sql` de solo lectura sobre `pg_catalog` (`scripts/espejo/snapshots/conciliacion.{pgmeta,catalog}.json`); metadata real de las entities existentes en `conciliacion.existing.json` (`scripts/espejo/extract-existing-metadata.ts`). Generado con `scripts/espejo/generate-espejo.py`.

## A · Tablas que YA tenían entity en el repo (0) — no se tocaron ni se duplicaron

Ninguna: todas las tablas de este módulo carecían de entity.

## B · Tablas SIN entity → espejos creados (3), APAGADOS

| Tabla (filas, RLS) | Espejo · clase | Cols | PK | UNIQUE | CHECK | FKs (→ tabla, ON DELETE) | Índices | Triggers | Policies |
|---|---|---|---|---|---|---|---|---|---|
| `bank_movements` (0, RLS on) | `bank-movement.espejo.ts` · `BankMovement` | 19 | `bank_movements_pkey` (id) | — | `bank_movements_match_confidence_check`, `bank_movements_status_check` | `bank_movements_reconciled_by_fkey` → users<br>`fk_bank_movements_holding_id` → company_holdings (CASCADE)<br>`bank_movements_company_id_fkey` → companies<br>`bank_movements_suggested_invoice_id_fkey` → invoices<br>`bank_movements_batch_id_fkey` → bank_upload_batches (CASCADE)<br>`bank_movements_reconciled_invoice_id_fkey` → invoices | `idx_bank_movements_batch_id`, `idx_bank_movements_holding_date`, `idx_bank_movements_holding_id`, `idx_bank_movements_reconciled_invoice`, `idx_bank_movements_status` | — | 4 |
| `bank_upload_batches` (0, RLS on) | `bank-upload-batch.espejo.ts` · `BankUploadBatch` | 11 | `bank_upload_batches_pkey` (id) | — | `bank_upload_batches_status_check` | `bank_upload_batches_uploaded_by_fkey` → users<br>`bank_upload_batches_bank_account_id_fkey` → company_bank_accounts | — | — | 4 |
| `bank_column_mappings` (0, RLS on) | `bank-column-mapping.espejo.ts` · `BankColumnMapping` | 7 | `bank_column_mappings_pkey` (id) | — | — | — | — | — | 4 |

Cada espejo contiene, leído en vivo: columnas con tipo real (`timestamp with/without time zone`, `varchar` + `length`, `numeric` + `precision/scale`, enums de Postgres con sus valores, `text[]`, `jsonb`, `uuid`…), nullable, default y comentario; PK con nombre (`primaryKeyConstraintName`); `@Unique`/`@Check`/`@Index` con nombre real (índices parciales con `where`; los índices con expresión, orden u otro método se documentan en el JSDoc pero no se declaran porque `@Index` no los representa); una relación `@ManyToOne` por FK con `onDelete` real y `foreignKeyConstraintName` — hacia la entity existente (`@/modules/...`) si la tabla destino ya la tiene, o hacia el espejo de su módulo; cabecera JSDoc con filas, RLS, comentario de tabla, tablas que la referencian, triggers y policies (nombre, comando, roles). Las expresiones `USING`/`WITH CHECK` de las policies quedan en `scripts/espejo/snapshots/conciliacion.catalog.json` (`policies_detail`) para el paso 4.

**Cómo están apagados (código técnico)**: el archivo termina en `.espejo.ts`, no en `.entity.ts`. `database.module.ts` carga entities con `entities: [__dirname + '/../../**/*.entity{.ts,.js}']`, así que no los ve, y ningún módulo los incluye en `TypeOrmModule.forFeature([...])`. `database.module.spec.ts` falla si aparece un `.entity.ts` dentro de `entities/<modulo>/`. Para encenderlos en el paso 3: renombrar a `.entity.ts` y registrarlos en el `forFeature` del módulo que los use.

## C · Columnas exactas de cada espejo (3 tablas)

<details><summary><code>bank_movements</code> → <code>bank-movement.espejo.ts</code> · 19 columnas</summary>

| Columna | Tipo Postgres | Nulo | Default | Comentario |
|---|---|---|---|---|
| `id` 🔑 | uuid | no | gen_random_uuid() |  |
| `company_id` | uuid | sí | — |  |
| `bank_name` | text | sí | — |  |
| `bank_account` | text | sí | — |  |
| `movement_date` | date | sí | — |  |
| `description` | text | sí | — |  |
| `amount` | numeric | sí | — |  |
| `currency` | text | sí | — |  |
| `status` | text | sí | 'Pendiente'::text |  |
| `suggested_invoice_id` | uuid | sí | — |  |
| `created_at` | timestamp without time zone | sí | now() |  |
| `holding_id` | uuid | sí | — |  |
| `batch_id` | uuid | sí | — |  |
| `reconciled_invoice_id` | uuid | sí | — |  |
| `reconciled_at` | timestamp with time zone | sí | — |  |
| `reconciled_by` | uuid | sí | — |  |
| `match_confidence` | text | sí | — |  |
| `match_score` | numeric | sí | — |  |
| `original_row_data` | jsonb | sí | — |  |

</details>
<details><summary><code>bank_upload_batches</code> → <code>bank-upload-batch.espejo.ts</code> · 11 columnas</summary>

| Columna | Tipo Postgres | Nulo | Default | Comentario |
|---|---|---|---|---|
| `id` 🔑 | uuid | no | gen_random_uuid() |  |
| `holding_id` | uuid | no | — |  |
| `company_id` | uuid | sí | — |  |
| `bank_account_id` | uuid | sí | — |  |
| `file_name` | text | no | — |  |
| `file_hash` | text | sí | — |  |
| `row_count` | integer | no | 0 |  |
| `column_mapping` | jsonb | no | — |  |
| `status` | text | no | 'Procesado'::text |  |
| `uploaded_by` | uuid | sí | — |  |
| `created_at` | timestamp with time zone | no | now() |  |

</details>
<details><summary><code>bank_column_mappings</code> → <code>bank-column-mapping.espejo.ts</code> · 7 columnas</summary>

| Columna | Tipo Postgres | Nulo | Default | Comentario |
|---|---|---|---|---|
| `id` 🔑 | uuid | no | gen_random_uuid() |  |
| `holding_id` | uuid | no | — |  |
| `bank_name` | text | no | — |  |
| `mapping_name` | text | no | — |  |
| `column_mapping` | jsonb | no | — | JSON con: date_column, description_column, amount_column, currency_column, default_currency, date_format, decimal_separator, thousands_separator, skip_rows, amount_sign_convention |
| `is_default` | boolean | sí | false |  |
| `created_at` | timestamp with time zone | no | now() |  |

</details>

## Verificación (sin conexión a la DB)

- `conciliacion.entities.spec.ts`: metadata TypeORM en memoria vs `conciliacion.prod-snapshot.ts` — columnas + nullabilidad, PK, FKs (tabla y ON DELETE), UNIQUE, CHECK e índices declarables — y que ningún espejo duplica una tabla de `scripts/espejo/existing-entities.json`.
- `../../database.module.spec.ts`: `synchronize: false`, nadie habilita sincronización, ningún `.entity.ts` dentro de `entities/<modulo>/`.
