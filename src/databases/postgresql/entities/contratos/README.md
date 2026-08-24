# Módulo 5 · Contratos — 17 tablas de prod (2026-08-22)

> Convención y reglas: `../README.md`. Rarezas verificadas: `../NOTAS-ESPEJO.md`. Veredictos de producto: `docs/v2-rediseno/04-spec-modelo-dominio-v2/00-tablas-por-modulo.md` (no aplican en este paso).
> Origen de TODO lo que está en esta carpeta: lectura en vivo de prod `hklompkypzqtglprfobu` vía MCP de Supabase el 2026-08-22 — `list_tables verbose` + `execute_sql` de solo lectura sobre `pg_catalog` (`scripts/espejo/snapshots/contratos.{pgmeta,catalog}.json`); metadata real de las entities existentes en `contratos.existing.json` (`scripts/espejo/extract-existing-metadata.ts`). Generado con `scripts/espejo/generate-espejo.py`.

## A · Tablas que YA tenían entity en el repo (1) — no se tocaron ni se duplicaron

Estas entities están **prendidas en producción** exactamente como estaban (`database.module.ts` las carga por el glob `src/**/*.entity.ts` y sus módulos las registran en `forFeature`). "Estado vs prod" = diff entre lo que la entity declara hoy (metadata TypeORM real) y la DB en vivo; es el insumo para completarlas en el paso 3 con Leon.

| Tabla (filas) | Entity existente (archivo · clase) | Estado vs prod | Columnas que faltan en la entity | Columnas que sobran | Diferencias en columnas existentes | Constraints / índices / FKs que la entity no declara |
|---|---|---|---|---|---|---|
| `contracts` (661) | `src/modules/invoices/entities/contract.entity.ts` · `Contract` | ⚠️ difiere de prod | — | — | `created_at`: NOT NULL en la entity vs nullable en DB<br>`fx_invoice_policy`: default `None` vs DB `'spot'::text` | nombre de PK `contracts_pkey`<br>CHECK `contracts_fx_company_policy_check`<br>CHECK `contracts_fx_invoice_policy_check`<br>CHECK `contracts_legacy_status_check`<br>CHECK `contracts_status_check`<br>FK `contracts_churn_reason_id_fkey` → churn_reasons<br>FK `contracts_client_entity_id_fkey` → client_entities<br>FK `contracts_renewed_to_contract_id_fkey` → contracts<br>FK `contracts_client_id_fkey` → clients<br>FK `contracts_company_id_fkey` → companies<br>FK `contracts_quote_id_fkey` → quotes<br>FK `contracts_renewed_from_contract_id_fkey` → contracts<br>FK `contracts_current_step_id_fkey` → workflow_steps<br>FK `fk_contracts_holding_id` → company_holdings ON DELETE CASCADE<br>índice `idx_contracts_auto_invoice` (parcial)<br>índice `idx_contracts_auto_send_to_odoo` (parcial)<br>índice `idx_contracts_booking_date`<br>índice `idx_contracts_client_entity_id`<br>índice `idx_contracts_currency`<br>índice `idx_contracts_current_step_id`<br>índice `idx_contracts_holding_id`<br>índice `idx_contracts_sf_opp` (parcial)<br>índice `idx_contracts_workflow_started_at`<br>índice con expresión `idx_contracts_custom_fields` |

## B · Tablas SIN entity → espejos creados (16), APAGADOS

