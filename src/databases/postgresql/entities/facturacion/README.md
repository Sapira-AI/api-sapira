# Módulo 6 · Facturación — 17 tablas de prod (2026-08-22)

> Convención y reglas: `../README.md`. Rarezas verificadas: `../NOTAS-ESPEJO.md`. Veredictos de producto: `docs/v2-rediseno/04-spec-modelo-dominio-v2/00-tablas-por-modulo.md` (no aplican en este paso).
> Origen de TODO lo que está en esta carpeta: lectura en vivo de prod `hklompkypzqtglprfobu` vía MCP de Supabase el 2026-08-22 — `list_tables verbose` + `execute_sql` de solo lectura sobre `pg_catalog` (`scripts/espejo/snapshots/facturacion.{pgmeta,catalog}.json`); metadata real de las entities existentes en `facturacion.existing.json` (`scripts/espejo/extract-existing-metadata.ts`). Generado con `scripts/espejo/generate-espejo.py`.

## A · Tablas que YA tenían entity en el repo (3) — no se tocaron ni se duplicaron

Estas entities están **prendidas en producción** exactamente como estaban (`database.module.ts` las carga por el glob `src/**/*.entity.ts` y sus módulos las registran en `forFeature`). "Estado vs prod" = diff entre lo que la entity declara hoy (metadata TypeORM real) y la DB en vivo; es el insumo para completarlas en el paso 3 con Leon.

| Tabla (filas) | Entity existente (archivo · clase) | Estado vs prod | Columnas que faltan en la entity | Columnas que sobran | Diferencias en columnas existentes | Constraints / índices / FKs que la entity no declara |
|---|---|---|---|---|---|---|
| `invoices` (8717) | `src/modules/invoices/entities/invoice.entity.ts` · `Invoice` | ⚠️ difiere de prod | `credit_type` text<br>`credit_reason` text<br>`nc_revenue_treatment` text | — | `created_at`: NOT NULL en la entity vs nullable en DB | nombre de PK `invoices_pkey`<br>CHECK `invoices_credit_reason_check`<br>CHECK `invoices_credit_type_check`<br>CHECK `invoices_document_type_check`<br>CHECK `invoices_export_type_check`<br>CHECK `invoices_invoice_type_check`<br>CHECK `invoices_nc_revenue_treatment_check`<br>CHECK `invoices_payment_method_check`<br>CHECK `invoices_status_check`<br>FK `invoices_related_invoice_id_fkey` → invoices<br>FK `invoices_company_id_fkey` → companies<br>FK `invoices_client_id_fkey` → clients<br>FK `invoices_contract_id_fkey` → contracts<br>FK `fk_invoices_holding_id` → company_holdings ON DELETE CASCADE<br>FK `invoices_client_entity_id_fkey` → client_entities<br>FK `invoices_subscription_id_fkey` → subscriptions<br>FK `invoices_split_from_invoice_id_fkey` → invoices ON DELETE SET NULL<br>FK `invoices_consolidated_into_invoice_id_fkey` → invoices ON DELETE SET NULL<br>FK `invoices_legacy_invoice_id_fkey` → invoices_legacy ON DELETE SET NULL<br>FK `invoices_holding_id_fkey` → company_holdings<br>índice `idx_invoices_active_contract_period` (parcial)<br>índice `idx_invoices_auto_invoice` (parcial)<br>índice `idx_invoices_consolidated_into` (parcial)<br>índice `idx_invoices_group_id` (parcial)<br>índice `idx_invoices_holding_id`<br>índice `idx_invoices_invoice_type`<br>índice `idx_invoices_odoo_invoice_id` (parcial)<br>índice `idx_invoices_overdue_check` (parcial)<br>índice `idx_invoices_related_invoice_id` (parcial)<br>índice `idx_invoices_requires_references` (parcial)<br>índice `idx_invoices_split_from` (parcial)<br>índice `idx_invoices_stripe_id_holding_id` (parcial)<br>índice `idx_invoices_subscription_id` (parcial)<br>índice con expresión `idx_invoices_custom_fields` |
| `invoice_items` (10339) | `src/modules/invoices/entities/invoice-item.entity.ts` · `InvoiceItem` | ⚠️ difiere de prod | — | — | `holding_id`: default `None` vs DB `gen_random_uuid()`<br>`created_at`: NOT NULL en la entity vs nullable en DB<br>`updated_at`: NOT NULL en la entity vs nullable en DB | nombre de PK `invoice_items_pkey`<br>CHECK `invoice_items_discount_pct_check`<br>CHECK `invoice_items_quantity_check`<br>FK `invoice_items_legacy_item_id_fkey` → invoice_items_legacy ON DELETE SET NULL<br>FK `fk_invoice_items_product` → products ON DELETE SET NULL<br>FK `fk_invoice_items_contract` → contracts ON DELETE CASCADE<br>FK `invoice_items_subscription_item_id_fkey` → subscription_items<br>FK `invoice_items_contract_item_id_fkey` → contract_items ON DELETE SET NULL<br>FK `fk_invoice_items_holding_id` → company_holdings ON DELETE CASCADE<br>FK `invoice_items_invoice_id_fkey` → invoices ON DELETE CASCADE<br>FK `invoice_items_holding_id_fkey` → company_holdings<br>FK `invoice_items_legacy_match_id_fkey` → invoice_items_legacy_match ON DELETE SET NULL<br>índice `idx_invoice_items_billing_period`<br>índice `idx_invoice_items_contract_id`<br>índice `idx_invoice_items_contract_item_id`<br>índice `idx_invoice_items_invoice_id`<br>índice `idx_invoice_items_issue_date`<br>índice `idx_invoice_items_product_id`<br>índice `idx_invoice_items_status`<br>índice `idx_invoice_items_subscription_item_id` (parcial)<br>índice con expresión `idx_invoice_items_custom_fields` |
| `invoice_references` (205) | `src/modules/invoices/entities/invoice-reference.entity.ts` · `InvoiceReference` | ⚠️ difiere de prod | — | — | `created_at`: default `CURRENT_TIMESTAMP` vs DB `now()`<br>`updated_at`: default `CURRENT_TIMESTAMP` vs DB `now()` | nombre de PK `invoice_references_pkey`<br>FK `invoice_references_created_by_fkey` → users<br>índice `idx_invoice_references_holding_id`<br>índice `idx_invoice_references_invoice_id` |

