# Módulo 3 · Clientes — 12 tablas de prod (2026-09-24)

> Convención y reglas: `../README.md`. Rarezas verificadas: `../NOTAS-ESPEJO.md`. Veredictos de producto: `docs/v2-rediseno/04-spec-modelo-dominio-v2/00-tablas-por-modulo.md` (no aplican en este paso).
> Origen de TODO lo que está en esta carpeta: lectura en vivo de prod `hklompkypzqtglprfobu` vía MCP de Supabase el 2026-09-24 — `list_tables verbose` + `execute_sql` de solo lectura sobre `pg_catalog` (`scripts/espejo/snapshots/clientes.{pgmeta,catalog}.json`); metadata real de las entities existentes en `clientes.existing.json` (`scripts/espejo/extract-existing-metadata.ts`). Generado con `scripts/espejo/generate-espejo.py`.

## A · Tablas que YA tenían entity en el repo (6) — no se tocaron ni se duplicaron

Estas entities están **prendidas en producción** exactamente como estaban (`database.module.ts` las carga por el glob `src/**/*.entity.ts` y sus módulos las registran en `forFeature`). "Estado vs prod" = diff entre lo que la entity declara hoy (metadata TypeORM real) y la DB en vivo; es el insumo para completarlas en el paso 3 con Leon.

| Tabla (filas) | Entity existente (archivo · clase) | Estado vs prod | Columnas que faltan en la entity | Columnas que sobran | Diferencias en columnas existentes | Constraints / índices / FKs que la entity no declara |
|---|---|---|---|---|---|---|
| `clients` (1772) | `src/databases/postgresql/entities/clientes/client.entity.ts` · `Client` | ⚠️ difiere de prod | — | — | — | nombre de PK `clients_pkey`<br>CHECK `clients_status_check`<br>índice con expresión `idx_clients_custom_fields` |
| `client_entities` (1516) | `src/databases/postgresql/entities/clientes/client-entity.entity.ts` · `ClientEntity` | ⚠️ difiere de prod | — | — | — | nombre de PK `client_entities_pkey` |
| `client_entity_clients` (1512) | `src/databases/postgresql/entities/clientes/client-entity-client.entity.ts` · `ClientEntityClient` | ⚠️ difiere de prod | — | — | — | nombre de PK `client_entity_clients_pkey` |
| `client_contacts` (220) | `src/databases/postgresql/entities/clientes/client-contact.entity.ts` · `ClientContact` | ⚠️ difiere de prod | — | — | — | nombre de PK `client_contacts_pkey` |
| `client_activity_notes` (0) | `src/databases/postgresql/entities/clientes/client-activity-note.entity.ts` · `ClientActivityNote` | ⚠️ difiere de prod | — | — | — | nombre de PK `client_activity_notes_pkey`<br>CHECK `client_activity_notes_body_check` |
| `sellers` (38) | `src/databases/postgresql/entities/clientes/seller.entity.ts` · `Seller` | ⚠️ difiere de prod | — | — | `created_at`: default `CURRENT_TIMESTAMP` vs DB `now()` | nombre de PK `sellers_pkey` |

## B · Tablas SIN entity previa → espejos generados (6): 6 promovidas, 0 apagadas

| Tabla (filas, RLS) | Archivo · clase | Cols | PK | UNIQUE | CHECK | FKs (→ tabla, ON DELETE) | Índices | Triggers | Policies |
|---|---|---|---|---|---|---|---|---|---|
| `contact_preferences` (0, RLS on) | `contact-preference.entity.ts` · `ContactPreference` | 8 | `contact_preferences_pkey` (id) | `contact_preferences_holding_id_client_id_contact_id_key` | — | — | `contact_preferences_holding_idx` | update_contact_preferences_updated_at · BEFORE UPDATE FOR EACH ROW → update_updated_at_column() | 2 |
| `client_documents` (8, RLS on) | `client-document.entity.ts` · `ClientDocument` | 13 | `client_documents_pkey` (id) | — | — | `client_documents_client_entity_id_fkey` → client_entities (SET NULL)<br>`client_documents_client_id_fkey` → clients (CASCADE)<br>`client_documents_uploaded_by_fkey` → users (SET NULL)<br>`fk_client_documents_holding_id` → company_holdings (CASCADE) | `idx_client_documents_holding_id` | — | 1 |
| `company_legal_documents` (1, RLS on) | `company-legal-document.entity.ts` · `CompanyLegalDocument` | 8 | `company_legal_documents_pkey` (id) | — | — | `company_legal_documents_company_id_fkey` → companies (CASCADE) | — | — | 1 |
| `client_entity_tax_id_normalization_conflicts` (65, RLS on) | `client-entity-tax-id-normalization-conflict.entity.ts` · `ClientEntityTaxIdNormalizationConflict` | 9 | `client_entity_tax_id_normalization_conflicts_pkey` (id) | `client_entity_tax_id_normaliz_migration_name_client_entity__key` | — | — | — | — | 0 |
| `company_bank_accounts` (9, RLS on) | `company-bank-account.entity.ts` · `CompanyBankAccount` | 9 | `company_bank_accounts_pkey` (id) | — | — | `company_bank_accounts_company_id_fkey` → companies (CASCADE) | — | — | 4 |
| `company_account_mappings` (0, RLS on) | `company-account-mapping.entity.ts` · `CompanyAccountMapping` | 13 | `company_account_mappings_pkey` (id) | `unique_company_mapping` | — | `company_account_mappings_company_id_fkey` → companies (CASCADE) | `idx_company_account_mappings_company` | — | 4 |

