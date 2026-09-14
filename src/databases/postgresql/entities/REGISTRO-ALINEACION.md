# REGISTRO-ALINEACION — entities que se alinean contra producción

> Estado del paso E3: llevar cada entity a reflejar exactamente su tabla en producción,
> hasta que `yarn schema:log` no emita nada. Mientras emita algo, la entity **no** es todavía
> la definición de la tabla.

> Medición base: 2026-09-09, **1102 sentencias** de deriva · **343 al día de hoy** con los 130 entities cargados
> (`TYPEORM_LOAD_MIRROR_ENTITIES=true yarn schema:log` contra producción).
> De esas 343, **59 vienen de entities activas y 284 de espejos inertes**.

> ⚠️ **Corrección de método (2026-09-13).** Hasta esta fecha las cifras por tabla se calculaban
> atribuyendo cada sentencia por su `ALTER TABLE "x"`. Un `DROP INDEX "public"."idx_..."` no
> nombra la tabla, así que **218 sentencias de índices quedaron fuera de todos los conteos** y
> varias entities figuraban en "→ 0" teniendo índices sin declarar. Eran **161 índices reales de
> producción** que ninguna entity declaraba, 9 de ellos UNIQUE. Ya están declarados y
> `entities/indices-declarados.spec.ts` impide que vuelva a pasar. Las cifras de este registro
> ahora resuelven el nombre del índice contra el catálogo para atribuirlo a su tabla.

## Cómo se usa este registro

Una fila por entity con deriva. Al alinear una, se marca en **Estado** y se anota en
**Impacto** el resultado de revisar los servicios que la consumen. La columna
**Consumidores** cuenta los archivos `.ts` de `src/` que referencian la clase: es la medida
de riesgo de tocarla, y define el orden de trabajo.

Estados: `pendiente` · `alineada` · `revisada` (servicios verificados) · `bloqueada`

## Orden sugerido

De menor a mayor riesgo. Las de más deriva resultaron tener pocos consumidores, así que
el grueso del trabajo se hace antes de tocar nada crítico.