## B · Tablas SIN entity → espejos creados (14), APAGADOS

| Tabla (filas, RLS) | Espejo · clase | Cols | PK | UNIQUE | CHECK | FKs (→ tabla, ON DELETE) | Índices | Triggers | Policies |
|---|---|---|---|---|---|---|---|---|---|
| `invoice_payments` (89, RLS on) | `invoice-payment.espejo.ts` · `InvoicePayment` | 13 | `invoice_payments_pkey` (id) | — | — | `invoice_payments_bank_movement_id_fkey` → bank_movements<br>`invoice_payments_invoice_id_fkey` → invoices (CASCADE) | `idx_invoice_payments_bank_movement`, `idx_invoice_payments_holding_date` | trg_recalc_after_delete · AFTER DELETE FOR EACH ROW → after_invoice_payment_change()<br>trg_recalc_after_insert · AFTER INSERT FOR EACH ROW → after_invoice_payment_change()<br>trg_recalc_after_update · AFTER UPDATE FOR EACH ROW → after_invoice_payment_change()<br>trg_set_invoice_payment_defaults · BEFORE INSERT FOR EACH ROW → set_invoice_payment_defaults() | 4 |
| `billing_references` (0, RLS on) | `billing-reference.espejo.ts` · `BillingReference` | 17 | `billing_references_pkey` (id) | — | — | `billing_references_created_by_fkey` → users<br>`billing_references_holding_id_fkey` → company_holdings (CASCADE)<br>`billing_references_contract_id_fkey` → contracts (CASCADE) | `idx_billing_references_contract`, `idx_billing_references_holding`, `idx_billing_references_status` | — | 4 |
| `reference_requests` (0, RLS on) | `reference-request.espejo.ts` · `ReferenceRequest` | 11 | `reference_requests_pkey` (id) | — | `reference_requests_reference_type_check`, `reference_requests_status_check` | — | `reference_requests_holding_idx` | — | 2 |
| `invoice_reference_links` (0, RLS on) | `invoice-reference-link.espejo.ts` · `InvoiceReferenceLink` | 6 | `invoice_reference_links_pkey` (id) | `invoice_reference_links_invoice_id_reference_id_key` | — | `invoice_reference_links_linked_by_fkey` → users<br>`invoice_reference_links_invoice_id_fkey` → invoices (CASCADE)<br>`invoice_reference_links_reference_id_fkey` → billing_references (CASCADE)<br>`invoice_reference_links_holding_id_fkey` → company_holdings (CASCADE) | `idx_invoice_reference_links_invoice`, `idx_invoice_reference_links_reference` | — | 1 |
| `quantities` (193, RLS on) | `quantity.espejo.ts` · `Quantity` | 16 | `quantities_pkey` (id) | `quantities_unique_item_period` | `quantities_period_check`, `quantities_quantity_check`, `quantities_unit_price_check` | `quantities_created_by_fkey` → users<br>`quantities_contract_item_id_fkey` → contract_items (CASCADE)<br>`quantities_holding_id_fkey` → company_holdings (CASCADE)<br>`quantities_contract_id_fkey` → contracts | `quantities_contract_item_idx`, `quantities_holding_idx`, `quantities_period_idx` | trg_quantities_set_holding · BEFORE INSERT FOR EACH ROW → quantities_set_holding_from_contract_item()<br>trg_restore_invoice_items_on_quantity_delete · AFTER DELETE FOR EACH ROW → restore_invoice_items_amounts_on_quantity_delete()<br>trg_restore_rsm_on_quantity_delete · AFTER DELETE FOR EACH ROW → restore_rsm_on_quantity_delete()<br>trg_rsm_on_quantity_change · AFTER INSERT OR UPDATE FOR EACH ROW → trigger_rsm_on_quantity_change()<br>trg_sync_invoice_items_from_quantities · AFTER INSERT OR UPDATE FOR EACH ROW → sync_invoice_items_amounts_from_quantities()<br>trg_validate_quantity_invoice_status · BEFORE INSERT OR DELETE OR UPDATE FOR EACH ROW → validate_invoice_status_for_quantity_change() | 4 |
| `invoice_restructure_log` (263, RLS on) | `invoice-restructure-log.espejo.ts` · `InvoiceRestructureLog` | 7 | `invoice_restructure_log_pkey` (id) | — | `invoice_restructure_log_action_check` | `invoice_restructure_log_contract_id_fkey` → contracts<br>`invoice_restructure_log_actor_user_id_fkey` → users | `idx_invoice_restructure_log_contract` (expresión, no declarado), `idx_invoice_restructure_log_holding_action` (expresión, no declarado) | — | 2 |
| `invoice_reschedules` (0, RLS on) | `invoice-reschedule.espejo.ts` · `InvoiceReschedule` | 9 | `invoice_reschedules_pkey` (id) | — | — | `invoice_reschedules_changed_by_fkey` → users<br>`invoice_reschedules_holding_id_fkey` → company_holdings (CASCADE)<br>`invoice_reschedules_invoice_id_fkey` → invoices (CASCADE) | `idx_invoice_reschedules_invoice_id` | — | 3 |
| `invoice_adjustments` (0, RLS on) | `invoice-adjustment.espejo.ts` · `InvoiceAdjustment` | 9 | `invoice_adjustments_pkey` (id) | — | `invoice_adjustments_type_check` | `invoice_adjustments_invoice_id_fkey` → invoices (CASCADE)<br>`invoice_adjustments_adjusted_by_fkey` → users | `idx_invoice_adjustments_holding_id`, `idx_invoice_adjustments_invoice_id`, `idx_invoice_adjustments_type` | — | 4 |
| `invoice_emails` (0, RLS on) | `invoice-email.espejo.ts` · `InvoiceEmail` | 10 | `invoice_emails_pkey` (id) | — | `invoice_emails_template_check` | `invoice_emails_sent_by_fkey` → users<br>`invoice_emails_invoice_id_fkey` → invoices (CASCADE) | `idx_invoice_emails_holding_id`, `idx_invoice_emails_invoice_id`, `idx_invoice_emails_template` | — | 4 |
| `invoice_collection_settings` (1, RLS on) | `invoice-collection-settings.espejo.ts` · `InvoiceCollectionSettings` | 11 | `invoice_collection_settings_pkey` (id) | `invoice_collection_settings_holding_id_key` | — | — | `idx_invoice_collection_settings_holding_id` | trg_invoice_collection_settings_updated_at · BEFORE UPDATE FOR EACH ROW → set_updated_at()<br>trg_update_invoice_collection_settings_updated_at · BEFORE UPDATE FOR EACH ROW → update_updated_at_column() | 4 |
| `invoice_collection_logs` (0, RLS on) | `invoice-collection-log.espejo.ts` · `InvoiceCollectionLog` | 11 | `invoice_collection_logs_pkey` (id) | — | — | `invoice_collection_logs_invoice_id_fkey` → invoices (CASCADE) | `idx_invoice_collection_logs_holding_id`, `idx_invoice_collection_logs_invoice_id` | — | 4 |
| `invoice_trigger_debug_logs` (0, RLS OFF) | `invoice-trigger-debug-log.espejo.ts` · `InvoiceTriggerDebugLog` | 10 | `invoice_trigger_debug_logs_pkey` (id) | — | — | — | — | — | 0 |
| `overdue_check_log` (68, RLS on) | `overdue-check-log.espejo.ts` · `OverdueCheckLog` | 10 | `overdue_check_log_pkey` (id) | — | `overdue_check_log_status_check` | `overdue_check_log_holding_id_fkey` → company_holdings (CASCADE) | `idx_overdue_check_log_date` (expresión, no declarado), `idx_overdue_check_log_holding_id` (expresión, no declarado), `idx_overdue_check_log_status` (expresión, no declarado) | — | 2 |
| `period_guard_warnings` (0, RLS on) | `period-guard-warning.espejo.ts` · `PeriodGuardWarning` | 13 | `period_guard_warnings_pkey` (id) | — | — | `period_guard_warnings_triggered_by_fkey` → users (SET NULL) | `idx_pgw_company_time` (expresión, no declarado) | — | 1 |