| Tabla (filas, RLS) | Espejo · clase | Cols | PK | UNIQUE | CHECK | FKs (→ tabla, ON DELETE) | Índices | Triggers | Policies |
|---|---|---|---|---|---|---|---|---|---|
| `contract_items` (1087, RLS on) | `contract-item.espejo.ts` · `ContractItem` | 40 | `contract_items_pkey` (id) | — | `chk_contract_items_price_entry_mode`, `contract_items_billing_frequency_check`, `contract_items_billing_method_check`, `contract_items_categoria_check`, `contract_items_discount_type_check` | `fk_contract_items_holding_id` → company_holdings (CASCADE)<br>`contract_items_renewed_by_item_id_fkey` → contract_items<br>`contract_items_renews_item_id_fkey` → contract_items<br>`contract_items_contract_id_fkey` → contracts (CASCADE)<br>`contract_items_product_id_fkey` → products<br>`contract_items_quote_item_id_fkey` → quote_items<br>`contract_items_related_item_id_fkey` → contract_items (SET NULL) | `idx_contract_items_auto_renew_end_date` (parcial), `idx_contract_items_categoria`, `idx_contract_items_churn_date` (parcial), `idx_contract_items_contract_end_date`, `idx_contract_items_holding_id`, `idx_contract_items_monthly_price` (parcial), `idx_contract_items_quote_item_id`, `idx_contract_items_quote_item_number` (parcial), `idx_contract_items_recurring_dates` (parcial), `idx_contract_items_related` (parcial), `idx_contract_items_custom_fields` (expresión, no declarado) | trg_00_period_guard_contract_items · BEFORE INSERT OR DELETE OR UPDATE FOR EACH ROW → trg_period_guard_contract_items()<br>trg_audit_contract_item_changes · AFTER INSERT OR DELETE OR UPDATE FOR EACH ROW → trg_audit_contract_item_changes()<br>trg_calculate_contract_categoria · BEFORE INSERT FOR EACH ROW → trg_set_contract_item_categoria()<br>trg_contract_items_calculate_pricing · BEFORE INSERT OR UPDATE OF unit_price, quantity, billing_frequency, is_recurring, final_price, term_months, discount_type, discount_value, annual_unit_price, price_entry_mode FOR EACH ROW → auto_calculate_pricing_fields()<br>trg_inherit_auto_renew_from_quote_item · BEFORE INSERT FOR EACH ROW → inherit_auto_renew_from_quote_item()<br>trg_rsm_on_contract_item_change · AFTER INSERT OR UPDATE FOR EACH ROW → trigger_rsm_on_contract_item_change()<br>trg_set_contract_item_end_date · BEFORE INSERT OR UPDATE OF start_date, term_months FOR EACH ROW → set_contract_item_end_date()<br>trg_z_fix_renewal_annual · BEFORE INSERT FOR EACH ROW → fix_renewal_annual_fields() [WHEN ((new.categoria = 'RENEWAL'::text) AND (new.renews_item_id IS NOT NULL))]<br>trg_zzz_pending_renewal_on_item_change · AFTER INSERT OR UPDATE FOR EACH ROW → trigger_pending_renewal_on_item_change()<br>trigger_update_contract_term · AFTER INSERT OR DELETE OR UPDATE FOR EACH ROW → update_contract_term()<br>validate_contract_item_currency_trigger · BEFORE INSERT OR UPDATE FOR EACH ROW → validate_contract_item_currency_consistency() | 5 |
| `contract_amendments` (56, RLS on) | `contract-amendment.espejo.ts` · `ContractAmendment` | 12 | `contract_amendments_pkey` (id) | — | — | `contract_amendments_contract_id_fkey` → contracts (CASCADE)<br>`contract_amendments_holding_id_fkey` → company_holdings (RESTRICT) | `idx_contract_amendments_contract`, `idx_contract_amendments_holding`, `idx_contract_amendments_status`, `idx_contract_amendments_contract_date` (expresión, no declarado) | trg_set_amendment_holding · BEFORE INSERT FOR EACH ROW → set_contract_amendment_holding_id() | 3 |
| `contract_amendment_items` (35, RLS on) | `contract-amendment-item.espejo.ts` · `ContractAmendmentItem` | 13 | `contract_amendment_items_pkey` (id) | — | — | `contract_amendment_items_amendment_id_fkey` → contract_amendments (CASCADE)<br>`contract_amendment_items_original_item_id_fkey` → contract_items<br>`contract_amendment_items_holding_id_fkey` → company_holdings (RESTRICT)<br>`contract_amendment_items_new_item_id_fkey` → contract_items | `idx_amendment_items_amendment`, `idx_amendment_items_holding`, `idx_amendment_items_new`, `idx_amendment_items_original` | trg_set_amendment_item_holding · BEFORE INSERT FOR EACH ROW → set_contract_amendment_item_holding_id() | 3 |
| `contract_lifecycle_events` (176, RLS on) | `contract-lifecycle-event.espejo.ts` · `ContractLifecycleEvent` | 24 | `contract_lifecycle_events_pkey` (id) | — | — | `contract_lifecycle_events_holding_id_fkey` → company_holdings (RESTRICT)<br>`contract_lifecycle_events_contract_id_fkey` → contracts (CASCADE) | `idx_contract_lifecycle_events_contract_id`, `idx_contract_lifecycle_events_holding_id`, `idx_contract_lifecycle_events_contract_date` (expresión, no declarado), `idx_contract_lifecycle_events_contract_effective` (expresión, no declarado) | set_updated_at_on_contract_lifecycle_events · BEFORE UPDATE FOR EACH ROW → update_contract_lifecycle_events_updated_at()<br>trg_lifecycle_events_update_updated_at · BEFORE UPDATE FOR EACH ROW → update_contract_lifecycle_events_updated_at()<br>trg_set_lifecycle_event_holding_id_ins · BEFORE INSERT FOR EACH ROW → set_lifecycle_event_holding_id()<br>trg_set_lifecycle_event_holding_id_upd · BEFORE UPDATE OF contract_id FOR EACH ROW → set_lifecycle_event_holding_id()<br>update_contract_lifecycle_events_updated_at · BEFORE UPDATE FOR EACH ROW → update_contract_lifecycle_events_updated_at() | 3 |
| `contract_change_log` (913, RLS on) | `contract-change-log.espejo.ts` · `ContractChangeLog` | 14 | `contract_change_log_pkey` (id) | — | `contract_change_log_change_type_check` | `contract_change_log_changed_by_fkey` → users (SET NULL) | `idx_ccl_changed_by` (expresión, no declarado), `idx_ccl_company` (expresión, no declarado), `idx_ccl_contract` (expresión, no declarado) | — | 1 |
| `contract_item_change_log` (1154, RLS on) | `contract-item-change-log.espejo.ts` · `ContractItemChangeLog` | 15 | `contract_item_change_log_pkey` (id) | — | `contract_item_change_log_change_type_check` | `contract_item_change_log_changed_by_fkey` → users (SET NULL) | `idx_cicl_changed_by` (expresión, no declarado), `idx_cicl_company` (expresión, no declarado), `idx_cicl_contract` (expresión, no declarado), `idx_cicl_item` (expresión, no declarado) | — | 1 |
| `contract_workflow_history` (1004, RLS on) | `contract-workflow-history.espejo.ts` · `ContractWorkflowHistory` | 12 | `contract_workflow_history_pkey` (id) | — | `contract_workflow_history_transition_type_check` | `contract_workflow_history_previous_step_id_fkey` → workflow_steps | `idx_contract_workflow_history_contract_id`, `idx_contract_workflow_history_created_at`, `idx_contract_workflow_history_step_id`, `idx_contract_workflow_history_user_id` | — | 3 |
| `workflow_steps` (17, RLS on) | `workflow-step.espejo.ts` · `WorkflowStep` | 13 | `workflow_steps_pkey` (id) | — | — | — | `idx_workflow_steps_holding_id`, `idx_workflow_steps_order` | update_workflow_steps_updated_at · BEFORE UPDATE FOR EACH ROW → update_workflow_steps_updated_at() | 4 |
| `workflow_step_documents` (0, RLS on) | `workflow-step-document.espejo.ts` · `WorkflowStepDocument` | 10 | `workflow_step_documents_pkey` (id) | — | — | `fk_wsd_contract` → contracts (CASCADE)<br>`workflow_step_documents_uploaded_by_fkey` → users<br>`fk_wsd_uploaded_by` → users (SET NULL)<br>`fk_wsd_holding` → company_holdings (RESTRICT)<br>`workflow_step_documents_workflow_step_id_fkey` → workflow_steps (CASCADE)<br>`workflow_step_documents_contract_id_fkey` → contracts (CASCADE)<br>`workflow_step_documents_holding_id_fkey` → company_holdings (RESTRICT)<br>`fk_wsd_step` → workflow_steps (SET NULL) | `idx_wsd_contract`, `idx_wsd_holding`, `idx_wsd_step`, `idx_wsd_uploaded_at` (expresión, no declarado) | — | 4 |
| `contract_clauses` (18, RLS on) | `contract-claus.espejo.ts` · `ContractClaus` | 7 | `contract_clauses_pkey` (id) | — | — | `fk_contract_clauses_holding_id` → company_holdings (CASCADE)<br>`contract_clauses_company_id_fkey` → companies | `idx_contract_clauses_holding_id` | — | 4 |
| `contract_templates` (0, RLS on) | `contract-template.espejo.ts` · `ContractTemplate` | 6 | `contract_templates_pkey` (id) | — | — | `contract_templates_company_id_fkey` → companies<br>`fk_contract_templates_holding_id` → company_holdings (CASCADE) | `idx_contract_templates_holding_id` | — | 4 |
| `contract_documents` (2, RLS on) | `contract-document.espejo.ts` · `ContractDocument` | 11 | `contract_documents_pkey` (id) | — | — | `contract_documents_contract_id_fkey` → contracts (CASCADE)<br>`contract_documents_holding_id_fkey` → company_holdings (CASCADE)<br>`contract_documents_uploaded_by_fkey` → users | `idx_contract_documents_contract_id`, `idx_contract_documents_holding_id` | — | 4 |
| `contract_notifications` (13, RLS on) | `contract-notification.espejo.ts` · `ContractNotification` | 10 | `contract_notifications_pkey` (id) | — | `contract_notifications_notification_type_check` | `contract_notifications_user_id_fkey` → users<br>`contract_notifications_contract_id_fkey` → contracts (CASCADE)<br>`contract_notifications_holding_id_fkey` → company_holdings | `idx_contract_notifications_contract_id`, `idx_contract_notifications_created_at`, `idx_contract_notifications_is_read`, `idx_contract_notifications_user_id` | — | 3 |
| `contract_billing_splits` (0, RLS on) | `contract-billing-split.espejo.ts` · `ContractBillingSplit` | 11 | `contract_billing_splits_pkey` (id) | — | `contract_billing_splits_percent_allocation_check`, `valid_date_range` | `contract_billing_splits_billing_company_id_fkey` → companies<br>`contract_billing_splits_holding_id_fkey` → company_holdings<br>`contract_billing_splits_contract_id_fkey` → contracts (CASCADE) | `idx_billing_splits_company`, `idx_billing_splits_contract`, `idx_billing_splits_dates` | — | 4 |
| `contract_invoices` (4922, RLS on) | `contract-invoice.espejo.ts` · `ContractInvoice` | 17 | `contract_invoices_pkey` (id) | — | — | `fk_contract_invoices_holding_id` → company_holdings (CASCADE)<br>`fk_contract_invoices_contract_id` → contracts (CASCADE)<br>`contract_invoices_satisfied_by_legacy_id_fkey` → invoices_legacy (SET NULL) | `idx_contract_invoices_contract_id`, `idx_contract_invoices_date`, `idx_contract_invoices_holding_id`, `idx_contract_invoices_status` | — | 5 |
| `churn_reasons` (15, RLS on) | `churn-reason.espejo.ts` · `ChurnReason` | 6 | `churn_reasons_pkey` (id) | `churn_reasons_holding_id_name_key` | — | — | `idx_churn_reasons_active`, `idx_churn_reasons_holding` | churn_reasons_set_updated_at · BEFORE UPDATE FOR EACH ROW → set_updated_at() | 4 |

