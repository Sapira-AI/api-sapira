# Módulo 11 · Automatizaciones, IA, notificaciones y correo — 13 tablas de prod (2026-08-22)

> Convención y reglas: `../README.md`. Rarezas verificadas: `../NOTAS-ESPEJO.md`. Veredictos de producto: `docs/v2-rediseno/04-spec-modelo-dominio-v2/00-tablas-por-modulo.md` (no aplican en este paso).
> Origen de TODO lo que está en esta carpeta: lectura en vivo de prod `hklompkypzqtglprfobu` vía MCP de Supabase el 2026-08-22 — `list_tables verbose` + `execute_sql` de solo lectura sobre `pg_catalog` (`scripts/espejo/snapshots/automatizaciones-ia.{pgmeta,catalog}.json`); metadata real de las entities existentes en `automatizaciones-ia.existing.json` (`scripts/espejo/extract-existing-metadata.ts`). Generado con `scripts/espejo/generate-espejo.py`.

## A · Tablas que YA tenían entity en el repo (3) — no se tocaron ni se duplicaron

Estas entities están **prendidas en producción** exactamente como estaban (`database.module.ts` las carga por el glob `src/**/*.entity.ts` y sus módulos las registran en `forFeature`). "Estado vs prod" = diff entre lo que la entity declara hoy (metadata TypeORM real) y la DB en vivo; es el insumo para completarlas en el paso 3 con Leon.

| Tabla (filas) | Entity existente (archivo · clase) | Estado vs prod | Columnas que faltan en la entity | Columnas que sobran | Diferencias en columnas existentes | Constraints / índices / FKs que la entity no declara |
|---|---|---|---|---|---|---|
| `app_notifications` (3) | `src/modules/notifications/entities/app-notification.entity.ts` · `AppNotification` | ⚠️ difiere de prod | — | — | — | nombre de PK `app_notifications_pkey`<br>CHECK `app_notifications_severity_check`<br>CHECK `app_notifications_status_check`<br>FK `app_notifications_holding_id_fkey` → company_holdings ON DELETE CASCADE<br>índice `app_notifications_open_deduplication_key_idx` (UNIQUE, parcial)<br>índice con expresión `app_notifications_holding_resource_created_idx`<br>índice con expresión `app_notifications_holding_status_created_idx` |
| `app_notification_recipients` (14) | `src/modules/notifications/entities/app-notification-recipient.entity.ts` · `AppNotificationRecipient` | ⚠️ difiere de prod | — | — | — | nombre de PK `app_notification_recipients_pkey`<br>UNIQUE `app_notification_recipients_notification_id_user_id_key` (notification_id, user_id)<br>FK `app_notification_recipients_user_id_fkey` → users ON DELETE CASCADE<br>índice con expresión `app_notification_recipients_user_unread_idx` |
| `notification_role_subscriptions` (18) | `src/modules/notifications/entities/notification-role-subscription.entity.ts` · `NotificationRoleSubscription` | ⚠️ difiere de prod | — | — | — | nombre de PK `notification_role_subscriptions_pkey`<br>UNIQUE `notification_role_subscriptio_holding_id_role_id_notificati_key` (holding_id, role_id, notification_type)<br>FK `notification_role_subscriptions_role_id_fkey` → roles ON DELETE CASCADE<br>FK `notification_role_subscriptions_holding_id_fkey` → company_holdings ON DELETE CASCADE<br>índice `notification_role_subscriptions_holding_type_idx` (parcial) |

## B · Tablas SIN entity → espejos creados (10), APAGADOS