Cada espejo contiene, leído en vivo: columnas con tipo real (`timestamp with/without time zone`, `varchar` + `length`, `numeric` + `precision/scale`, enums de Postgres con sus valores, `text[]`, `jsonb`, `uuid`…), nullable, default y comentario; PK con nombre (`primaryKeyConstraintName`); `@Unique`/`@Check`/`@Index` con nombre real (índices parciales con `where`; los índices con expresión, orden u otro método se documentan en el JSDoc pero no se declaran porque `@Index` no los representa); una relación `@ManyToOne` por FK con `onDelete` real y `foreignKeyConstraintName` — hacia la entity existente (`@/modules/...`) si la tabla destino ya la tiene, o hacia el espejo de su módulo; cabecera JSDoc con filas, RLS, comentario de tabla, tablas que la referencian, triggers y policies (nombre, comando, roles). Las expresiones `USING`/`WITH CHECK` de las policies quedan en `scripts/espejo/snapshots/facturacion.catalog.json` (`policies_detail`) para el paso 4.

**Cómo están apagados (código técnico)**: el archivo termina en `.espejo.ts`, no en `.entity.ts`. `database.module.ts` carga entities con `entities: [__dirname + '/../../**/*.entity{.ts,.js}']`, así que no los ve, y ningún módulo los incluye en `TypeOrmModule.forFeature([...])`. `database.module.spec.ts` falla si aparece un `.entity.ts` dentro de `entities/<modulo>/`. Para encenderlos en el paso 3: renombrar a `.entity.ts` y registrarlos en el `forFeature` del módulo que los use.

