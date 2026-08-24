# Módulo 1 · Base / Tenancy — 14 tablas de prod (2026-08-22)

> Convención y reglas: `../README.md`. Rarezas verificadas: `../NOTAS-ESPEJO.md`. Veredictos de producto: `docs/v2-rediseno/04-spec-modelo-dominio-v2/00-tablas-por-modulo.md` (no aplican en este paso).
> Origen de TODO lo que está en esta carpeta: lectura en vivo de prod `hklompkypzqtglprfobu` vía MCP de Supabase el 2026-08-22 — `list_tables verbose` + `execute_sql` de solo lectura sobre `pg_catalog` (`scripts/espejo/snapshots/base-tenancy.{pgmeta,catalog}.json`); metadata real de las entities existentes en `base-tenancy.existing.json` (`scripts/espejo/extract-existing-metadata.ts`). Generado con `scripts/espejo/generate-espejo.py`.

## A · Tablas que YA tenían entity en el repo (6) — no se tocaron ni se duplicaron

Estas entities están **prendidas en producción** exactamente como estaban (`database.module.ts` las carga por el glob `src/**/*.entity.ts` y sus módulos las registran en `forFeature`). "Estado vs prod" = diff entre lo que la entity declara hoy (metadata TypeORM real) y la DB en vivo; es el insumo para completarlas en el paso 3 con Leon.

| Tabla (filas) | Entity existente (archivo · clase) | Estado vs prod | Columnas que faltan en la entity | Columnas que sobran | Diferencias en columnas existentes | Constraints / índices / FKs que la entity no declara |
|---|---|---|---|---|---|---|
| `users` (28) | `src/modules/users/entities/user.entity.ts` · `User` | ⚠️ difiere de prod | `last_invitation_sent_at` timestamp with time zone<br>`last_invitation_email_id` text<br>`last_invitation_status` text | — | `created_at`: NOT NULL en la entity vs nullable en DB | nombre de PK `users_pkey`<br>CHECK `users_status_check`<br>FK `users_role_id_fkey` → roles<br>índice `idx_users_auth_id`<br>índice `idx_users_role_id` |
| `user_holdings` (38) | `src/modules/holdings/entities/user-holding.entity.ts` · `UserHolding` | ⚠️ difiere de prod | — | — | `created_at`: NOT NULL en la entity vs nullable en DB | nombre de PK `user_holdings_pkey`<br>FK `fk_user_holdings_user_id` → users ON DELETE CASCADE<br>índice `idx_user_holdings_holding_id`<br>índice `idx_user_holdings_one_selected_per_user` (UNIQUE, parcial)<br>índice `idx_user_holdings_selected` (parcial)<br>índice `idx_user_holdings_user_id` |
| `company_holdings` (7) | `src/modules/holdings/entities/company-holding.entity.ts` · `CompanyHolding` | ⚠️ difiere de prod | — | — | `created_at`: NOT NULL en la entity vs nullable en DB | nombre de PK `company_holdings_pkey` |
| `companies` (22) | `src/modules/odoo/entities/companies.entity.ts` · `Company` | ⚠️ difiere de prod | — | — | `created_at`: NOT NULL en la entity vs nullable en DB | nombre de PK `companies_pkey`<br>FK `companies_holding_fk` → company_holdings ON DELETE SET NULL<br>índice `idx_companies_odoo_integration_id`<br>índice `unique_odoo_integration_id_per_holding` (UNIQUE, parcial) |
| `master_data` (264) | `src/modules/salesforce/entities/master-data.entity.ts` · `MasterData` | ⚠️ difiere de prod | — | — | — | nombre de PK `master_data_pkey`<br>UNIQUE `master_data_holding_id_category_value_key` (holding_id, category, value)<br>CHECK `master_data_category_check`<br>FK `fk_master_data_holding_id` → company_holdings ON DELETE CASCADE<br>índice `idx_master_data_category_active` (parcial)<br>índice `idx_master_data_holding_id` |
| `currencies` (10) | `src/modules/banco-central/entities/currency.entity.ts` · `Currency` | ⚠️ difiere de prod | — | — | `decimal_places`: NOT NULL en la entity vs nullable en DB<br>`is_active`: NOT NULL en la entity vs nullable en DB<br>`created_at`: NOT NULL en la entity vs nullable en DB<br>`updated_at`: NOT NULL en la entity vs nullable en DB | nombre de PK `currencies_pkey`<br>índice `idx_currencies_is_active`<br>índice `idx_currencies_odoo_id` |