| Tabla (filas, RLS) | Espejo · clase | Cols | PK | UNIQUE | CHECK | FKs (→ tabla, ON DELETE) | Índices | Triggers | Policies |
|---|---|---|---|---|---|---|---|---|---|
| `ai_agents` (16, RLS on) | `ai-agent.espejo.ts` · `AiAgent` | 11 | `ai_agents_pkey` (id) | — | `ai_agents_type_check` | — | `ai_agents_holding_type_idx` | update_ai_agents_updated_at · BEFORE UPDATE FOR EACH ROW → update_updated_at_column() | 2 |
| `ai_agent_configs` (122, RLS on) | `ai-agent-config.espejo.ts` · `AiAgentConfig` | 6 | `ai_agent_configs_pkey` (id) | `ai_agent_configs_agent_id_key_key` | — | `ai_agent_configs_agent_id_fkey` → ai_agents (CASCADE) | `ai_agent_configs_agent_idx` | update_ai_agent_configs_updated_at · BEFORE UPDATE FOR EACH ROW → update_updated_at_column() | 2 |
| `client_agent_configs` (0, RLS on) | `client-agent-config.espejo.ts` · `ClientAgentConfig` | 9 | `client_agent_configs_pkey` (id) | `client_agent_configs_holding_id_client_id_agent_type_key` | `client_agent_configs_agent_type_check` | `client_agent_configs_holding_id_fkey` → company_holdings (CASCADE)<br>`client_agent_configs_client_id_fkey` → clients (CASCADE)<br>`client_agent_configs_created_by_fkey` → users | `idx_client_agent_configs_agent_type`, `idx_client_agent_configs_enabled` (parcial), `idx_client_agent_configs_holding_client`, `idx_client_agent_configs_holding_global` (UNIQUE, parcial), `idx_client_agent_configs_holding_type` | trigger_update_client_agent_configs_updated_at · BEFORE UPDATE FOR EACH ROW → update_client_agent_configs_updated_at()<br>trigger_validate_client_agent_config_email_sender · BEFORE INSERT OR UPDATE FOR EACH ROW → validate_client_agent_config_email_sender() | 4 |
| `agents` (0, RLS on) | `agent.espejo.ts` · `Agent` | 10 | `agents_pkey` (id) | — | — | `fk_agents_holding_id` → company_holdings (CASCADE)<br>`agents_company_id_fkey` → companies | `idx_agents_holding_id` | — | 4 |
| `agent_logs` (0, RLS on) | `agent-log.espejo.ts` · `AgentLog` | 6 | `agent_logs_pkey` (id) | — | — | `agent_logs_user_id_fkey` → users<br>`fk_agent_logs_holding_id` → company_holdings (CASCADE)<br>`agent_logs_agent_id_fkey` → agents | `idx_agent_logs_holding_id` | — | 2 |
| `ai_runs` (0, RLS on) | `ai-run.espejo.ts` · `AiRun` | 10 | `ai_runs_pkey` (id) | — | `ai_runs_status_check` | `ai_runs_agent_id_fkey` → ai_agents (CASCADE)<br>`ai_runs_holding_id_fkey` → company_holdings (CASCADE) | `ai_runs_agent_idx` (expresión, no declarado), `ai_runs_holding_idx` (expresión, no declarado) | — | 2 |
| `ai_messages` (0, RLS on) | `ai-message.espejo.ts` · `AiMessage` | 9 | `ai_messages_pkey` (id) | — | `ai_messages_channel_check`, `ai_messages_direction_check` | `ai_messages_run_id_fkey` → ai_runs (CASCADE) | `ai_messages_run_idx` (expresión, no declarado) | — | 2 |
| `rag_documents` (0, RLS on) | `rag-document.espejo.ts` · `RagDocument` | 9 | `rag_documents_pkey` (id) | — | — | `rag_documents_holding_id_fkey` → company_holdings (CASCADE) | `rag_documents_holding_id_idx`, `rag_documents_source_idx`, `rag_documents_embedding_ivfflat_idx` (expresión, no declarado), `rag_documents_metadata_gin_idx` (expresión, no declarado) | — | 1 |
| `email_sender_addresses` (0, RLS on) | `email-sender-address.espejo.ts` · `EmailSenderAddress` | 11 | `email_sender_addresses_pkey` (id) | — | — | `email_sender_addresses_domain_config_id_fkey` → holding_email_sender_settings (CASCADE)<br>`email_sender_addresses_created_by_fkey` → users | `idx_email_sender_addresses_active` (parcial), `idx_email_sender_addresses_default` (parcial), `idx_email_sender_addresses_domain`, `unique_default_sender_per_domain` (UNIQUE, parcial) | trigger_update_email_sender_addresses_updated_at · BEFORE UPDATE FOR EACH ROW → update_email_sender_addresses_updated_at()<br>trigger_validate_email_matches_domain · BEFORE INSERT OR UPDATE FOR EACH ROW → validate_email_matches_domain() | 4 |
| `holding_email_sender_settings` (0, RLS on) | `holding-email-sender-settings.espejo.ts` · `HoldingEmailSenderSettings` | 13 | `holding_email_sender_settings_pkey` (id) | — | — | `holding_email_sender_settings_created_by_fkey` → users<br>`holding_email_sender_settings_holding_id_fkey` → company_holdings (CASCADE) | `idx_holding_email_sender_active` (parcial), `idx_holding_email_sender_default` (parcial), `idx_holding_email_sender_holding`, `idx_holding_email_sender_status`, `unique_default_domain_per_holding` (UNIQUE, parcial) | trigger_update_holding_email_sender_updated_at · BEFORE UPDATE FOR EACH ROW → update_holding_email_sender_updated_at() | 4 |

