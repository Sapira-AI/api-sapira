# Módulo 3 · Clientes — 11 tablas de prod (2026-08-22)

> Convención y reglas: `../README.md`. Rarezas verificadas: `../NOTAS-ESPEJO.md`. Veredictos de producto: `docs/v2-rediseno/04-spec-modelo-dominio-v2/00-tablas-por-modulo.md` (no aplican en este paso).
> Origen de TODO lo que está en esta carpeta: lectura en vivo de prod `hklompkypzqtglprfobu` vía MCP de Supabase el 2026-08-22 — `list_tables verbose` + `execute_sql` de solo lectura sobre `pg_catalog` (`scripts/espejo/snapshots/clientes.{pgmeta,catalog}.json`); metadata real de las entities existentes en `clientes.existing.json` (`scripts/espejo/extract-existing-metadata.ts`). Generado con `scripts/espejo/generate-espejo.py`.

## A · Tablas que YA tenían entity en el repo (5) — no se tocaron ni se duplicaron

Estas entities están **prendidas en producción** exactamente como estaban (`database.module.ts` las carga por el glob `src/**/*.entity.ts` y sus módulos las registran en `forFeature`). "Estado vs prod" = diff entre lo que la entity declara hoy (metadata TypeORM real) y la DB en vivo; es el insumo para completarlas en el paso 3 con Leon.

| Tabla (filas) | Entity existente (archivo · clase) | Estado vs prod | Columnas que faltan en la entity | Columnas que sobran | Diferencias en columnas existentes | Constraints / índices / FKs que la entity no declara |
|---|---|---|---|---|---|---|
| `clients` (1784) | `src/databases/postgresql/entities/client.entity.ts` · `Client` | ⚠️ difiere de prod | — | — | `created_at`: NOT NULL en la entity vs nullable en DB | nombre de PK `clients_pkey`<br>CHECK `clients_status_check`<br>FK `clients_holding_id_fkey` → company_holdings<br>índice `idx_clients_client_number`<br>índice `idx_clients_holding_id`<br>índice `idx_clients_salesforce_account_id` (parcial)<br>índice `idx_clients_salesforce_account_unique` (UNIQUE, parcial)<br>índice `idx_clients_stripe_customer_id` (parcial)<br>índice con expresión `idx_clients_custom_fields` |
| `client_entities` (1513) | `src/databases/postgresql/entities/client-entity.entity.ts` · `ClientEntity` | ⚠️ difiere de prod | — | — | `holding_id`: default `None` vs DB `gen_random_uuid()` | nombre de PK `client_entities_pkey`<br>FK `fk_client_entities_holding_id` → company_holdings ON DELETE CASCADE<br>FK `client_entities_client_id_fkey` → clients ON DELETE CASCADE<br>índice `idx_client_entities_client_number`<br>índice `idx_client_entities_holding_id`<br>índice `idx_client_entities_odoo_partner_holding` (UNIQUE, parcial)<br>índice `idx_client_entities_odoo_partner_id` (parcial) |
| `client_entity_clients` (1529) | `src/databases/postgresql/entities/client-entity-client.entity.ts` · `ClientEntityClient` | ⚠️ difiere de prod | — | — | — | nombre de PK `client_entity_clients_pkey`<br>UNIQUE `unique_entity_client` (client_entity_id, client_id)<br>FK `client_entity_clients_client_id_fkey` → clients ON DELETE CASCADE<br>FK `client_entity_clients_created_by_fkey` → users<br>FK `client_entity_clients_holding_id_fkey` → company_holdings ON DELETE CASCADE<br>FK `client_entity_clients_client_entity_id_fkey` → client_entities ON DELETE CASCADE<br>índice `idx_client_entity_clients_client`<br>índice `idx_client_entity_clients_entity`<br>índice `idx_client_entity_clients_holding`<br>índice `idx_client_entity_clients_primary` (parcial) |
| `client_contacts` (235) | `src/modules/salesforce/entities/client-contact.entity.ts` · `ClientContact` | ⚠️ difiere de prod | — | — | `client_id`: NOT NULL en la entity vs nullable en DB<br>`holding_id`: default `None` vs DB `gen_random_uuid()` | nombre de PK `client_contacts_pkey`<br>FK `fk_client_contacts_holding_id` → company_holdings ON DELETE CASCADE<br>FK `client_contacts_client_id_fkey` → clients ON DELETE CASCADE<br>índice `idx_client_contacts_holding_id` |
| `sellers` (37) | `src/modules/salesforce/entities/seller.entity.ts` · `Seller` | ⚠️ difiere de prod | — | — | `created_at`: default `CURRENT_TIMESTAMP` vs DB `now()` | nombre de PK `sellers_pkey`<br>FK `fk_sellers_holding_id` → company_holdings ON DELETE CASCADE |