## C · Columnas exactas de cada espejo (14 tablas)

<details><summary><code>invoice_payments</code> → <code>invoice-payment.espejo.ts</code> · 13 columnas</summary>

| Columna | Tipo Postgres | Nulo | Default | Comentario |
|---|---|---|---|---|
| `id` 🔑 | uuid | no | gen_random_uuid() |  |
| `invoice_id` | uuid | no | — |  |
| `holding_id` | uuid | no | — |  |
| `amount` | numeric | no | — |  |
| `currency` | text | no | — |  |
| `payment_date` | date | no | CURRENT_DATE |  |
| `method` | text | sí | — |  |
| `reference` | text | sí | — |  |
| `notes` | text | sí | — |  |
| `confirmed` | boolean | no | true |  |
| `created_by` | uuid | sí | — |  |
| `created_at` | timestamp with time zone | no | now() |  |
| `bank_movement_id` | uuid | sí | — |  |

</details>
<details><summary><code>billing_references</code> → <code>billing-reference.espejo.ts</code> · 17 columnas</summary>

| Columna | Tipo Postgres | Nulo | Default | Comentario |
|---|---|---|---|---|
| `id` 🔑 | uuid | no | gen_random_uuid() |  |
| `holding_id` | uuid | no | — |  |
| `contract_id` | uuid | no | — |  |
| `reference_type` | reference_type_enum (enum: PO, HES, ACCEPTANCE, OTHER) | no | — |  |
| `reference_code` | text | no | — |  |
| `issuer` | text | sí | — |  |
| `issue_date` | date | sí | — |  |
| `valid_from` | date | no | — |  |
| `valid_to` | date | sí | — |  |
| `covers_multiple_invoices` | boolean | sí | false |  |
| `status` | reference_status_enum (enum: Active, Expired, Cancelled) | sí | 'Active'::reference_status_enum |  |
| `file_url` | text | sí | — |  |
| `file_metadata` | jsonb | sí | '{}'::jsonb |  |
| `notes` | text | sí | — |  |
| `created_at` | timestamp with time zone | sí | now() |  |
| `updated_at` | timestamp with time zone | sí | now() |  |
| `created_by` | uuid | sí | — |  |

