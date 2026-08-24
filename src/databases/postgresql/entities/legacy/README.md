# Módulo 8 · Legacy / onboarding — 4 tablas de prod (2026-08-22)

> Convención y reglas: `../README.md`. Rarezas verificadas: `../NOTAS-ESPEJO.md`. Veredictos de producto: `docs/v2-rediseno/04-spec-modelo-dominio-v2/00-tablas-por-modulo.md` (no aplican en este paso).
> Origen de TODO lo que está en esta carpeta: lectura en vivo de prod `hklompkypzqtglprfobu` vía MCP de Supabase el 2026-08-22 — `list_tables verbose` + `execute_sql` de solo lectura sobre `pg_catalog` (`scripts/espejo/snapshots/legacy.{pgmeta,catalog}.json`); metadata real de las entities existentes en `legacy.existing.json` (`scripts/espejo/extract-existing-metadata.ts`). Generado con `scripts/espejo/generate-espejo.py`.

## A · Tablas que YA tenían entity en el repo (0) — no se tocaron ni se duplicaron

Ninguna: todas las tablas de este módulo carecían de entity.

## B · Tablas SIN entity → espejos creados (4), APAGADOS

| Tabla (filas, RLS) | Espejo · clase | Cols | PK | UNIQUE | CHECK | FKs (→ tabla, ON DELETE) | Índices | Triggers | Policies |
|---|---|---|---|---|---|---|---|---|---|
| `invoices_legacy` (9311, RLS on) | `invoices-legacy.espejo.ts` · `InvoicesLegacy` | 27 | `invoices_legacy_pkey` (id) | `invoices_legacy_holding_invoice_number_unique`, `invoices_legacy_holding_odoo_integration_key` | `invoices_legacy_reconciliation_status_check`, `invoices_legacy_source_type_check`, `invoices_legacy_status_check` | `invoices_legacy_company_id_fkey` → companies (CASCADE)<br>`fk_invoices_client_entity` → client_entities<br>`invoices_legacy_created_by_fkey` → users (SET NULL)<br>`invoices_legacy_holding_id_fkey` → company_holdings (CASCADE)<br>`invoices_legacy_client_id_fkey` → clients (SET NULL)<br>`invoices_legacy_contract_id_fkey` → contracts (SET NULL)<br>`invoices_legacy_reconciled_invoice_id_fkey` → invoices (SET NULL) | `idx_invoices_legacy_client_entity_id`, `idx_invoices_legacy_client_id` (parcial), `idx_invoices_legacy_client_tax_id`, `idx_invoices_legacy_contract_id`, `idx_invoices_legacy_holding`, `idx_invoices_legacy_issue_date`, `idx_invoices_legacy_odoo_integration_id`, `idx_invoices_legacy_reconciliation_status`, `idx_invoices_legacy_status` | trigger_auto_populate_client_tax_id · BEFORE INSERT OR UPDATE FOR EACH ROW → auto_populate_client_tax_id_from_entity() | 4 |
| `invoice_items_legacy` (11722, RLS on) | `invoice-items-legacy.espejo.ts` · `InvoiceItemsLegacy` | 18 | `invoice_items_legacy_pkey` (id) | `invoice_items_legacy_holding_odoo_line_id_key` | — | `invoice_items_legacy_holding_id_fkey` → company_holdings (CASCADE)<br>`invoice_items_legacy_invoices_legacy_id_fkey` → invoices_legacy (CASCADE) | `idx_invoice_items_legacy_currency` (parcial), `idx_invoice_items_legacy_holding`, `idx_invoice_items_legacy_holding_odoo_line`, `idx_invoice_items_legacy_invoice`, `idx_invoice_items_legacy_item_type` (parcial), `idx_invoice_items_legacy_odoo_line_id`, `idx_invoice_items_legacy_product_code` (parcial), `idx_invoice_items_legacy_unit_of_measure` (parcial) | — | 4 |
| `invoice_items_legacy_match` (78, RLS on) | `invoice-items-legacy-match.espejo.ts` · `InvoiceItemsLegacyMatch` | 16 | `invoice_items_legacy_match_pkey` (id) | — | `invoice_items_legacy_match_status_check`, `match_amount_positive` | `invoice_items_legacy_match_created_by_fkey` → users (CASCADE)<br>`invoice_items_legacy_match_confirmed_by_fkey` → users (SET NULL)<br>`invoice_items_legacy_match_holding_id_fkey` → company_holdings (CASCADE)<br>`invoice_items_legacy_match_contract_item_id_fkey` → contract_items (CASCADE)<br>`invoice_items_legacy_match_contract_id_fkey` → contracts (CASCADE)<br>`invoice_items_legacy_match_invoice_item_legacy_id_fkey` → invoice_items_legacy (CASCADE)<br>`invoice_items_legacy_match_product_id_fkey` → products (SET NULL) | `idx_legacy_match_contract`, `idx_legacy_match_contract_item`, `idx_legacy_match_holding`, `idx_legacy_match_item`, `idx_legacy_match_status` | trigger_prevent_confirmed_match_edit · BEFORE UPDATE FOR EACH ROW → prevent_confirmed_match_edit()<br>trigger_set_match_confirmed_metadata · BEFORE UPDATE FOR EACH ROW → set_match_confirmed_metadata()<br>trigger_update_invoice_legacy_status · AFTER INSERT OR DELETE OR UPDATE FOR EACH ROW → update_invoice_legacy_status()<br>trigger_validate_match_total · BEFORE INSERT OR UPDATE FOR EACH ROW → validate_match_total() | 4 |
| `mrr_legacy` (11810, RLS on) | `mrr-legacy.espejo.ts` · `MrrLegacy` | 45 | `mrr_legacy_pkey` (id) | `mrr_legacy_invoice_item_legacy_id_split_index_period_month_key` | `mrr_legacy_fx_valid`, `mrr_legacy_momentum_check`, `mrr_legacy_period_month_check`, `mrr_legacy_split_index_check`, `mrr_legacy_term_check` | `mrr_legacy_invoice_item_legacy_id_fkey` → invoice_items_legacy (CASCADE)<br>`mrr_legacy_holding_id_fkey` → company_holdings (CASCADE)<br>`mrr_legacy_client_id_fkey` → clients<br>`mrr_legacy_migrated_to_contract_id_fkey` → contracts (SET NULL)<br>`mrr_legacy_migrated_by_fkey` → users<br>`mrr_legacy_company_id_fkey` → companies<br>`mrr_legacy_invoice_legacy_id_fkey` → invoices_legacy (CASCADE) | `idx_mrr_legacy_batch_id`, `idx_mrr_legacy_client`, `idx_mrr_legacy_company`, `idx_mrr_legacy_holding`, `idx_mrr_legacy_invoice`, `idx_mrr_legacy_invoice_created`, `idx_mrr_legacy_invoice_item`, `idx_mrr_legacy_migrated` (parcial), `idx_mrr_legacy_not_migrated` (parcial), `idx_mrr_legacy_period`, `idx_mrr_legacy_product`, `idx_mrr_legacy_recurring` (parcial), `idx_mrr_legacy_skip_activation` (parcial) | trg_calculate_mrr_legacy_fields · BEFORE INSERT OR UPDATE OF subtotal_contract_currency, term, is_recurring FOR EACH ROW → calculate_mrr_legacy_fields()<br>trg_calculate_mrr_legacy_system_currency · BEFORE INSERT OR UPDATE OF contract_currency, mrr_legacy, period_month FOR EACH ROW → calculate_mrr_legacy_system_currency()<br>trg_mrr_legacy_updated_at · BEFORE UPDATE FOR EACH ROW → set_updated_at()<br>trigger_update_invoice_legacy_status_on_mrr · AFTER INSERT FOR EACH ROW → update_invoice_legacy_status_on_mrr_creation() | 4 |