Cada espejo contiene, leído en vivo: columnas con tipo real (`timestamp with/without time zone`, `varchar` + `length`, `numeric` + `precision/scale`, enums de Postgres con sus valores, `text[]`, `jsonb`, `uuid`…), nullable, default y comentario; PK con nombre (`primaryKeyConstraintName`); `@Unique`/`@Check`/`@Index` con nombre real (índices parciales con `where`; los índices con expresión, orden u otro método se documentan en el JSDoc pero no se declaran porque `@Index` no los representa); una relación `@ManyToOne` por FK con `onDelete` real y `foreignKeyConstraintName` — hacia la entity existente (`@/modules/...`) si la tabla destino ya la tiene, o hacia el espejo de su módulo; cabecera JSDoc con filas, RLS, comentario de tabla, tablas que la referencian, triggers y policies (nombre, comando, roles). Las expresiones `USING`/`WITH CHECK` de las policies quedan en `scripts/espejo/snapshots/contratos.catalog.json` (`policies_detail`) para el paso 4.

**Cómo están apagados (código técnico)**: el archivo termina en `.espejo.ts`, no en `.entity.ts`. `database.module.ts` carga entities con `entities: [__dirname + '/../../**/*.entity{.ts,.js}']`, así que no los ve, y ningún módulo los incluye en `TypeOrmModule.forFeature([...])`. `database.module.spec.ts` falla si aparece un `.entity.ts` dentro de `entities/<modulo>/`. Para encenderlos en el paso 3: renombrar a `.entity.ts` y registrarlos en el `forFeature` del módulo que los use.