Cada espejo contiene, leído en vivo: columnas con tipo real (`timestamp with/without time zone`, `varchar` + `length`, `numeric` + `precision/scale`, enums de Postgres con sus valores, `text[]`, `jsonb`, `uuid`…), nullable, default y comentario; PK con nombre (`primaryKeyConstraintName`); `@Unique`/`@Check`/`@Index` con nombre real (índices parciales con `where`; los índices con expresión, orden u otro método se documentan en el JSDoc pero no se declaran porque `@Index` no los representa); una relación `@ManyToOne` por FK con `onDelete` real y `foreignKeyConstraintName` — hacia la entity existente (`@/modules/...`) si la tabla destino ya la tiene, o hacia el espejo de su módulo; cabecera JSDoc con filas, RLS, comentario de tabla, tablas que la referencian, triggers y policies (nombre, comando, roles). Las expresiones `USING`/`WITH CHECK` de las policies quedan en `scripts/espejo/snapshots/automatizaciones-ia.catalog.json` (`policies_detail`) para el paso 4.

**Cómo están apagados (código técnico)**: el archivo termina en `.espejo.ts`, no en `.entity.ts`. `database.module.ts` carga entities con `entities: [__dirname + '/../../**/*.entity{.ts,.js}']`, así que no los ve, y ningún módulo los incluye en `TypeOrmModule.forFeature([...])`. `database.module.spec.ts` falla si aparece un `.entity.ts` dentro de `entities/<modulo>/`. Para encenderlos en el paso 3: renombrar a `.entity.ts` y registrarlos en el `forFeature` del módulo que los use.

## C · Columnas exactas de cada espejo (10 tablas)

<details><summary><code>ai_agents</code> → <code>ai-agent.espejo.ts</code> · 11 columnas</summary>

| Columna | Tipo Postgres | Nulo | Default | Comentario |
|---|---|---|---|---|
| `id` 🔑 | uuid | no | gen_random_uuid() |  |
| `holding_id` | uuid | no | — |  |
| `type` | text | no | — |  |
| `name` | text | no | — |  |
| `is_enabled` | boolean | no | true |  |
| `schedule` | text | no | — |  |
| `created_by` | uuid | no | — |  |
| `created_at` | timestamp with time zone | no | now() |  |
| `updated_at` | timestamp with time zone | no | now() |  |
| `auto_execute` | boolean | sí | false | Indica si el agente se ejecuta automáticamente según el schedule configurado |
| `require_approval` | boolean | sí | true | Indica si los mensajes generados requieren aprobación manual antes de enviarse |

</details>
<details><summary><code>ai_agent_configs</code> → <code>ai-agent-config.espejo.ts</code> · 6 columnas</summary>