## B · Tablas SIN entity → espejos creados (6), APAGADOS

| Tabla (filas, RLS) | Espejo · clase | Cols | PK | UNIQUE | CHECK | FKs (→ tabla, ON DELETE) | Índices | Triggers | Policies |
|---|---|---|---|---|---|---|---|---|---|
| `contact_preferences` (0, RLS on) | `contact-preference.espejo.ts` · `ContactPreference` | 8 | `contact_preferences_pkey` (id) | `contact_preferences_holding_id_client_id_contact_id_key` | — | — | `contact_preferences_holding_idx` | update_contact_preferences_updated_at · BEFORE UPDATE FOR EACH ROW → update_updated_at_column() | 2 |
| `client_documents` (8, RLS on) | `client-document.espejo.ts` · `ClientDocument` | 6 | `client_documents_pkey` (id) | — | — | `fk_client_documents_holding_id` → company_holdings (CASCADE)<br>`client_documents_client_id_fkey` → clients (CASCADE) | `idx_client_documents_holding_id` | — | 1 |
| `company_legal_documents` (1, RLS on) | `company-legal-document.espejo.ts` · `CompanyLegalDocument` | 8 | `company_legal_documents_pkey` (id) | — | — | `company_legal_documents_company_id_fkey` → companies (CASCADE) | — | — | 1 |
| `client_entity_tax_id_normalization_conflicts` (65, RLS OFF) | `client-entity-tax-id-normalization-conflict.espejo.ts` · `ClientEntityTaxIdNormalizationConflict` | 9 | `client_entity_tax_id_normalization_conflicts_pkey` (id) | `client_entity_tax_id_normaliz_migration_name_client_entity__key` | — | — | — | — | 0 |
| `company_bank_accounts` (2, RLS on) | `company-bank-account.espejo.ts` · `CompanyBankAccount` | 9 | `company_bank_accounts_pkey` (id) | — | — | `company_bank_accounts_company_id_fkey` → companies (CASCADE) | — | — | 4 |
| `company_account_mappings` (0, RLS on) | `company-account-mapping.espejo.ts` · `CompanyAccountMapping` | 13 | `company_account_mappings_pkey` (id) | `unique_company_mapping` | — | `company_account_mappings_company_id_fkey` → companies (CASCADE) | `idx_company_account_mappings_company` | — | 4 |

Cada espejo contiene, leído en vivo: columnas con tipo real (`timestamp with/without time zone`, `varchar` + `length`, `numeric` + `precision/scale`, enums de Postgres con sus valores, `text[]`, `jsonb`, `uuid`…), nullable, default y comentario; PK con nombre (`primaryKeyConstraintName`); `@Unique`/`@Check`/`@Index` con nombre real (índices parciales con `where`; los índices con expresión, orden u otro método se documentan en el JSDoc pero no se declaran porque `@Index` no los representa); una relación `@ManyToOne` por FK con `onDelete` real y `foreignKeyConstraintName` — hacia la entity existente (`@/modules/...`) si la tabla destino ya la tiene, o hacia el espejo de su módulo; cabecera JSDoc con filas, RLS, comentario de tabla, tablas que la referencian, triggers y policies (nombre, comando, roles). Las expresiones `USING`/`WITH CHECK` de las policies quedan en `scripts/espejo/snapshots/clientes.catalog.json` (`policies_detail`) para el paso 4.

**Cómo están apagados (código técnico)**: el archivo termina en `.espejo.ts`, no en `.entity.ts`. `database.module.ts` carga entities con `entities: [__dirname + '/../../**/*.entity{.ts,.js}']`, así que no los ve, y ningún módulo los incluye en `TypeOrmModule.forFeature([...])`. `database.module.spec.ts` falla si aparece un `.entity.ts` dentro de `entities/<modulo>/`. Para encenderlos en el paso 3: renombrar a `.entity.ts` y registrarlos en el `forFeature` del módulo que los use.

## C · Columnas exactas de cada espejo (6 tablas)

<details><summary><code>contact_preferences</code> → <code>contact-preference.espejo.ts</code> · 8 columnas</summary>

| Columna | Tipo Postgres | Nulo | Default | Comentario |
|---|---|---|---|---|
| `id` 🔑 | uuid | no | gen_random_uuid() |  |
| `holding_id` | uuid | no | — |  |
| `client_id` | uuid | no | — |  |
| `contact_id` | uuid | no | — |  |
| `allow_billing_emails` | boolean | no | true |  |
| `allow_proforma` | boolean | no | true |  |
| `created_at` | timestamp with time zone | no | now() |  |
| `updated_at` | timestamp with time zone | no | now() |  |