## C · Columnas exactas de cada espejo (16 tablas)

<details><summary><code>contract_items</code> → <code>contract-item.espejo.ts</code> · 40 columnas</summary>

| Columna | Tipo Postgres | Nulo | Default | Comentario |
|---|---|---|---|---|
| `id` 🔑 | uuid | no | gen_random_uuid() |  |
| `contract_id` | uuid | sí | — |  |
| `product_id` | uuid | sí | — |  |
| `product_name` | text | no | — |  |
| `term_months` | integer | sí | — |  |
| `currency` | text | sí | — |  |
| `price` | numeric | sí | — |  |
| `discount_type` | text | sí | — |  |
| `discount_value` | numeric | sí | — |  |
| `final_price` | numeric | sí | — |  |
| `billing_method` | text | sí | — |  |
| `billing_frequency` | text | sí | — |  |
| `start_date` | date | sí | — | Fecha de inicio para la prestación del servicio/producto y devengo de ingresos |
| `quote_item_id` | uuid | sí | — |  |
| `holding_id` | uuid | no | gen_random_uuid() |  |
| `end_date` | date | sí | — |  |
| `renews_item_id` | uuid | sí | — |  |
| `renewed_by_item_id` | uuid | sí | — |  |
| `is_recurring` | boolean | no | true |  |
| `categoria` | text | sí | — | Categoría del item: NEW (logo nuevo), REACTIVATION (cliente vuelve), UPSELL (expansión), DOWNSELL (contracción), CHURN (cancelación), RENEWAL (renovación), RECURRENT (legacy/base) |
| `related_item_id` | uuid | sí | — | Referencia al item original (para items negativos de DOWNSELL/CHURN) |
| `item_type` | varchar(64) | sí | — | Categorización libre del item (ej: Licencias, Servicios, Hardware) |
| `unit_of_measure` | varchar(32) | sí | — | Unidad de medida del producto/servicio (UND, PERIODOS, etc.) |
| `unit_price` | numeric(18,6) | sí | — | Precio unitario base (opcional). Si existe, price = unit_price × quantity × term_months |
| `quantity` | numeric(18,6) | sí | — | Cantidad del producto/servicio en el contrato |
| `account` | varchar(128) | sí | — | Código de cuenta contable (texto libre, opcional) |
| `custom_fields` | jsonb | sí | '{}'::jsonb | Campos personalizados definidos por el usuario en formato JSONB |
| `churn_date` | date | sí | — | Fecha efectiva de churn para este item. Si existe, tiene prioridad sobre end_date para cálculos. |
| `churn_monthly_amount` | numeric(18,2) | sí | — | Monto mensual que se pierde por el churn. Calculado como final_price / term_months. |
| `monthly_price` | numeric(18,2) | sí | — | Precio mensual del item (final_price para recurrentes). INCLUYE descuentos aplicados. Usado para cálculo de MRR. |
| `billing_period_price` | numeric(18,2) | sí | — | Precio por periodo de facturación. Para recurrentes: monthly_price × frequency_multiplier. Para one-times: (final_price/term_months) × frequency_multiplier. Usado para validar invoice_items. |
| `auto_renew` | boolean | no | false | Indica si este item debe renovarse automáticamente al vencer |
| `auto_renew_term_months` | integer | sí | — | Término en meses para la renovación automática. Si es NULL, usa el mismo term_months del item original |
| `auto_renewed_at` | timestamp with time zone | sí | — | Timestamp de cuándo se ejecutó la última renovación automática |
| `quote_item_number` | text | sí | — | Número de línea de cotización (quote_items.quote_item_number). En el DWH se  conoce como salesforce_quote_lineitem_id. Permite resolver contract_item_id  desde quantities cuando el DWH no provee el ID de Sapira directamente. |
| `annual_unit_price` | numeric(18,6) | sí | — | Precio unitario anual. Fuente de verdad cuando price_entry_mode = annual. Derivado (unit_price * 12) cuando mode = monthly. |
| `annual_price` | numeric(18,2) | sí | — | Subtotal anual = annual_unit_price * quantity. Usado para totales anuales sin redondeo. |
| `price_entry_mode` | text | sí | 'monthly'::text | Indica cual campo es fuente de verdad: monthly (unit_price) o annual (annual_unit_price). Default: monthly. |
| `booking_date` | date | sí | — | Fecha de booking del item. Desde cuando el CMRR se registra en RSM. Si NULL, usa start_date. |
| `renewal_base_unit_price` | numeric | sí | — | Precio unitario efectivo ANTES de la renovación (mismo price_entry_mode y escala que unit_price). Solo poblado en items con categoria=RENEWAL cuando la renovación cambió el precio. Usado por apply_renewal_price_split() al final de revenue_schedule_rebuild_contract_ccy para emitir filas RSM RENEWAL (precio base) + UPSELL/DOWNSELL (delta) en el mes efectivo, solo en columnas *_contract_ccy. revenue_schedule_apply_fx_for_contract completa system/company. |