## B · Tablas SIN entity → espejos creados (8), APAGADOS

| Tabla (filas, RLS) | Espejo · clase | Cols | PK | UNIQUE | CHECK | FKs (→ tabla, ON DELETE) | Índices | Triggers | Policies |
|---|---|---|---|---|---|---|---|---|---|
| `roles` (70, RLS on) | `role.espejo.ts` · `Role` | 5 | `roles_pkey` (id) | `roles_name_holding_id_key` | — | `fk_roles_holding_id` → company_holdings (CASCADE) | `idx_roles_holding_id` | — | 5 |
| `permissions` (22, RLS on) | `permission.espejo.ts` · `Permission` | 3 | `permissions_pkey` (id) | `permissions_code_key` | — | — | — | — | 3 |
| `role_permissions` (638, RLS on) | `role-permission.espejo.ts` · `RolePermission` | 3 | `role_permissions_pkey` (role_id, permission_id) | — | — | `role_permissions_role_id_fkey` → roles<br>`role_permissions_permission_id_fkey` → permissions<br>`fk_role_permissions_holding_id` → company_holdings (CASCADE) | `idx_role_permissions_holding_id`, `idx_role_permissions_permission_id`, `idx_role_permissions_role_id` | — | 5 |
| `financial_settings` (4, RLS on) | `financial-settings.espejo.ts` · `FinancialSettings` | 8 | `financial_settings_pkey` (id) | `financial_settings_holding_id_key` | — | — | — | trg_financial_settings_updated_at · BEFORE UPDATE FOR EACH ROW → update_updated_at_column() | 4 |
| `holding_settings` (4, RLS on) | `holding-settings.espejo.ts` · `HoldingSettings` | 6 | `holding_settings_pkey` (holding_id) | — | `holding_settings_fx_system_policy_check` | `holding_settings_holding_id_fkey` → company_holdings (CASCADE) | — | trg_holding_settings_updated_at · BEFORE UPDATE FOR EACH ROW → update_updated_at_column() | 4 |
| `custom_field_definitions` (16, RLS on) | `custom-field-definition.espejo.ts` · `CustomFieldDefinition` | 11 | `custom_field_definitions_pkey` (id) | `unique_field_per_entity` | `custom_field_definitions_field_type_check`, `valid_entity_type` | `custom_field_definitions_holding_id_fkey` → company_holdings (CASCADE)<br>`custom_field_definitions_created_by_fkey` → users | `idx_custom_field_defs_active` (parcial), `idx_custom_field_defs_holding_entity`, `idx_custom_field_defs_order` | — | 4 |
| `user_view_preferences` (8, RLS on) | `user-view-preference.espejo.ts` · `UserViewPreference` | 9 | `user_view_preferences_pkey` (id) | `user_view_preferences_user_id_entity_type_view_name_key` | — | `user_view_preferences_user_id_fkey` → users (CASCADE) | `idx_user_view_prefs_one_default_per_entity` (UNIQUE, parcial), `idx_user_view_prefs_user_entity` | user_view_preferences_updated_at · BEFORE UPDATE FOR EACH ROW → update_user_view_preferences_updated_at() | 4 |
| `claude_skills` (2, RLS on) | `claude-skill.espejo.ts` · `ClaudeSkill` | 8 | `claude_skills_pkey` (id) | `claude_skills_name_holding_id_key` | — | `claude_skills_holding_id_fkey` → company_holdings (CASCADE) | `idx_claude_skills_holding_id`, `idx_claude_skills_is_active`, `idx_claude_skills_name` | — | 0 |