| # | Tabla | Entity | Deriva | Tipos de diferencia | Consumidores | Riesgo | Estado | Impacto |
|---|---|---|---:|---|---:|---|---|---|
| 1 | `salesforce_opportunities_cache` | `modules/salesforce/entities/salesforce-opportunity-cache.entity.ts` | 45 → **1** | columnas faltantes 17, columnas de más 17, nulabilidad 5, defaults 2, FKs 1 | 3 | bajo | **revisada** | sin impacto (ver abajo) |
| 2 | `integration_logs` | `integration-log.entity.ts` | 26 → **0** | columnas de más 11, columnas faltantes 7, FKs 4, defaults 2, nulabilidad 2 | 3 | bajo | **revisada** | sin impacto (ver abajo) |
| 3 | `exchange_rates` | `modules/banco-central/entities/exchange-rate.entity.ts` | 20 → **0** | FKs 8, columnas faltantes 5, columnas de más 5, nulabilidad 1, otros 1 | 3 | bajo | **revisada** | sin impacto (ver abajo) |
| 4 | `exchange_rates_monthly_avg` | `modules/banco-central/entities/exchange-rate-monthly-avg.entity.ts` | 14 → **0** | otros 4, columnas faltantes 3, columnas de más 3, nulabilidad 3, FKs 1 | 3 | bajo | **revisada** | sin impacto |
| 5 | `stripe_product_mappings` | `modules/stripe/entities/stripe-product-mapping.entity.ts` | 7 → **0** | FKs 4, nulabilidad 3 | 3 | bajo | **revisada** | sin impacto |
| 6 | `sii_configurations` | `modules/sii/entities/sii.entity.ts` | 7 → **0** | columnas faltantes 2, columnas de más 2, FKs 1, defaults 1, otros 1 | 3 | bajo | **revisada** | sin impacto |
| 7 | `salesforce_sync_run_items` | `modules/salesforce/entities/salesforce-sync-run-item.entity.ts` | 6 → **0** | FKs 4, otros 2 | 3 | bajo | **revisada** | sin impacto |
| 8 | `sii_certificates` | `modules/sii/entities/sii.entity.ts` | 5 → **0** | FKs 2, columnas faltantes 1, columnas de más 1, otros 1 | 3 | bajo | **revisada** | sin impacto |
| 9 | `sii_cafs` | `modules/sii/entities/sii.entity.ts` | 5 → **0** | FKs 2, columnas faltantes 1, columnas de más 1, otros 1 | 3 | bajo | **revisada** | sin impacto |
| 10 | `client_contacts` | `modules/salesforce/entities/client-contact.entity.ts` | 4 → **4** (falso positivo) | FKs 2, nulabilidad 1, defaults 1 | 3 | bajo | **revisada** | sin impacto; ver falsos positivos |
| 11 | `sapira_quantity_imports` | `sapira-quantity-import.entity.ts` | 4 → **3** (esperadas) | otros 4 | 3 | bajo | **revisada** | tabla creada en prod; 2 FKs bloqueadas por espejos + índice de expresión |
| 12 | `currencies` | `modules/banco-central/entities/currency.entity.ts` | 4 → **0** | nulabilidad 4 | 3 | bajo | **revisada** | sin impacto |
| 13 | `quote_stages` | `modules/salesforce/entities/quote-stage.entity.ts` | 3 → **0** | FKs 3 | 3 | bajo | **revisada** | sin impacto |
| 14 | `master_data` | `modules/salesforce/entities/master-data.entity.ts` | 3 → **0** | FKs 3 | 3 | bajo | **revisada** | sin impacto |
| 15 | `notification_role_subscriptions` | `modules/notifications/entities/notification-role-subscription.entity.ts` | 3 → **1** | FKs 3 | 3 | bajo | **parcial** | bloqueada: FK a `roles`, que solo existe como espejo |
| 16 | `invoice_references` | `modules/invoices/entities/invoice-reference.entity.ts` | 3 → **0** | FKs 3 | 3 | bajo | **revisada** | sin impacto; usa `AuthUser` para la FK a `auth.users` |
| 17 | `stripe_customers_bigquery` | `stripe-customer-bigquery.entity.ts` | 3 → **0** | FKs 1, nulabilidad 1, defaults 1 | 3 | bajo | **revisada** | sin impacto |
| 18 | `indicadores_economicos` | `modules/banco-central/entities/indicador-economico.entity.ts` | 3 → **0** | FKs 1, nulabilidad 1, otros 1 | 3 | bajo | **revisada** | sin impacto |
| 19 | `sellers` | `modules/salesforce/entities/seller.entity.ts` | 1 → **0** | FKs 1 | 3 | bajo | **revisada** | sin impacto |
| 20 | `generic_export_vats` | `generic-export-vat.entity.ts` | 14 → **0** | columnas de más 8, columnas faltantes 3, FKs 1, nulabilidad 1, defaults 1 | 4 | bajo | **revisada** | sin impacto: el servicio consulta con `select: ['vat']` |
| 21 | `salesforce_line_items_stg` | `modules/salesforce/entities/salesforce-line-items-stg.entity.ts` | 11 → **0** | columnas faltantes 4, columnas de más 4, FKs 3 | 4 | bajo | **revisada** | sin impacto |
| 22 | `salesforce_opportunities_stg` | `modules/salesforce/entities/salesforce-opportunities-stg.entity.ts` | 10 → **0** | columnas faltantes 4, columnas de más 4, FKs 2 | 4 | bajo | **revisada** | sin impacto |
| 23 | `salesforce_accounts_stg` | `modules/salesforce/entities/salesforce-accounts-stg.entity.ts` | 10 → **0** | columnas faltantes 4, columnas de más 4, FKs 2 | 4 | bajo | **revisada** | sin impacto |
| 24 | `salesforce_product_mappings` | `modules/salesforce/entities/salesforce-product-mapping.entity.ts` | 6 → **0** | FKs 2, columnas faltantes 2, columnas de más 2 | 4 | bajo | **revisada** | sin impacto |
| 25 | `odoo_invoices_stg` | `modules/odoo/entities/odoo-invoices-stg.entity.ts` | 6 → **2** (falso positivo) | FKs 3, nulabilidad 2, defaults 1 | 4 | bajo | **revisada** | anomalía de default documentada |
| 26 | `odoo_invoice_lines_stg` | `modules/odoo/entities/odoo-invoice-lines-stg.entity.ts` | 6 → **2** (falso positivo) | FKs 4, nulabilidad 2 | 4 | bajo | **revisada** | anomalía de default documentada |
| 27 | `salesforce_field_mappings` | `modules/salesforce/entities/salesforce-field-mapping.entity.ts` | 6 → **0** | nulabilidad 4, FKs 2 | 4 | bajo | **revisada** | sin impacto |
| 28 | `salesforce_quote_type_mappings` | `modules/salesforce/entities/salesforce-quote-type-mapping.entity.ts` | 5 → **0** | nulabilidad 3, FKs 2 | 4 | bajo | **revisada** | sin impacto |
| 29 | `app_notification_recipients` | `modules/notifications/entities/app-notification-recipient.entity.ts` | 4 → **0** | FKs 4 | 4 | bajo | **revisada** | sin impacto |
| 30 | `field_mappings` | `field-mapping.entity.ts` | 10 → **0** | FKs 5, nulabilidad 3, columnas faltantes 1, columnas de más 1 | 5 | medio | **revisada** | sin impacto |
| 31 | `odoo_partners_stg` | `modules/odoo/entities/odoo-partners-stg.entity.ts` | 9 → **0** | FKs 5, nulabilidad 2, columnas faltantes 1, columnas de más 1 | 5 | medio | **revisada** | PK corregida a `bigserial` |
| 32 | `quote_items` | `modules/salesforce/entities/quote-item.entity.ts` | 8 → **4** (falso positivo) | FKs 7, defaults 1 | 5 | medio | **revisada** | anomalía `gen_random_uuid()` en columna FK |
| 33 | `odoo_product_mappings` | `modules/odoo/entities/odoo-product-mapping.entity.ts` | 7 → **2** (falso positivo) | FKs 4, nulabilidad 3 | 5 | medio | **revisada** | sin impacto |
| 34 | `bigquery_connections` | `bigquery-connection.entity.ts` | 6 → **0** | FKs 3, nulabilidad 3 | 5 | medio | **revisada** | usa `AuthUser` para la FK a `auth.users` |
| 35 | `app_notifications` | `modules/notifications/entities/app-notification.entity.ts` | 5 → **2** (falso positivo) | FKs 3, defaults 2 | 5 | medio | **revisada** | sin impacto |
| 36 | `client_entity_clients` | `client-entity-client.entity.ts` | 5 → **0** | FKs 5 | 5 | medio | **revisada** | usa `AuthUser` para la FK a `auth.users` |
| 37 | `stripe_subscriptions_stg` | `modules/stripe/entities/stripe-subscriptions-stg.entity.ts` | 3 → **0** | nulabilidad 2, FKs 1 | 5 | medio | **revisada** | sin impacto |
| 38 | `stripe_invoices_stg` | `modules/stripe/entities/stripe-invoices-stg.entity.ts` | 3 → **0** | nulabilidad 2, FKs 1 | 5 | medio | **revisada** | sin impacto |
| 39 | `stripe_customers_stg` | `modules/stripe/entities/stripe-customers-stg.entity.ts` | 3 → **0** | nulabilidad 2, FKs 1 | 5 | medio | **revisada** | sin impacto |
| 40 | `salesforce_object_mappings` | `modules/salesforce/entities/salesforce-object-mapping.entity.ts` | 2 → **0** | FKs 2 | 5 | medio | **revisada** | sin impacto |
| 41 | `salesforce_sync_runs` | `modules/salesforce/entities/salesforce-sync-run.entity.ts` | 2 → **0** | FKs 2 | 5 | medio | **revisada** | sin impacto |
| 42 | `invoice_items` | `modules/invoices/entities/invoice-item.entity.ts` | 14 → **8** | FKs 11, nulabilidad 2, defaults 1 | 6 | medio | **parcial** | 4 FKs bloqueadas por espejos + churn de `gen_random_uuid()` |
| 43 | `quotes` | `modules/salesforce/entities/quote.entity.ts` | 6 → **0** | FKs 5, nulabilidad 1 | 7 | medio | **revisada** | sin impacto |
| 44 | `salesforce_connections` | `modules/salesforce/entities/salesforce-connection.entity.ts` | 17 → **0** | tipos 3, enum inexistente 1, default equivocado 1, índices 4, comentarios 2 | 8 | medio | **revisada** | sin impacto (ver abajo) |
| 45 | `stripe_connections` | `modules/stripe/entities/stripe-connection.entity.ts` | 3 → **0** | nulabilidad 2, FKs 1 | 8 | medio | **revisada** | sin impacto en consumidores |
| 46 | `user_holdings` | `modules/holdings/entities/user-holding.entity.ts` | 4 → **0** | FKs 3, nulabilidad 1 | 9 | medio | **revisada** | sin impacto en consumidores |
| 47 | `odoo_connections` | `modules/odoo/entities/odoo-connection.entity.ts` | 5 → **0** | FKs 3, nulabilidad 2 | 11 | medio | **revisada** | sin impacto en consumidores |
| 48 | `client_entities` | `client-entity.entity.ts` | 3 → **4** (falso positivo) | FKs 2, defaults 1 | 17 | alto | **revisada** | sin impacto en consumidores |
| 49 | `products` | `modules/odoo/entities/products.entity.ts` | 2 → **0** | FKs 1, nulabilidad 1 | 17 | alto | **revisada** | sin impacto en consumidores |
| 50 | `clients` | `client.entity.ts` | 3 → **0** | FKs 2, nulabilidad 1 | 20 | alto | **revisada** | sin impacto en consumidores |
| 51 | `contracts` | `modules/invoices/entities/contract.entity.ts` | 39 → **3** | comentarios 21, FKs 9, CHECKs 4, índices 3, nulabilidad 1, defaults 1 | 21 | alto | **revisada** | sin impacto (ver abajo) |
| 52 | `companies` | `modules/odoo/entities/companies.entity.ts` | 2 → **0** | FKs 1, nulabilidad 1 | 27 | alto | **revisada** | sin impacto en consumidores |
| 53 | `invoices` | `modules/invoices/entities/invoice.entity.ts` | 58 → **3** | comentarios 28, FKs 11, CHECKs 8, índices 8, columnas faltantes 3, nulabilidad 1 | 28 | alto | **revisada** | sin impacto (ver abajo) |
| 54 | `users` | `modules/users/entities/user.entity.ts` | 6 → **1** (FK a `roles`, bloqueada) | columnas faltantes 3, FKs 2, nulabilidad 1 | 42 | alto | **revisada** | sin impacto en consumidores |
| 56 | `stripe_sync_jobs` | `modules/stripe/entities/stripe-sync-job.entity.ts` | 6 → **1** | comentarios 5, índices 3 | 4 | bajo | **revisada** | faltaba en este registro; sin impacto |
| 55 | `company_holdings` | `modules/holdings/entities/company-holding.entity.ts` | 1 → **0** | nulabilidad 1 | 50 | alto | **revisada** | sin impacto en consumidores |