</details>
<details><summary><code>contract_amendments</code> → <code>contract-amendment.espejo.ts</code> · 12 columnas</summary>

| Columna | Tipo Postgres | Nulo | Default | Comentario |
|---|---|---|---|---|
| `id` 🔑 | uuid | no | gen_random_uuid() |  |
| `holding_id` | uuid | no | — |  |
| `contract_id` | uuid | no | — |  |
| `type` | contract_amendment_type (enum: RENEWAL, UPSELL, CROSS_SELL, DOWNSELL, CHURN) | no | — |  |
| `reason` | text | sí | — |  |
| `effective_date` | date | no | — |  |
| `status` | text | no | 'Pending'::text |  |
| `requested_by` | uuid | sí | — |  |
| `approved_by` | uuid | sí | — |  |
| `approval_required` | boolean | no | true |  |
| `metadata` | jsonb | sí | '{}'::jsonb |  |
| `created_at` | timestamp with time zone | no | now() |  |

</details>
<details><summary><code>contract_amendment_items</code> → <code>contract-amendment-item.espejo.ts</code> · 13 columnas</summary>

| Columna | Tipo Postgres | Nulo | Default | Comentario |
|---|---|---|---|---|
| `id` 🔑 | uuid | no | gen_random_uuid() |  |
| `holding_id` | uuid | no | — |  |
| `amendment_id` | uuid | no | — |  |
| `original_item_id` | uuid | sí | — |  |
| `new_item_id` | uuid | sí | — |  |
| `scope` | amendment_scope_type (enum: permanent, one_time) | sí | — |  |
| `quantity_delta` | numeric | sí | — |  |
| `price_delta` | numeric | sí | — |  |
| `start_date_override` | date | sí | — |  |
| `end_date_override` | date | sí | — |  |
| `notes` | text | sí | — |  |
| `item_metadata` | jsonb | sí | '{}'::jsonb |  |
| `created_at` | timestamp with time zone | no | now() |  |