Cada espejo contiene, leído en vivo: columnas con tipo real (`timestamp with/without time zone`, `varchar` + `length`, `numeric` + `precision/scale`, enums de Postgres con sus valores, `text[]`, `jsonb`, `uuid`…), nullable, default y comentario; PK con nombre (`primaryKeyConstraintName`); `@Unique`/`@Check`/`@Index` con nombre real (índices parciales con `where`; los índices con expresión, orden u otro método se documentan en el JSDoc pero no se declaran porque `@Index` no los representa); una relación `@ManyToOne` por FK con `onDelete` real y `foreignKeyConstraintName` — hacia la entity existente (`@/modules/...`) si la tabla destino ya la tiene, o hacia el espejo de su módulo; cabecera JSDoc con filas, RLS, comentario de tabla, tablas que la referencian, triggers y policies (nombre, comando, roles). Las expresiones `USING`/`WITH CHECK` de las policies quedan en `scripts/espejo/snapshots/legacy.catalog.json` (`policies_detail`) para el paso 4.

**Cómo están apagados (código técnico)**: el archivo termina en `.espejo.ts`, no en `.entity.ts`. `database.module.ts` carga entities con `entities: [__dirname + '/../../**/*.entity{.ts,.js}']`, así que no los ve, y ningún módulo los incluye en `TypeOrmModule.forFeature([...])`. `database.module.spec.ts` falla si aparece un `.entity.ts` dentro de `entities/<modulo>/`. Para encenderlos en el paso 3: renombrar a `.entity.ts` y registrarlos en el `forFeature` del módulo que los use.