## Espejos (46 tablas, 284 sentencias)

Los `.espejo.ts` son inertes: están fuera del glob `src/**/*.entity.ts` y ningún servicio los
importa, así que **alinearlos no puede romper nada**. Se regeneran con
`scripts/espejo/generate-espejo.py`, no se editan a mano. Sus `DROP INDEX` son siempre pares
`DROP` + `CREATE` de la misma definición: el espejo sí declara el índice y TypeORM lo recrea
porque está alterando otra cosa de la misma tabla.

| Tabla | Deriva | Tipos de diferencia | Estado |
|---|---:|---|---|
| `contract_items` | 33 | comentarios 22, índices 5, FKs/CHECKs 4, otros 2 | pendiente |
| `mrr_legacy` | 25 | comentarios 19, FKs/CHECKs 6 | pendiente |
| `revenue_schedule_monthly` | 21 | comentarios 9, FKs/CHECKs 6, índices 6 | pendiente |
| `client_agent_configs` | 20 | índices 8, comentarios 6, FKs/CHECKs 6 | pendiente |
| `quantities` | 18 | comentarios 10, FKs/CHECKs 8 | pendiente |
| `custom_field_definitions` | 12 | comentarios 6, índices 4, FKs/CHECKs 2 | pendiente |
| `odoo_object_mappings` | 11 | comentarios 5, índices 4, FKs/CHECKs 2 | pendiente |
| `contract_invoices` | 11 | comentarios 5, FKs/CHECKs 4, otros 2 | pendiente |
| `holding_email_sender_settings` | 10 | comentarios 8, índices 2 | pendiente |
| `invoices_legacy` | 10 | comentarios 6, FKs/CHECKs 4 | pendiente |
| `invoice_items_legacy` | 9 | comentarios 5, índices 2, FKs/CHECKs 2 | pendiente |
| `overdue_check_log` | 8 | índices 3, comentarios 2, FKs/CHECKs 2, otros 1 | pendiente |
| `subscriptions` | 8 | comentarios 6, FKs/CHECKs 2 | pendiente |
| `salesforce_sync_logs` | 7 | comentarios 4, índices 2, otros 1 | pendiente |
| `subscription_items` | 6 | comentarios 6 | pendiente |
| `ai_runs` | 5 | índices 2, FKs/CHECKs 2, comentarios 1 | pendiente |
| `contract_item_change_log` | 5 | índices 4, comentarios 1 | pendiente |
| `email_sender_addresses` | 5 | comentarios 5 | pendiente |
| `invoice_restructure_log` | 4 | FKs/CHECKs 2, índices 2 | pendiente |
| `rag_documents` | 4 | índices 2, otros 2 | pendiente |
| `contract_change_log` | 4 | índices 3, comentarios 1 | pendiente |
| `user_view_preferences` | 4 | comentarios 4 | pendiente |
| `invoice_items_legacy_match` | 4 | comentarios 2, FKs/CHECKs 2 | pendiente |
| `client_documents` | 4 | FKs/CHECKs 2, otros 2 | pendiente |
| `accounting_period_events` | 3 | índices 2, comentarios 1 | pendiente |
| `holding_settings` | 3 | comentarios 2, otros 1 | pendiente |
| `invoice_payments` | 3 | índices 2, otros 1 | pendiente |
| `bank_upload_batches` | 2 | FKs/CHECKs 2 | pendiente |
| `bank_movements` | 2 | FKs/CHECKs 2 | pendiente |
| `contract_documents` | 2 | FKs/CHECKs 2 | pendiente |
| `contract_lifecycle_events` | 2 | índices 2 | pendiente |
| `period_guard_warnings` | 2 | índices 1, comentarios 1 | pendiente |
| `bank_column_mappings` | 2 | comentarios 2 | pendiente |
| `quote_attachments` | 2 | comentarios 2 | pendiente |
| `ai_agents` | 2 | comentarios 2 | pendiente |
| `ai_messages` | 1 | índices 1 | pendiente |
| `contract_amendments` | 1 | índices 1 | pendiente |
| `workflow_step_documents` | 1 | índices 1 | pendiente |
| `client_entity_tax_id_normalization_conflicts` | 1 | comentarios 1 | pendiente |
| `invoice_trigger_debug_logs` | 1 | comentarios 1 | pendiente |
| `fx_api_sync_log` | 1 | comentarios 1 | pendiente |
| `holding_fx_period_rates` | 1 | comentarios 1 | pendiente |
| `accounting_period_cutoff` | 1 | comentarios 1 | pendiente |
| `company_legal_documents` | 1 | otros 1 | pendiente |
| `workflow_steps` | 1 | otros 1 | pendiente |
| `contract_workflow_history` | 1 | comentarios 1 | pendiente |