Cada espejo contiene, leído en vivo: columnas con tipo real (`timestamp with/without time zone`, `varchar` + `length`, `numeric` + `precision/scale`, enums de Postgres con sus valores, `text[]`, `jsonb`, `uuid`…), nullable, default y comentario; PK con nombre (`primaryKeyConstraintName`); `@Unique`/`@Check`/`@Index` con nombre real (índices parciales con `where`; los índices con expresión, orden u otro método se documentan en el JSDoc pero no se declaran porque `@Index` no los representa); una relación `@ManyToOne` por FK con `onDelete` real y `foreignKeyConstraintName` — hacia la entity existente (`@/modules/...`) si la tabla destino ya la tiene, o hacia el espejo de su módulo; cabecera JSDoc con filas, RLS, comentario de tabla, tablas que la referencian, triggers y policies (nombre, comando, roles). Las expresiones `USING`/`WITH CHECK` de las policies quedan en `scripts/espejo/snapshots/base-tenancy.catalog.json` (`policies_detail`) para el paso 4.

**Cómo están apagados (código técnico)**: el archivo termina en `.espejo.ts`, no en `.entity.ts`. `database.module.ts` carga entities con `entities: [__dirname + '/../../**/*.entity{.ts,.js}']`, así que no los ve, y ningún módulo los incluye en `TypeOrmModule.forFeature([...])`. `database.module.spec.ts` falla si aparece un `.entity.ts` dentro de `entities/<modulo>/`. Para encenderlos en el paso 3: renombrar a `.entity.ts` y registrarlos en el `forFeature` del módulo que los use.

## C · Columnas exactas de cada espejo (8 tablas)

<details><summary><code>roles</code> → <code>role.espejo.ts</code> · 5 columnas</summary>

| Columna | Tipo Postgres | Nulo | Default | Comentario |
|---|---|---|---|---|
| `id` 🔑 | uuid | no | gen_random_uuid() |  |
| `name` | text | no | — |  |
| `description` | text | sí | — |  |
| `created_at` | timestamp without time zone | sí | now() |  |
| `holding_id` | uuid | sí | — |  |

</details>
<details><summary><code>permissions</code> → <code>permission.espejo.ts</code> · 3 columnas</summary>

| Columna | Tipo Postgres | Nulo | Default | Comentario |
|---|---|---|---|---|
| `id` 🔑 | uuid | no | gen_random_uuid() |  |
| `code` | text | no | — |  |
| `description` | text | sí | — |  |

</details>
<details><summary><code>role_permissions</code> → <code>role-permission.espejo.ts</code> · 3 columnas</summary>

| Columna | Tipo Postgres | Nulo | Default | Comentario |
|---|---|---|---|---|
| `role_id` 🔑 | uuid | no | — |  |
| `permission_id` 🔑 | uuid | no | — |  |
| `holding_id` | uuid | sí | — |  |

</details>
<details><summary><code>financial_settings</code> → <code>financial-settings.espejo.ts</code> · 8 columnas</summary>

| Columna | Tipo Postgres | Nulo | Default | Comentario |
|---|---|---|---|---|
| `id` 🔑 | uuid | no | gen_random_uuid() |  |
| `holding_id` | uuid | no | — |  |
| `recognition_granularity` | text | no | 'monthly'::text |  |
| `discount_policy` | text | no | 'from_application_date'::text |  |
| `discounts_require_approval` | boolean | no | true |  |
| `created_at` | timestamp with time zone | no | now() |  |
| `updated_at` | timestamp with time zone | no | now() |  |
| `revenue_schedule_monthly_enabled` | boolean | no | false |  |

</details>
<details><summary><code>holding_settings</code> → <code>holding-settings.espejo.ts</code> · 6 columnas</summary>