</details>
<details><summary><code>reference_requests</code> → <code>reference-request.espejo.ts</code> · 11 columnas</summary>

| Columna | Tipo Postgres | Nulo | Default | Comentario |
|---|---|---|---|---|
| `id` 🔑 | uuid | no | gen_random_uuid() |  |
| `holding_id` | uuid | no | — |  |
| `contract_id` | uuid | no | — |  |
| `invoice_id` | uuid | sí | — |  |
| `reference_type` | text | no | — |  |
| `status` | text | no | — |  |
| `file_url` | text | sí | — |  |
| `note` | text | sí | — |  |
| `requested_at` | timestamp with time zone | no | now() |  |
| `received_at` | timestamp with time zone | sí | — |  |
| `created_at` | timestamp with time zone | no | now() |  |

</details>
<details><summary><code>invoice_reference_links</code> → <code>invoice-reference-link.espejo.ts</code> · 6 columnas</summary>

| Columna | Tipo Postgres | Nulo | Default | Comentario |
|---|---|---|---|---|
| `id` 🔑 | uuid | no | gen_random_uuid() |  |
| `invoice_id` | uuid | no | — |  |
| `reference_id` | uuid | no | — |  |
| `holding_id` | uuid | no | — |  |
| `linked_at` | timestamp with time zone | sí | now() |  |
| `linked_by` | uuid | sí | — |  |

</details>
<details><summary><code>quantities</code> → <code>quantity.espejo.ts</code> · 16 columnas</summary>

| Columna | Tipo Postgres | Nulo | Default | Comentario |
|---|---|---|---|---|
| `id` 🔑 | uuid | no | gen_random_uuid() |  |
| `contract_item_id` | uuid | no | — |  |
| `holding_id` | uuid | no | — | Holding propietario. Se auto-setea via trigger si es NULL en insert. |
| `period` | date | no | — | Primer día del mes (YYYY-MM-01). Representa el mes completo. CHECK garantiza normalización. |
| `unit_price` | numeric(18,6) | sí | — | Override de precio unitario para este período. NULL = usar contract_items.unit_price |
| `unit_of_measure` | varchar(32) | sí | — |  |
| `quantity` | numeric(18,6) | sí | — | Override de cantidad para este período. NULL = usar contract_items.quantity. Permite 0 para suspensiones. |
| `created_at` | timestamp with time zone | no | now() |  |
| `updated_at` | timestamp with time zone | no | now() |  |
| `created_by` | uuid | sí | — |  |
| `notes` | text | sí | — |  |
| `contract_id` | uuid | sí | — | FK directo al contrato. Derivado de contract_items.contract_id. Permite joins y triggers RSM sin pasar por contract_items. |
| `amount` | numeric(15,2) | sí | — | Override del monto reconocido del período en moneda de contrato. Reemplaza el cálculo base (final_price / term_months) en recognized_period_contract_ccy para este mes únicamente. NULL = usar cálculo base del contrato. |
| `salesforce_opportunity_id` | text | sí | — | ID de la Opportunity en Salesforce asociada a este registro de quantities. |
| `salesforce_line_item_id` | text | sí | — | ID del Line Item en Salesforce asociado a este registro de quantities. |
| `account` | text | sí | — | Cuenta contable proveniente del DWH (campo account_name en finance.sapira).  Texto libre, se almacena tal como llega del DWH sin mapeo adicional. |