## Bitácora de alineación

### 1 · `salesforce_opportunities_cache` (2026-09-09) — 45 → 1 sentencia

**Diferencias contra producción.** Los nombres de columna coincidían todos; las 17 "columnas
faltantes + 17 de más" eran en realidad **17 cambios de tipo** que TypeORM no puede hacer en sitio y
expresa como `DROP` + `ADD`:

| Diferencia | Entity decía | Producción tiene |
|---|---|---|
| 17 columnas de texto | `varchar(100/255/500)` | `text` (sin límite) |
| `amount` | `decimal(15,2) DEFAULT 0` | `numeric(15,2)`, **sin default** |
| `account_name`, `stage_name`, `close_date` | `NOT NULL` (y `account_name` con default `'Sin cuenta'`) | nullable, sin default |
| `is_won`, `is_closed`, `line_items_count`, `currency_iso_code` | `NOT NULL` con default | nullable con default |
| `sync_date` | sin default | `DEFAULT CURRENT_DATE` |
| `created_at` / `updated_at` | `timestamp` (sin zona) | `timestamptz`, nullable |
| FK `holding_id` | no declarada | `…_holding_id_fkey → company_holdings(id) ON DELETE CASCADE` |
| 5 índices | ninguno declarado | 3 declarables + 2 con `DESC` (ya en `special-index/`) |
| Comentarios | ninguno | 1 de tabla + 2 de columna |