</details>
<details><summary><code>contract_lifecycle_events</code> → <code>contract-lifecycle-event.espejo.ts</code> · 24 columnas</summary>

| Columna | Tipo Postgres | Nulo | Default | Comentario |
|---|---|---|---|---|
| `id` 🔑 | uuid | no | gen_random_uuid() |  |
| `contract_id` | uuid | no | — |  |
| `event_type` | text | no | — |  |
| `event_status` | text | no | 'pending'::text |  |
| `title` | text | no | — |  |
| `description` | text | sí | — |  |
| `created_by` | uuid | no | — |  |
| `approved_by` | uuid | sí | — |  |
| `client_approval_required` | boolean | sí | false |  |
| `client_approved_at` | timestamp with time zone | sí | — |  |
| `client_approved_by` | text | sí | — |  |
| `internal_approval_required` | boolean | sí | false |  |
| `internal_approved_at` | timestamp with time zone | sí | — |  |
| `internal_approved_by` | uuid | sí | — |  |
| `completed_at` | timestamp with time zone | sí | — |  |
| `metadata` | jsonb | sí | '{}'::jsonb |  |
| `holding_id` | uuid | no | — |  |
| `created_at` | timestamp with time zone | no | now() |  |
| `updated_at` | timestamp with time zone | no | now() |  |
| `effective_date` | date | sí | — |  |
| `amount_delta` | numeric | sí | — |  |
| `summary` | text | sí | — |  |
| `items_affected` | jsonb | sí | — |  |
| `event_subtype` | text | sí | — |  |

</details>
<details><summary><code>contract_change_log</code> → <code>contract-change-log.espejo.ts</code> · 14 columnas</summary>

| Columna | Tipo Postgres | Nulo | Default | Comentario |
|---|---|---|---|---|
| `id` 🔑 | uuid | no | gen_random_uuid() |  |
| `contract_id` | uuid | no | — |  |
| `company_id` | uuid | no | — |  |
| `holding_id` | uuid | no | — |  |
| `changed_at` | timestamp with time zone | no | now() |  |
| `changed_by` | uuid | sí | — |  |
| `changed_by_name` | text | sí | — |  |
| `changed_by_email` | text | sí | — |  |
| `change_type` | text | no | — |  |
| `fields_changed` | text[] | sí | — |  |
| `before_values` | jsonb | sí | — |  |
| `after_values` | jsonb | sí | — |  |
| `reason` | text | sí | — |  |
| `source` | text | sí | — |  |

</details>
<details><summary><code>contract_item_change_log</code> → <code>contract-item-change-log.espejo.ts</code> · 15 columnas</summary>

| Columna | Tipo Postgres | Nulo | Default | Comentario |
|---|---|---|---|---|
| `id` 🔑 | uuid | no | gen_random_uuid() |  |
| `contract_item_id` | uuid | no | — |  |
| `contract_id` | uuid | no | — |  |
| `company_id` | uuid | no | — |  |
| `holding_id` | uuid | no | — |  |
| `changed_at` | timestamp with time zone | no | now() |  |
| `changed_by` | uuid | sí | — |  |
| `changed_by_name` | text | sí | — |  |
| `changed_by_email` | text | sí | — |  |
| `change_type` | text | no | — |  |
| `fields_changed` | text[] | sí | — |  |
| `before_values` | jsonb | sí | — |  |
| `after_values` | jsonb | sí | — |  |
| `reason` | text | sí | — |  |
| `source` | text | sí | — |  |