## C · Columnas exactas de cada espejo (4 tablas)

<details><summary><code>invoices_legacy</code> → <code>invoices-legacy.espejo.ts</code> · 27 columnas</summary>

| Columna | Tipo Postgres | Nulo | Default | Comentario |
|---|---|---|---|---|
| `id` 🔑 | uuid | no | gen_random_uuid() |  |
| `holding_id` | uuid | no | — |  |
| `company_id` | uuid | no | — |  |
| `client_id` | uuid | sí | — |  |
| `client_tax_id` | text | sí | — | ID fiscal del cliente. Puede ser NULL para integraciones donde no se tiene este dato. |
| `legal_client_name` | text | no | — |  |
| `source_type` | text | no | — |  |
| `source_system` | text | sí | — |  |
| `invoice_number` | text | no | — |  |
| `issue_date` | date | no | — |  |
| `due_date` | date | sí | — |  |
| `invoice_currency` | text | no | — |  |
| `amount_invoice_currency` | numeric(15,2) | no | — |  |
| `total_invoice_currency` | numeric(15,2) | no | — |  |
| `vat` | numeric(15,2) | sí | — |  |
| `fx_contract_to_invoice` | numeric(12,6) | sí | — |  |
| `status` | text | no | 'Enviada'::text | Estado de pago: Enviada (emitida sin pago), Vencida (pasó due_date sin pago), Pagada (pagada) |
| `pdf_url` | text | sí | — |  |
| `notes` | text | sí | — |  |
| `created_at` | timestamp with time zone | sí | now() |  |
| `created_by` | uuid | sí | — |  |
| `contract_id` | uuid | sí | — |  |
| `reconciliation_status` | text | sí | 'pending'::text | Estado de reconciliación: pending (sin reconciliar), partially_reconciled (parcialmente reconciliada), reconciled (reconciliada completamente), migrated (migrada a invoices), mrr_legacy (usada en registro MRR Legacy) |
| `reconciled_invoice_id` | uuid | sí | — |  |
| `reconciled_at` | timestamp with time zone | sí | — |  |
| `client_entity_id` | uuid | sí | — | Referencia a la entidad legal del cliente (client_entities). El client_id se completa desde el contrato. |
| `odoo_integration_id` | integer | sí | — | ID de la factura en Odoo. Usado para mapear líneas de factura desde Odoo hacia Sapira |

</details>
<details><summary><code>invoice_items_legacy</code> → <code>invoice-items-legacy.espejo.ts</code> · 18 columnas</summary>

| Columna | Tipo Postgres | Nulo | Default | Comentario |
|---|---|---|---|---|
| `id` 🔑 | uuid | no | gen_random_uuid() |  |
| `invoices_legacy_id` | uuid | no | — |  |
| `holding_id` | uuid | no | — |  |
| `product_external_code` | text | sí | — |  |
| `description` | text | no | — |  |
| `quantity` | numeric(15,4) | no | 1 |  |
| `unit_price` | numeric(15,2) | no | — |  |
| `discount_pct` | numeric(5,2) | sí | 0 |  |
| `tax_code` | text | sí | — |  |
| `currency` | text | sí | — | Moneda del item de factura. Puede ser NULL y heredar de la factura padre. |
| `subtotal` | numeric(15,2) | no | — |  |
| `tax_amount` | numeric(15,2) | sí | 0 |  |
| `total` | numeric(15,2) | no | — |  |
| `account_code` | text | sí | — |  |
| `created_at` | timestamp with time zone | sí | now() |  |
| `item_type` | text | sí | — | Tipo de item normalizado desde contract_item durante reconciliación (fixed, variable, usage-based, etc.) |
| `unit_of_measure` | text | sí | — | Unidad de medida normalizada desde contract_item durante reconciliación (license, hours, users, etc.) |
| `odoo_line_id` | text | sí | — | ID de la línea en Odoo (account.move.line.id). Usado para identificar y evitar duplicados de líneas importadas desde Odoo. |

</details>
<details><summary><code>invoice_items_legacy_match</code> → <code>invoice-items-legacy-match.espejo.ts</code> · 16 columnas</summary>

| Columna | Tipo Postgres | Nulo | Default | Comentario |
|---|---|---|---|---|
| `id` 🔑 | uuid | no | gen_random_uuid() |  |
| `invoice_item_legacy_id` | uuid | no | — |  |
| `contract_id` | uuid | no | — |  |
| `contract_item_id` | uuid | sí | — |  |
| `product_id` | uuid | sí | — |  |
| `contract_currency` | text | no | — |  |
| `fx_contract_to_invoice` | numeric(12,6) | no | — |  |
| `amount_contract_currency` | numeric(15,2) | no | — |  |
| `amount_invoice_currency` | numeric(15,2) | no | — |  |
| `status` | text | no | 'tentative'::text |  |
| `notes` | text | sí | — |  |
| `created_by` | uuid | no | — |  |
| `created_at` | timestamp with time zone | sí | now() |  |
| `confirmed_at` | timestamp with time zone | sí | — |  |
| `confirmed_by` | uuid | sí | — |  |
| `holding_id` | uuid | no | — | Holding ID para seguridad multi-tenant |