El hallazgo con consecuencia real es el **`varchar(255)` que en producción es `text`**: cualquier
código que asuma truncado a 255 caracteres está equivocado, porque la base nunca lo impuso.

**Impacto en consumidores: ninguno.** Los 3 archivos que la referencian son `espejo.existing.ts`
(barrel de specs), `salesforce.module.ts` (registro en `forFeature`) y `salesforce-sync.service.ts`.
Dos razones por las que el cambio es inocuo:

1. `strictNullChecks` está en `false`, así que declarar `nullable: true` no cambia ningún tipo de
   TypeScript ni obliga a comprobar nulos en los consumidores.
2. `salesforce-sync.service.ts` fija explícitamente cada valor al insertar
   (`account_name: opp.Account?.Name || 'Sin cuenta'`, `amount: opp.Amount || 0`), así que nunca
   dependía de los defaults declarados en la entity. Quitarlos no cambia comportamiento.

La relación `holding?: CompanyHolding` es una propiedad nueva y opcional: no rompe los objetos que el
servicio construye.

Verificado con `yarn lint`, `tsc --noEmit` y 620 tests en verde.

### 2 · `integration_logs` (2026-09-09) — 26 → 0 sentencias

**Diferencias contra producción.** Esta entity no estaba incompleta: describía **otra tabla**.

- **Declaraba 8 columnas que no existen en producción**: `operation`, `request_data`,
  `response_data`, `error_message`, `duration_ms`, `user_id`, `external_id` y —lo más llamativo—
  `created_at`, con `@CreateDateColumn`.
- **Le faltaban 4 que sí existen**: `mapping_id`, `created_by`, `batch_id`, `result`.
- `integration_type` era `text NOT NULL`; en producción es `varchar(100)` nullable.
- `source_table` y `target_table` eran nullable; en producción son `NOT NULL`.
- `started_at` y `completed_at` eran `timestamptz`; en producción son `timestamp` **sin zona**.
- Faltaban el `CHECK` de `status`, sus defaults (`'running'`, `'{}'::jsonb`), las 3 FKs, los 7
  índices y los comentarios de tabla y de `batch_id`.