</details>
<details><summary><code>contract_workflow_history</code> → <code>contract-workflow-history.espejo.ts</code> · 12 columnas</summary>

| Columna | Tipo Postgres | Nulo | Default | Comentario |
|---|---|---|---|---|
| `id` 🔑 | uuid | no | gen_random_uuid() |  |
| `contract_id` | uuid | no | — |  |
| `workflow_step_id` | uuid | sí | — | ID del paso del workflow. Puede ser NULL para registros de activación masiva o acciones fuera del workflow normal. |
| `user_id` | uuid | sí | — |  |
| `status` | text | no | 'pending'::text |  |
| `comments` | text | sí | — |  |
| `completed_at` | timestamp with time zone | sí | — |  |
| `created_at` | timestamp with time zone | no | now() |  |
| `metadata` | jsonb | sí | '{}'::jsonb |  |
| `files_attached` | text[] | sí | — |  |
| `previous_step_id` | uuid | sí | — |  |
| `transition_type` | text | sí | 'manual'::text |  |

</details>
<details><summary><code>workflow_steps</code> → <code>workflow-step.espejo.ts</code> · 13 columnas</summary>

| Columna | Tipo Postgres | Nulo | Default | Comentario |
|---|---|---|---|---|
| `id` 🔑 | uuid | no | gen_random_uuid() |  |
| `holding_id` | uuid | no | — |  |
| `name` | text | no | — |  |
| `description` | text | sí | — |  |
| `order_index` | integer | no | — |  |
| `assigned_user_ids` | uuid[] | sí | ARRAY[]::uuid[] |  |
| `requires_manual_approval` | boolean | sí | false |  |
| `is_client_step` | boolean | sí | false |  |
| `client_email` | text | sí | — |  |
| `color` | text | sí | '#3B82F6'::text |  |
| `is_active` | boolean | sí | true |  |
| `created_at` | timestamp with time zone | no | now() |  |
| `updated_at` | timestamp with time zone | no | now() |  |

</details>
<details><summary><code>workflow_step_documents</code> → <code>workflow-step-document.espejo.ts</code> · 10 columnas</summary>

| Columna | Tipo Postgres | Nulo | Default | Comentario |
|---|---|---|---|---|
| `id` 🔑 | uuid | no | gen_random_uuid() |  |
| `workflow_step_id` | uuid | no | — |  |
| `contract_id` | uuid | no | — |  |
| `file_name` | text | no | — |  |
| `file_url` | text | no | — |  |
| `file_size` | integer | sí | — |  |
| `file_type` | text | sí | — |  |
| `uploaded_by` | uuid | sí | — |  |
| `uploaded_at` | timestamp with time zone | sí | now() |  |
| `holding_id` | uuid | no | — |  |

</details>
<details><summary><code>contract_clauses</code> → <code>contract-claus.espejo.ts</code> · 7 columnas</summary>

| Columna | Tipo Postgres | Nulo | Default | Comentario |
|---|---|---|---|---|
| `id` 🔑 | uuid | no | gen_random_uuid() |  |
| `company_id` | uuid | sí | — |  |
| `name` | text | sí | — |  |
| `category` | text | sí | — |  |
| `content` | text | sí | — |  |
| `created_at` | timestamp without time zone | sí | now() |  |
| `holding_id` | uuid | sí | — |  |

</details>
<details><summary><code>contract_templates</code> → <code>contract-template.espejo.ts</code> · 6 columnas</summary>

| Columna | Tipo Postgres | Nulo | Default | Comentario |
|---|---|---|---|---|
| `id` 🔑 | uuid | no | gen_random_uuid() |  |
| `company_id` | uuid | sí | — |  |
| `name` | text | sí | — |  |
| `file_url` | text | sí | — |  |
| `created_at` | timestamp without time zone | sí | now() |  |
| `holding_id` | uuid | sí | — |  |

</details>
<details><summary><code>contract_documents</code> → <code>contract-document.espejo.ts</code> · 11 columnas</summary>