</details>
<details><summary><code>client_documents</code> → <code>client-document.espejo.ts</code> · 6 columnas</summary>

| Columna | Tipo Postgres | Nulo | Default | Comentario |
|---|---|---|---|---|
| `id` 🔑 | uuid | no | gen_random_uuid() |  |
| `client_id` | uuid | sí | — |  |
| `document_name` | text | sí | — |  |
| `file_url` | text | sí | — |  |
| `uploaded_at` | timestamp without time zone | sí | now() |  |
| `holding_id` | uuid | no | gen_random_uuid() |  |

</details>
<details><summary><code>company_legal_documents</code> → <code>company-legal-document.espejo.ts</code> · 8 columnas</summary>

| Columna | Tipo Postgres | Nulo | Default | Comentario |
|---|---|---|---|---|
| `id` 🔑 | uuid | no | gen_random_uuid() |  |
| `company_id` | uuid | no | — |  |
| `document_name` | text | no | — |  |
| `document_type` | text | no | — |  |
| `upload_date` | date | no | CURRENT_DATE |  |
| `file_url` | text | sí | — |  |
| `created_at` | timestamp without time zone | sí | now() |  |
| `holding_id` | uuid | no | — |  |

</details>
<details><summary><code>client_entity_tax_id_normalization_conflicts</code> → <code>client-entity-tax-id-normalization-conflict.espejo.ts</code> · 9 columnas</summary>

| Columna | Tipo Postgres | Nulo | Default | Comentario |
|---|---|---|---|---|
| `id` 🔑 | uuid | no | gen_random_uuid() |  |
| `migration_name` | text | no | — |  |
| `holding_id` | uuid | no | — |  |
| `client_entity_id` | uuid | no | — |  |
| `conflicting_client_entity_ids` | uuid[] | no | — |  |
| `tax_id_current` | text | no | — |  |
| `tax_id_normalized` | text | no | — |  |
| `detected_at` | timestamp with time zone | no | now() |  |
| `resolved_at` | timestamp with time zone | sí | — |  |

</details>
<details><summary><code>company_bank_accounts</code> → <code>company-bank-account.espejo.ts</code> · 9 columnas</summary>

| Columna | Tipo Postgres | Nulo | Default | Comentario |
|---|---|---|---|---|
| `id` 🔑 | uuid | no | gen_random_uuid() |  |
| `company_id` | uuid | no | — |  |
| `bank_name` | text | no | — |  |
| `account_type` | text | no | — |  |
| `account_number` | text | no | — |  |
| `currency` | text | no | — |  |
| `account_holder` | text | sí | — |  |
| `created_at` | timestamp without time zone | sí | now() |  |
| `holding_id` | uuid | no | — |  |

</details>
<details><summary><code>company_account_mappings</code> → <code>company-account-mapping.espejo.ts</code> · 13 columnas</summary>

| Columna | Tipo Postgres | Nulo | Default | Comentario |
|---|---|---|---|---|
| `id` 🔑 | uuid | no | gen_random_uuid() |  |
| `company_id` | uuid | no | — |  |
| `revenue_account_code` | text | no | '4.1.01'::text |  |
| `revenue_account_name` | text | no | 'Revenue'::text |  |
| `unbilled_account_code` | text | no | '1.1.03'::text |  |
| `unbilled_account_name` | text | no | 'Unbilled Revenue (Contract Asset)'::text |  |
| `deferred_account_code` | text | no | '2.2.05'::text |  |
| `deferred_account_name` | text | no | 'Deferred Revenue'::text |  |
| `external_revenue_code` | text | sí | — |  |
| `external_unbilled_code` | text | sí | — |  |
| `external_deferred_code` | text | sí | — |  |
| `created_at` | timestamp with time zone | sí | now() |  |
| `updated_at` | timestamp with time zone | sí | now() |  |

</details>

## Verificación (sin conexión a la DB)

- `clientes.entities.spec.ts`: metadata TypeORM en memoria vs `clientes.prod-snapshot.ts` — columnas + nullabilidad, PK, FKs (tabla y ON DELETE), UNIQUE, CHECK e índices declarables — y que ningún espejo duplica una tabla de `scripts/espejo/existing-entities.json`.
- `../../database.module.spec.ts`: `synchronize: false`, nadie habilita sincronización, ningún `.entity.ts` dentro de `entities/<modulo>/`.