**Por qué esto no estaba rompiendo producción.** El único consumidor real es `odoo.service.ts`, y
usa el repositorio **exclusivamente con `.query()` (SQL crudo)** —de hecho las consultas que hace
son contra `field_mappings`, no contra esta tabla—. TypeORM nunca construyó una consulta desde esta
entity, así que las 8 columnas fantasma jamás llegaron a un `SELECT`. Si alguien hubiera usado
`find()` o `save()`, habría fallado con *column does not exist*.

**Impacto en consumidores: ninguno.** Los otros archivos que parecían consumirla
(`odoo-integration-log.service.ts`, `stripe-integration-log.service.ts`) usan clases **de Mongoose**
con nombre parecido (`OdooIntegrationLog`, `StripeIntegrationLog`), no esta entity.

**Efecto colateral que hubo que reparar**: al declarar las relaciones, los 14 specs del espejo
fallaron con *Entity metadata for IntegrationLog#createdBy was not found*. Construyen la metadata
desde los barrels `espejo.index.ts` / `espejo.existing.ts`, así que toda entity nueva que sea destino
de una FK **tiene que exportarse desde `espejo.existing.ts`**. Anotado para las próximas.

### 3 · `exchange_rates` (2026-09-09) — 20 → 0 sentencias

**Diferencias contra producción:**

| Diferencia | Entity decía | Producción tiene |
|---|---|---|
| `from_currency`, `to_currency` | `varchar(3)` | `text` |
| **`source_type`** | `varchar(50)` **default `'BANCOCENTRAL'`** | `text NOT NULL` **default `'system'`** |
| `api_source` | `varchar(100)`, sin default | `text` con default `'system'` |
| `is_indirect_conversion` | `NOT NULL` | nullable |
| `created_at` | `timestamp` sin zona, `CURRENT_TIMESTAMP` | `timestamptz NOT NULL DEFAULT now()` |
| PK compuesta | sin nombre de constraint | `exchange_rates_pkey` |
| Índices | **declaraba un `@Index` UNIQUE que no existe en producción** (y además redundante con la PK) | 4 índices, ninguno declarado: 3 declarables + `idx_exchange_rates_lookup` con `DESC` (en `special-index/`) |
| Comentarios | ninguno | 1 de tabla + 3 de columna |

Dos cosas a destacar. La primera: el `varchar(3)` de las monedas **no lo impone la base** — es `text`.
La segunda es más sutil: la entity declaraba un índice único que **no existe en producción**, así que
una migración generada lo habría *creado*. La deriva no siempre es "falta algo": a veces la entity
inventa objetos.

**El default de `source_type` merecía revisión** porque ese campo tiene valores con significado en el
código (`'BANCOCENTRAL'`, `'PERU_API'`, `'system'`) y se filtra por ellos —
`peru-api.controller.ts:29` hace `rate.source_type === 'PERU_API'`—. Cambiarlo a `'system'` es seguro
porque `exchange-rates.service.ts` **siempre lo fija explícitamente** al guardar (líneas 185, 314,
410, 647); nunca dependió del default de la entity. El default que importaba siempre fue el de la base.

**Impacto en consumidores: ninguno.** Los 3 son `espejo.existing.ts`, `banco-central.module.ts` y
`exchange-rates.service.ts`. 545 tests en verde, incluidos los del módulo.

### Herramienta reutilizable: `auth-user.entity.ts`

**11 tablas de `public` tienen FKs contra `auth.users`** (`created_by`, `uploaded_by`,
`reconciled_by`, `user_id`…), un esquema de Supabase que no es nuestro. Sin una entity que lo
represente, TypeORM no puede declarar esas relaciones y las 11 aparecen como `DROP CONSTRAINT`.

La solución es `entities/auth-user.entity.ts` con **`@Entity({ schema: 'auth', name: 'users',
synchronize: false })`**. La clave es `synchronize: false`: TypeORM la ignora al comparar esquemas,
así que puede usarla como destino de FK sin emitir jamás DDL sobre `auth.users` —verificado, ninguna
sentencia de `schema:log` la menciona—. Sin esa opción intentaría borrar todas las columnas de
`auth.users` que no declaramos.

Al alinear cada una de las 10 tablas restantes con FK a `auth.users`, usar esta entity.

### Las FKs duplicadas sí se pueden declarar