</details>
<details><summary><code>invoice_restructure_log</code> → <code>invoice-restructure-log.espejo.ts</code> · 7 columnas</summary>

| Columna | Tipo Postgres | Nulo | Default | Comentario |
|---|---|---|---|---|
| `id` 🔑 | uuid | no | gen_random_uuid() |  |
| `holding_id` | uuid | no | — |  |
| `contract_id` | uuid | no | — |  |
| `actor_user_id` | uuid | sí | — |  |
| `action` | text | no | — |  |
| `payload` | jsonb | no | — |  |
| `created_at` | timestamp with time zone | no | now() |  |

</details>
<details><summary><code>invoice_reschedules</code> → <code>invoice-reschedule.espejo.ts</code> · 9 columnas</summary>

| Columna | Tipo Postgres | Nulo | Default | Comentario |
|---|---|---|---|---|
| `id` 🔑 | uuid | no | gen_random_uuid() |  |
| `invoice_id` | uuid | no | — |  |
| `holding_id` | uuid | no | — |  |
| `old_date` | date | no | — |  |
| `new_date` | date | no | — |  |
| `reason` | text | no | — |  |
| `changed_by` | uuid | sí | — |  |
| `changed_at` | timestamp with time zone | sí | now() |  |
| `created_at` | timestamp with time zone | sí | now() |  |

</details>
<details><summary><code>invoice_adjustments</code> → <code>invoice-adjustment.espejo.ts</code> · 9 columnas</summary>

| Columna | Tipo Postgres | Nulo | Default | Comentario |
|---|---|---|---|---|
| `id` 🔑 | uuid | no | gen_random_uuid() |  |
| `invoice_id` | uuid | no | — |  |
| `type` | text | no | — |  |
| `amount_diff` | numeric(18,2) | no | — |  |
| `notes` | text | sí | — |  |
| `adjusted_by` | uuid | sí | — |  |
| `adjusted_at` | timestamp with time zone | no | now() |  |
| `holding_id` | uuid | no | — |  |
| `created_at` | timestamp with time zone | no | now() |  |

</details>
<details><summary><code>invoice_emails</code> → <code>invoice-email.espejo.ts</code> · 10 columnas</summary>

| Columna | Tipo Postgres | Nulo | Default | Comentario |
|---|---|---|---|---|
| `id` 🔑 | uuid | no | gen_random_uuid() |  |
| `invoice_id` | uuid | no | — |  |
| `template` | text | no | — |  |
| `recipient` | text | no | — |  |
| `subject` | text | sí | — |  |
| `message` | text | sí | — |  |
| `sent_by` | uuid | sí | — |  |
| `sent_at` | timestamp with time zone | no | now() |  |
| `holding_id` | uuid | no | — |  |
| `created_at` | timestamp with time zone | no | now() |  |

</details>
<details><summary><code>invoice_collection_settings</code> → <code>invoice-collection-settings.espejo.ts</code> · 11 columnas</summary>

| Columna | Tipo Postgres | Nulo | Default | Comentario |
|---|---|---|---|---|
| `id` 🔑 | uuid | no | gen_random_uuid() |  |
| `holding_id` | uuid | no | — |  |
| `dunning_enabled` | boolean | no | true |  |
| `email_from` | text | sí | — |  |
| `bcc` | text | sí | — |  |
| `reminder_days_before` | integer[] | no | '{7,3,1}'::integer[] |  |
| `reminder_days_after` | integer[] | no | '{1,7,15}'::integer[] |  |
| `email_subject_template` | text | no | 'Recordatorio de pago factura {{invoice_number}}'::text |  |
| `email_body_template` | text | no | 'Estimado {{client_name}},\n\nLe recordamos que la factura {{invoice_number}} por {{amount_due}} vence el {{due_date}}.\n\nSaludos,\n{{company_name}}'::text |  |
| `created_at` | timestamp with time zone | no | now() |  |
| `updated_at` | timestamp with time zone | no | now() |  |