| Columna | Tipo Postgres | Nulo | Default | Comentario |
|---|---|---|---|---|
| `id` 🔑 | uuid | no | gen_random_uuid() |  |
| `agent_id` | uuid | no | — |  |
| `key` | text | no | — |  |
| `value_json` | jsonb | no | — |  |
| `created_at` | timestamp with time zone | no | now() |  |
| `updated_at` | timestamp with time zone | no | now() |  |

</details>
<details><summary><code>client_agent_configs</code> → <code>client-agent-config.espejo.ts</code> · 9 columnas</summary>

| Columna | Tipo Postgres | Nulo | Default | Comentario |
|---|---|---|---|---|
| `id` 🔑 | uuid | no | gen_random_uuid() |  |
| `holding_id` | uuid | no | — | ID del holding al que pertenece la configuración |
| `client_id` | uuid | sí | — | ID del cliente. NULL indica configuración global del holding que aplica a todos los clientes sin configuración personalizada. |
| `agent_type` | text | no | — | Tipo de agente: proforma (solicitud de referencias) o collections (cobranzas) |
| `is_enabled` | boolean | no | true | Si está deshabilitado (false), el cliente no recibirá automatizaciones de este tipo |
| `config_json` | jsonb | no | '{}'::jsonb | Configuración específica en formato JSON. Para proformas: days_before_issue, email_sender_address_id, etc. Para cobranzas: days_overdue_bucket_1, frequency_bucket_1, email_sender_address_id, etc. |
| `created_at` | timestamp with time zone | no | now() |  |
| `updated_at` | timestamp with time zone | no | now() |  |
| `created_by` | uuid | sí | — |  |

</details>
<details><summary><code>agents</code> → <code>agent.espejo.ts</code> · 10 columnas</summary>

| Columna | Tipo Postgres | Nulo | Default | Comentario |
|---|---|---|---|---|
| `id` 🔑 | uuid | no | gen_random_uuid() |  |
| `company_id` | uuid | sí | — |  |
| `name` | text | sí | — |  |
| `description` | text | sí | — |  |
| `type` | text | sí | — |  |
| `is_active` | boolean | sí | true |  |
| `last_activity` | text | sí | — |  |
| `last_activity_at` | timestamp without time zone | sí | — |  |
| `created_at` | timestamp without time zone | sí | now() |  |
| `holding_id` | uuid | sí | — |  |

</details>
<details><summary><code>agent_logs</code> → <code>agent-log.espejo.ts</code> · 6 columnas</summary>

| Columna | Tipo Postgres | Nulo | Default | Comentario |
|---|---|---|---|---|
| `id` 🔑 | uuid | no | gen_random_uuid() |  |
| `agent_id` | uuid | sí | — |  |
| `user_id` | uuid | sí | — |  |
| `activity` | text | sí | — |  |
| `executed_at` | timestamp without time zone | sí | now() |  |
| `holding_id` | uuid | sí | — |  |

</details>
<details><summary><code>ai_runs</code> → <code>ai-run.espejo.ts</code> · 10 columnas</summary>

| Columna | Tipo Postgres | Nulo | Default | Comentario |
|---|---|---|---|---|
| `id` 🔑 | uuid | no | gen_random_uuid() |  |
| `agent_id` | uuid | no | — |  |
| `started_at` | timestamp with time zone | no | now() |  |
| `ended_at` | timestamp with time zone | sí | — |  |
| `status` | text | no | — |  |
| `stats_json` | jsonb | sí | — |  |
| `approver_user_id` | uuid | sí | — |  |
| `error_message` | text | sí | — |  |
| `created_at` | timestamp with time zone | no | now() |  |
| `holding_id` | uuid | no | — | ID del holding al que pertenece esta ejecución |

</details>
<details><summary><code>ai_messages</code> → <code>ai-message.espejo.ts</code> · 9 columnas</summary>