</details>
<details><summary><code>mrr_legacy</code> → <code>mrr-legacy.espejo.ts</code> · 45 columnas</summary>

| Columna | Tipo Postgres | Nulo | Default | Comentario |
|---|---|---|---|---|
| `id` 🔑 | uuid | no | gen_random_uuid() |  |
| `holding_id` | uuid | no | — |  |
| `invoice_legacy_id` | uuid | no | — |  |
| `invoice_item_legacy_id` | uuid | no | — |  |
| `split_index` | integer | no | 1 | Índice de división cuando una línea de factura se asigna a múltiples productos/monedas |
| `company_id` | uuid | no | — |  |
| `client_tax_id` | text | no | — |  |
| `legal_client_name` | text | no | — |  |
| `invoice_number` | text | no | — |  |
| `issue_date` | date | no | — |  |
| `invoice_currency` | text | no | — |  |
| `amount_invoice_currency` | numeric(15,2) | no | — |  |
| `total_invoice_currency` | numeric(15,2) | no | — |  |
| `vat` | numeric(15,2) | sí | — |  |
| `status` | text | no | — |  |
| `description` | text | no | — |  |
| `currency` | text | no | — |  |
| `quantity` | numeric(15,4) | sí | — |  |
| `unit_price` | numeric(15,2) | sí | — |  |
| `discount_pct` | numeric(5,2) | sí | — |  |
| `subtotal` | numeric(15,2) | no | — | Subtotal original del invoice_item_legacy (sin dividir) |
| `allocated_invoice_currency` | numeric(15,2) | no | — | Monto asignado a este split en moneda de factura |
| `client_id` | uuid | no | — |  |
| `contract_currency` | text | no | — |  |
| `subtotal_contract_currency` | numeric(15,2) | no | — | Monto en moneda de contrato ingresado por usuario |
| `product_name` | text | no | — |  |
| `term` | integer | no | — | Cantidad de períodos del contrato (para calcular MRR) |
| `period_month` | date | no | — | Período mensual (YYYY-MM-01). Una fila por mes. |
| `is_recurring` | boolean | no | true |  |
| `fx_contract_to_invoice` | numeric(12,6) | no | — | FX calculado entre subtotal_contract_currency y allocated_invoice_currency |
| `fx_contract_to_system` | numeric(12,6) | sí | — |  |
| `mrr_legacy` | numeric(15,2) | sí | — | MRR calculado: subtotal_contract_currency / term (solo si is_recurring) |
| `mrr_legacy_system_currency` | numeric(15,2) | sí | — |  |
| `momentum` | text | sí | — | Siempre EOP para registros recurrentes, NULL para no recurrentes |
| `created_by` | uuid | sí | auth.uid() | Usuario que creó el registro de MRR legacy |
| `created_at` | timestamp with time zone | no | now() |  |
| `updated_at` | timestamp with time zone | no | now() |  |
| `migrated_to_contract_id` | uuid | sí | — | Contrato creado desde este registro legacy |
| `migrated_at` | timestamp with time zone | sí | — | Fecha de migración a contrato activo |
| `migrated_by` | uuid | sí | — | Usuario que realizó la migración |
| `batch_id` | uuid | no | — | UUID que agrupa registros de MRR Legacy creados en el mismo lote, independientemente de la fecha de creación. Permite agregar facturas a grupos existentes. |
| `skip_activation` | boolean | no | false | When true, this record should not be activated (e.g., churn, duplicate, error) |
| `skip_activation_reason` | text | sí | — | Reason why activation was skipped (e.g., Churn, Duplicado, Error de importación) |
| `skip_activation_at` | timestamp with time zone | sí | — | Timestamp when skip_activation was set to true |
| `skip_activation_by` | uuid | sí | — | User who marked this record as skip_activation |

</details>

## Verificación (sin conexión a la DB)

- `legacy.entities.spec.ts`: metadata TypeORM en memoria vs `legacy.prod-snapshot.ts` — columnas + nullabilidad, PK, FKs (tabla y ON DELETE), UNIQUE, CHECK e índices declarables — y que ningún espejo duplica una tabla de `scripts/espejo/existing-entities.json`.
- `../../database.module.spec.ts`: `synchronize: false`, nadie habilita sincronización, ningún `.entity.ts` dentro de `entities/<modulo>/`.