</details>
<details><summary><code>invoice_collection_logs</code> → <code>invoice-collection-log.espejo.ts</code> · 11 columnas</summary>

| Columna | Tipo Postgres | Nulo | Default | Comentario |
|---|---|---|---|---|
| `id` 🔑 | uuid | no | gen_random_uuid() |  |
| `invoice_id` | uuid | no | — |  |
| `holding_id` | uuid | no | — |  |
| `recipients` | text[] | no | — |  |
| `subject` | text | sí | — |  |
| `message` | text | sí | — |  |
| `channel` | text | no | 'email'::text |  |
| `status` | text | no | 'sent'::text |  |
| `sent_by` | uuid | sí | — |  |
| `sent_at` | timestamp with time zone | no | now() |  |
| `metadata` | jsonb | no | '{}'::jsonb |  |

</details>
<details><summary><code>invoice_trigger_debug_logs</code> → <code>invoice-trigger-debug-log.espejo.ts</code> · 10 columnas</summary>

| Columna | Tipo Postgres | Nulo | Default | Comentario |
|---|---|---|---|---|
| `id` 🔑 | uuid | no | gen_random_uuid() |  |
| `trigger_name` | text | no | — |  |
| `operation` | text | no | — |  |
| `holding_id` | uuid | sí | — |  |
| `odoo_id` | text | sí | — |  |
| `raw_data_sample` | jsonb | sí | — |  |
| `processing_status` | text | sí | — |  |
| `integration_notes` | text | sí | — |  |
| `error_message` | text | sí | — |  |
| `created_at` | timestamp with time zone | sí | now() |  |

</details>
<details><summary><code>overdue_check_log</code> → <code>overdue-check-log.espejo.ts</code> · 10 columnas</summary>

| Columna | Tipo Postgres | Nulo | Default | Comentario |
|---|---|---|---|---|
| `id` 🔑 | uuid | no | gen_random_uuid() |  |
| `check_date` | date | no | — |  |
| `invoices_found` | integer | no | 0 |  |
| `invoices_updated` | integer | no | 0 |  |
| `holdings_affected` | uuid[] | sí | ARRAY[]::uuid[] |  |
| `execution_time_ms` | integer | sí | — |  |
| `status` | text | no | — |  |
| `error_message` | text | sí | — |  |
| `created_at` | timestamp with time zone | no | now() |  |
| `holding_id` | uuid | sí | — | ID del holding. NULL indica ejecución global del sistema que afecta múltiples holdings. |

</details>
<details><summary><code>period_guard_warnings</code> → <code>period-guard-warning.espejo.ts</code> · 13 columnas</summary>

| Columna | Tipo Postgres | Nulo | Default | Comentario |
|---|---|---|---|---|
| `id` 🔑 | uuid | no | gen_random_uuid() |  |
| `occurred_at` | timestamp with time zone | no | now() |  |
| `triggered_by` | uuid | sí | — |  |
| `table_name` | text | no | — |  |
| `operation` | text | no | — |  |
| `contract_id` | uuid | sí | — |  |
| `contract_item_id` | uuid | sí | — |  |
| `holding_id` | uuid | sí | — |  |
| `company_id` | uuid | sí | — |  |
| `cutoff_date` | date | sí | — |  |
| `fields_changed` | text[] | sí | — |  |
| `message` | text | no | — |  |
| `payload` | jsonb | sí | — |  |

</details>

## Verificación (sin conexión a la DB)

- `facturacion.entities.spec.ts`: metadata TypeORM en memoria vs `facturacion.prod-snapshot.ts` — columnas + nullabilidad, PK, FKs (tabla y ON DELETE), UNIQUE, CHECK e índices declarables — y que ningún espejo duplica una tabla de `scripts/espejo/existing-entities.json`.
- `../../database.module.spec.ts`: `synchronize: false`, nadie habilita sincronización, ningún `.entity.ts` dentro de `entities/<modulo>/`.