| Columna | Tipo Postgres | Nulo | Default | Comentario |
|---|---|---|---|---|
| `id` 🔑 | uuid | no | gen_random_uuid() |  |
| `run_id` | uuid | no | — |  |
| `direction` | text | no | — |  |
| `channel` | text | no | — |  |
| `to` | text | sí | — |  |
| `subject` | text | sí | — |  |
| `body` | text | sí | — |  |
| `meta_json` | jsonb | sí | — |  |
| `created_at` | timestamp with time zone | no | now() |  |

</details>
<details><summary><code>rag_documents</code> → <code>rag-document.espejo.ts</code> · 9 columnas</summary>

| Columna | Tipo Postgres | Nulo | Default | Comentario |
|---|---|---|---|---|
| `id` 🔑 | uuid | no | gen_random_uuid() |  |
| `holding_id` | uuid | no | — |  |
| `source_type` | text | no | — |  |
| `source_id` | text | sí | — |  |
| `content` | text | no | — |  |
| `metadata` | jsonb | no | '{}'::jsonb |  |
| `embedding` | vector | sí | — |  |
| `created_at` | timestamp with time zone | no | now() |  |
| `updated_at` | timestamp with time zone | no | now() |  |

</details>
<details><summary><code>email_sender_addresses</code> → <code>email-sender-address.espejo.ts</code> · 11 columnas</summary>

| Columna | Tipo Postgres | Nulo | Default | Comentario |
|---|---|---|---|---|
| `id` 🔑 | uuid | no | gen_random_uuid() |  |
| `domain_config_id` | uuid | no | — |  |
| `from_name` | text | no | — | Nombre del remitente (ej: Cobranza Sapira) |
| `from_email` | text | no | — | Email del remitente, debe pertenecer al dominio |
| `reply_to_email` | text | sí | — | Email de respuesta opcional |
| `is_default` | boolean | no | false |  |
| `is_active` | boolean | no | true |  |
| `purpose` | text | sí | — | Propósito del remitente (cobranzas, notificaciones, etc) |
| `created_at` | timestamp with time zone | no | now() |  |
| `updated_at` | timestamp with time zone | no | now() |  |
| `created_by` | uuid | sí | — |  |

</details>
<details><summary><code>holding_email_sender_settings</code> → <code>holding-email-sender-settings.espejo.ts</code> · 13 columnas</summary>

| Columna | Tipo Postgres | Nulo | Default | Comentario |
|---|---|---|---|---|
| `id` 🔑 | uuid | no | gen_random_uuid() |  |
| `holding_id` | uuid | no | — |  |
| `sender_domain` | text | no | — | Dominio o subdominio para envío (ej: mail.miempresa.com) |
| `resend_domain_id` | text | sí | — | ID del dominio en Resend API |
| `domain_status` | text | no | 'pending'::text | Estado de verificación: pending, verified, failed |
| `domain_dns_records` | jsonb | sí | — | Registros DNS provistos por Resend (DKIM, SPF, DMARC) |
| `domain_verified_at` | timestamp with time zone | sí | — |  |
| `created_at` | timestamp with time zone | no | now() |  |
| `updated_at` | timestamp with time zone | no | now() |  |
| `created_by` | uuid | sí | — |  |
| `is_default` | boolean | no | false | Dominio por defecto para el holding |
| `is_active` | boolean | no | true | Si el dominio está activo para uso |
| `display_name` | text | sí | — | Nombre descriptivo del dominio |

</details>

## Verificación (sin conexión a la DB)

- `automatizaciones-ia.entities.spec.ts`: metadata TypeORM en memoria vs `automatizaciones-ia.prod-snapshot.ts` — columnas + nullabilidad, PK, FKs (tabla y ON DELETE), UNIQUE, CHECK e índices declarables — y que ningún espejo duplica una tabla de `scripts/espejo/existing-entities.json`.
- `../../database.module.spec.ts`: `synchronize: false`, nadie habilita sincronización, ningún `.entity.ts` dentro de `entities/<modulo>/`.