Cada espejo contiene, leído en vivo: columnas con tipo real (`timestamp with/without time zone`, `varchar` + `length`, `numeric` + `precision/scale`, enums de Postgres con sus valores, `text[]`, `jsonb`, `uuid`…), nullable, default y comentario; PK con nombre (`primaryKeyConstraintName`); `@Unique`/`@Check`/`@Index` con nombre real (índices parciales con `where`; los índices con expresión, orden u otro método se documentan en el JSDoc pero no se declaran porque `@Index` no los representa); una relación `@ManyToOne` por FK con `onDelete` real y `foreignKeyConstraintName` — hacia la entity existente (`@/modules/...`) si la tabla destino ya la tiene, o hacia el espejo de su módulo; cabecera JSDoc con filas, RLS, comentario de tabla, tablas que la referencian, triggers y policies (nombre, comando, roles). Las expresiones `USING`/`WITH CHECK` de las policies quedan en `scripts/espejo/snapshots/clientes.catalog.json` (`policies_detail`) para el paso 4.

**Estado: todas promovidas.** Cada archivo termina en `.entity.ts`, así que `database.module.ts` las carga por el glob `entities: [__dirname + '/../../**/*.entity{.ts,.js}']` y quedan disponibles para `TypeOrmModule.forFeature([...])` en el módulo que las use. Cada promoción está registrada a mano en `promotedMirrorEntities` de `database.module.spec.ts`. **Desde el 2026-09-22 el generador ya NO las reescribe**: la entity es la fuente de verdad de su tabla y se edita a mano (entity → `migration:generate` → revisar → `migration:run`). Lo que el generador sigue emitiendo para ellas es el snapshot contra el que las mide su spec, el barrel y este README: si el spec queda en rojo, el repo y prod difieren, y el snapshot se refresca con `yarn schema:snapshot` DESPUÉS de aplicar el cambio a prod.

## C · Columnas exactas de cada espejo (6 tablas)

<details><summary><code>contact_preferences</code> → <code>contact-preference.entity.ts</code> · 8 columnas</summary>

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
<details><summary><code>client_documents</code> → <code>client-document.entity.ts</code> · 13 columnas</summary>

| Columna | Tipo Postgres | Nulo | Default | Comentario |
|---|---|---|---|---|
| `id` 🔑 | uuid | no | gen_random_uuid() |  |
| `client_id` | uuid | sí | — |  |
| `document_name` | text | sí | — |  |
| `file_url` | text | sí | — |  |
| `uploaded_at` | timestamp without time zone | sí | now() |  |
| `holding_id` | uuid | no | gen_random_uuid() |  |
| `storage_bucket` | text | sí | — | Bucket de Storage (privado) del archivo; NULL en documentos antiguos con URL pública |
| `storage_path` | text | sí | — | Ruta del objeto dentro del bucket: <holding_id>/<client_id>/<id>/<nombre> |
| `file_size` | bigint | sí | — |  |
| `mime_type` | text | sí | — |  |
| `uploaded_by` | uuid | sí | — | users.id de quien lo subió |
| `client_entity_id` | uuid | sí | — | Razón social a la que corresponde (opcional) |
| `deleted_at` | timestamp with time zone | sí | — | Borrado lógico desde el front nuevo |

</details>
<details><summary><code>company_legal_documents</code> → <code>company-legal-document.entity.ts</code> · 8 columnas</summary>

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
<details><summary><code>client_entity_tax_id_normalization_conflicts</code> → <code>client-entity-tax-id-normalization-conflict.entity.ts</code> · 9 columnas</summary>

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
<details><summary><code>company_bank_accounts</code> → <code>company-bank-account.entity.ts</code> · 9 columnas</summary>

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
<details><summary><code>company_account_mappings</code> → <code>company-account-mapping.entity.ts</code> · 13 columnas</summary>

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
- `../../database.module.spec.ts`: `synchronize: false`, nadie habilita sincronización, y un espejo solo se carga en runtime si su promoción figura en `promotedMirrorEntities`.