| Columna | Tipo Postgres | Nulo | Default | Comentario |
|---|---|---|---|---|
| `id` 🔑 | uuid | no | gen_random_uuid() |  |
| `holding_id` | uuid | no | — |  |
| `contract_id` | uuid | no | — |  |
| `document_name` | text | no | — |  |
| `file_url` | text | no | — |  |
| `file_size` | bigint | sí | — |  |
| `file_type` | text | sí | — |  |
| `category` | text | sí | 'Otros'::text |  |
| `uploaded_by` | uuid | sí | — |  |
| `uploaded_at` | timestamp with time zone | sí | now() |  |
| `created_at` | timestamp with time zone | sí | now() |  |

</details>
<details><summary><code>contract_notifications</code> → <code>contract-notification.espejo.ts</code> · 10 columnas</summary>

| Columna | Tipo Postgres | Nulo | Default | Comentario |
|---|---|---|---|---|
| `id` 🔑 | uuid | no | gen_random_uuid() |  |
| `contract_id` | uuid | no | — |  |
| `user_id` | uuid | sí | — |  |
| `notification_type` | text | no | — |  |
| `title` | text | no | — |  |
| `message` | text | no | — |  |
| `is_read` | boolean | sí | false |  |
| `metadata` | jsonb | sí | '{}'::jsonb |  |
| `created_at` | timestamp with time zone | sí | now() |  |
| `holding_id` | uuid | no | — |  |

</details>
<details><summary><code>contract_billing_splits</code> → <code>contract-billing-split.espejo.ts</code> · 11 columnas</summary>

| Columna | Tipo Postgres | Nulo | Default | Comentario |
|---|---|---|---|---|
| `id` 🔑 | uuid | no | gen_random_uuid() |  |
| `holding_id` | uuid | no | — |  |
| `contract_id` | uuid | no | — |  |
| `billing_company_id` | uuid | no | — |  |
| `billing_currency` | text | no | — |  |
| `percent_allocation` | numeric | no | — |  |
| `effective_from` | date | no | — |  |
| `effective_to` | date | sí | — |  |
| `notes` | text | sí | — |  |
| `created_at` | timestamp with time zone | sí | now() |  |
| `updated_at` | timestamp with time zone | sí | now() |  |

</details>
<details><summary><code>contract_invoices</code> → <code>contract-invoice.espejo.ts</code> · 17 columnas</summary>

| Columna | Tipo Postgres | Nulo | Default | Comentario |
|---|---|---|---|---|
| `id` 🔑 | uuid | no | gen_random_uuid() |  |
| `contract_id` | uuid | no | — |  |
| `invoice_date` | date | no | — |  |
| `amount` | numeric | no | — |  |
| `currency` | text | no | — |  |
| `status` | text | no | 'Programada'::text |  |
| `contract_items` | jsonb | no | '[]'::jsonb |  |
| `contract_item_details` | jsonb | no | '[]'::jsonb |  |
| `is_editable` | boolean | no | true |  |
| `created_at` | timestamp with time zone | no | now() |  |
| `updated_at` | timestamp with time zone | no | now() |  |
| `holding_id` | uuid | no | gen_random_uuid() |  |
| `invoice_currency` | text | sí | — | Moneda de emisión de la factura (puede diferir de currency que es moneda del contrato) |
| `fx_policy` | text | sí | — | Política FX: fixed (tipo cambio fijo) o spot (tipo cambio del día de emisión) |
| `fx_contract_to_invoice` | numeric | sí | — | Tipo de cambio fijo cuando fx_policy = fixed |
| `satisfied_by_legacy_id` | uuid | sí | — | Factura legacy que satisfizo esta factura programada |
| `is_satisfied` | boolean | sí | false | Indica si la factura programada ya fue cubierta por legacy |

</details>
<details><summary><code>churn_reasons</code> → <code>churn-reason.espejo.ts</code> · 6 columnas</summary>

| Columna | Tipo Postgres | Nulo | Default | Comentario |
|---|---|---|---|---|
| `id` 🔑 | uuid | no | gen_random_uuid() |  |
| `holding_id` | uuid | no | — |  |
| `name` | text | no | — |  |
| `is_active` | boolean | no | true |  |
| `created_at` | timestamp with time zone | no | now() |  |
| `updated_at` | timestamp with time zone | no | now() |  |

</details>

## Verificación (sin conexión a la DB)

- `contratos.entities.spec.ts`: metadata TypeORM en memoria vs `contratos.prod-snapshot.ts` — columnas + nullabilidad, PK, FKs (tabla y ON DELETE), UNIQUE, CHECK e índices declarables — y que ningún espejo duplica una tabla de `scripts/espejo/existing-entities.json`.
- `../../database.module.spec.ts`: `synchronize: false`, nadie habilita sincronización, ningún `.entity.ts` dentro de `entities/<modulo>/`.