`invoice_items.holding_id` tiene **dos** FKs en producción sobre la misma columna
(`fk_invoice_items_holding_id` con `ON DELETE CASCADE` y `invoice_items_holding_id_fkey` con
`NO ACTION`). TypeORM acepta dos `@ManyToOne` sobre el mismo `@JoinColumn` si cada uno declara su
`foreignKeyConstraintName`. Se replican ambas: el `NO ACTION` no protege nada porque el `CASCADE`
se evalúa igual, pero corregirlo es decisión de negocio. `invoices.holding_id` tiene exactamente la
misma anomalía y se resolvió igual.

### 4 · Los 161 índices sin declarar (2026-09-13) — 218 → 66 sentencias de índice

El hallazgo de método descrito arriba. Ninguna entity declaraba sus índices salvo tres, y el conteo
por tabla los ocultaba porque un `DROP INDEX` no nombra su tabla. Repartidos en 41 tablas, **todas
con entity activa y todas marcadas "revisada"**.

Nueve eran UNIQUE, así que el `DROP INDEX` no habría sido solo una pérdida de rendimiento sino de
una garantía de integridad: `idx_user_holdings_one_selected_per_user`,
`unique_odoo_integration_id_per_holding`, `idx_clients_salesforce_account_unique`,
`idx_quotes_salesforce_opportunity_unique`, `idx_quote_items_quote_item_number_unique`,
`idx_quote_items_salesforce_line_item_unique`, `idx_client_entities_odoo_partner_holding`,
`idx_sf_product_map_unique` y `app_notifications_open_deduplication_key_idx`. Ocho de los nueve son
parciales (`WHERE`), que **sí** son declarables con `@Index({ where })`.

Se declararon los 157 que seguían sin declarar tras alinear `salesforce_connections`, copiando
columnas y cláusula `WHERE` verbatim desde `pg_get_indexdef` en el catálogo. **Impacto en
consumidores: ninguno** — un `@Index` es metadata de esquema, no cambia ninguna consulta.

La guarda que faltaba es `entities/indices-declarados.spec.ts`: verifica contra el catálogo que
todo índice de producción esté declarado en una entity o exista como asset en `special-index/`, y
que no haya duplicados entre ambos. Los índices implícitos de PK y UNIQUE quedan fuera porque los
crea el constraint.

### 5 · `salesforce_connections` (2026-09-13) — 17 → 0 sentencias

Dos defectos reales, no ruido de convención:

| Diferencia | Entity decía | Producción tiene |
|---|---|---|
| `token_issued_at`, `token_expires_at`, `last_sync_at` | `timestamp` (sin zona) | `timestamptz` |
| `auth_type` | `type: 'enum'` con `default: 'password'` | `text` con `CHECK`, **default `'client_credentials'`** |
| 4 índices | ninguno declarado | `auth_type`, `holding_id`, `is_active`, `user_id` |

El enum era el más caro: TypeORM quería **crear el tipo** `salesforce_connections_auth_type_enum`,
borrar la columna, recrearla con el default equivocado y volver a poner el `CHECK`. En producción
esa columna nunca fue un enum de Postgres. Se declara como `text`; `SalesforceAuthType` sigue siendo
el tipo en TypeScript, que es lo que usan los 6 servicios del módulo.

Los tres `timestamp` habrían producido `DROP COLUMN` + `ADD` sobre los tokens vigentes.

**Impacto en consumidores: ninguno.** `salesforce-auth.service.ts:230` fija `auth_type`
explícitamente en cada alta, así que el default de la base nunca decidió nada; y los tres campos de
fecha se escriben siempre con `new Date()`.

### 6 · `invoices` (2026-09-13) — 58 → 3 sentencias

La de mayor riesgo del corpus: **tres `DROP COLUMN` sobre columnas reales** que la entity no
declaraba —`credit_type`, `credit_reason`, `nc_revenue_treatment`— junto con los tres `CHECK` que
las validan. api-sapira no las usa; **el front sí** (`InvoiceRelatedDocsSection.tsx`,
`invoiceAdvancedService.ts`), así que una migración generada habría borrado datos vivos de notas de
crédito sin que ningún test del back lo notara.

Además faltaban los 8 `CHECK` (`status`, `invoice_type`, `document_type`, `payment_method`,
`export_type` y los tres de NC), 11 FKs, 28 comentarios, el comentario de tabla, 8 índices y el
`nullable: true` de `created_at`, que `@CreateDateColumn` declara `NOT NULL` por defecto.

Las 3 sentencias que quedan son las 2 FKs bloqueadas por espejos (`invoices_legacy`,
`subscriptions`) y el índice `gin` sobre `custom_fields`, que vive en `special-index/`.

**Impacto en consumidores: ninguno** de los 28. Las columnas nuevas son opcionales, los `@Check` son
metadata y las relaciones son propiedades nuevas que nadie construye.

### 7 · `contracts` (2026-09-13) — 39 → 3 sentencias