| Columna | Tipo Postgres | Nulo | Default | Comentario |
|---|---|---|---|---|
| `holding_id` 🔑 | uuid | no | — |  |
| `system_currency` | text | no | 'USD'::text |  |
| `created_at` | timestamp with time zone | no | now() |  |
| `updated_at` | timestamp with time zone | no | now() |  |
| `fx_system_policy` | text | sí | 'monthly_avg'::text | Política FX para conversión a moneda de sistema: fixed_period o monthly_avg |
| `currencies_in_use` | text[] | sí | ARRAY[]::text[] | Monedas utilizadas en el holding |

</details>
<details><summary><code>custom_field_definitions</code> → <code>custom-field-definition.espejo.ts</code> · 11 columnas</summary>

| Columna | Tipo Postgres | Nulo | Default | Comentario |
|---|---|---|---|---|
| `id` 🔑 | uuid | no | gen_random_uuid() |  |
| `holding_id` | uuid | no | — |  |
| `entity_type` | text | no | — |  |
| `field_name` | text | no | — | Identificador único del campo en snake_case (ej: proyecto_cliente) |
| `field_label` | text | no | — | Label visible para el usuario (ej: Proyecto del Cliente) |
| `field_type` | text | no | — | Tipo de dato: text o number |
| `is_required` | boolean | no | false |  |
| `is_active` | boolean | no | true | Permite ocultar campos sin eliminarlos |
| `display_order` | integer | no | 0 | Orden de visualización en formularios |
| `created_at` | timestamp with time zone | no | now() |  |
| `created_by` | uuid | sí | — |  |

</details>
<details><summary><code>user_view_preferences</code> → <code>user-view-preference.espejo.ts</code> · 9 columnas</summary>

| Columna | Tipo Postgres | Nulo | Default | Comentario |
|---|---|---|---|---|
| `id` 🔑 | uuid | no | gen_random_uuid() |  |
| `user_id` | uuid | no | — |  |
| `entity_type` | text | no | — |  |
| `view_name` | text | no | 'Mi Vista'::text |  |
| `column_config` | jsonb | no | — | Array de configuración de columnas: [{key, label, visible}]. |
| `filter_config` | jsonb | no | '{}'::jsonb | Snapshot del FilterState: { quickFilters, advancedFilters, searchQuery }. Fechas como ISO string. |
| `is_default` | boolean | no | false | Solo una vista por (user_id, entity_type) puede tener is_default=true (garantizado por idx_user_view_prefs_one_default_per_entity). Se carga al entrar al módulo. |
| `created_at` | timestamp with time zone | no | now() |  |
| `updated_at` | timestamp with time zone | no | now() |  |

</details>
<details><summary><code>claude_skills</code> → <code>claude-skill.espejo.ts</code> · 8 columnas</summary>

| Columna | Tipo Postgres | Nulo | Default | Comentario |
|---|---|---|---|---|
| `id` 🔑 | uuid | no | gen_random_uuid() |  |
| `name` | varchar(255) | no | — |  |
| `description` | text | no | — |  |
| `input_schema` | jsonb | no | — |  |
| `holding_id` | uuid | sí | — |  |
| `is_active` | boolean | sí | true |  |
| `created_at` | timestamp with time zone | sí | now() |  |
| `updated_at` | timestamp with time zone | sí | now() |  |

</details>

## Verificación (sin conexión a la DB)

- `base-tenancy.entities.spec.ts`: metadata TypeORM en memoria vs `base-tenancy.prod-snapshot.ts` — columnas + nullabilidad, PK, FKs (tabla y ON DELETE), UNIQUE, CHECK e índices declarables — y que ningún espejo duplica una tabla de `scripts/espejo/existing-entities.json`.
- `../../database.module.spec.ts`: `synchronize: false`, nadie habilita sincronización, ningún `.entity.ts` dentro de `entities/<modulo>/`.