Sin columnas faltantes: la entity ya declaraba todo lo que existe. Faltaban los 4 `CHECK`
(`status`, `legacy_status`, `fx_company_policy`, `fx_invoice_policy`), 9 FKs, 21 comentarios,
3 índices, el `nullable: true` de `created_at` y el **default `'spot'` de `fx_invoice_policy`**,
que la entity no declaraba y TypeORM por lo tanto quería borrar.

Quedan las 2 FKs bloqueadas (`churn_reasons`, `workflow_steps`) y el índice `gin` de
`custom_fields`. **Impacto en consumidores: ninguno** de los 21.

### 8 · `stripe_sync_jobs` (2026-09-13) — 6 → 1 sentencia

Esta entity **no figuraba en el registro**: quedó fuera del inventario inicial. Le faltaban el
comentario de tabla y 4 de columna, más 3 índices. Lo único que queda es
`idx_stripe_sync_jobs_created_at`, que es `DESC` y vive en `special-index/`.

## Falsos positivos conocidos de `schema:log`

Diferencias que **no** son deriva y que no se pueden eliminar desde la entity. Hay que descontarlas
del criterio de "silencio".

| Sentencia | Por qué aparece |
|---|---|
| Los 41 `DROP INDEX` de índices que están en `special-index/` | TypeORM no los puede declarar (gin, ivfflat, orden explícito, expresiones) y por lo tanto no los reconoce. Son exactamente los 41 archivos del directorio, ni uno más. |
| `odoo_invoices_stg` y `odoo_invoice_lines_stg`: `DROP CONSTRAINT …_holding_id_fkey` + `ADD CONSTRAINT` (mismo nombre y misma definición) | Misma familia que el de abajo: TypeORM dropea y recrea la FK sin cambiar nada. Acá la columna no tiene default de función, pero sí participa además en un `@Unique` compuesto. Las 2 sentencias juntas dejan el esquema idéntico. |
| `client_contacts`, `quote_items`, `client_entities`, `invoice_items`: `DROP CONSTRAINT fk_…_holding_id` + `DROP DEFAULT` + `SET DEFAULT gen_random_uuid()` + `ADD CONSTRAINT` (mismo nombre) | Cuando una columna es a la vez join de una FK **y** tiene un default de función, TypeORM no reconoce el default como igual y emite su secuencia estándar de alteración: dropea la FK, toca el default, la recrea. Las 4 sentencias juntas dejan el esquema **idéntico**. Solo ocurre en las 7 columnas FK con `DEFAULT gen_random_uuid()` documentadas como anomalía de producción. |
| Pares `DROP INDEX` + `CREATE INDEX` con la misma definición (25 sentencias) | Cuando TypeORM altera cualquier cosa de una tabla, dropea y recrea los índices que tocan las columnas afectadas. Desaparecen solos al alinear el resto de esa tabla. 16 vienen de espejos y 9 de tablas con deriva pendiente. |
| `ALTER TABLE "salesforce_opportunities_cache" ALTER COLUMN "sync_date" SET DEFAULT ('now'::text)::date` | Producción guarda el default como `CURRENT_DATE`; TypeORM normaliza el suyo a `('now'::text)::date` y compara los textos. Son idénticos semánticamente. Se probó con ambas formas en la entity y el diff persiste. La única forma de silenciarlo sería cambiar el default en producción, que no vale el riesgo. |

## Divergencia deliberada pendiente de aplicar

`odoo_invoices_stg.processing_status` y `odoo_invoice_lines_stg.processing_status` emiten 4
sentencias (2 defaults + 2 comentarios) que **no son deriva de la entity sino una corrección
pendiente en producción**: el default de producción es `'pending'`, valor que su propio `CHECK`
rechaza (`create | update | processed | error`), así que cualquier `INSERT` que omita la columna
falla con 23514. La entity declara el valor correcto y la migración
`1788953100000-AlignStagingProcessingStatusDefault` ya está escrita; falta aplicarla a producción
con autorización explícita. Hasta entonces `schema:log` va a seguir mostrando esas 4 sentencias.

## Notas

- **Las `DROP COLUMN` son lo más delicado**: son columnas que existen en producción y la
  entity no declara. De las 68 iniciales queda **1**, `rag_documents.embedding`, en un espejo.
  Ninguna migración con `DROP COLUMN` debe aplicarse sin autorización explícita.
- Los comentarios fueron un tercio de la deriva y salen de que las entities no declaran los que sí
  tiene producción. Es mecánico y sin riesgo funcional, pero **hay que copiarlos literalmente del
  catálogo**: transcribirlos a mano produjo texto inventado dos veces. Se copian con un script.
- `uuidExtension: 'pgcrypto'` ya está configurado (producción usa `gen_random_uuid()`), pero
  medido no redujo la deriva: no era una de sus fuentes.
