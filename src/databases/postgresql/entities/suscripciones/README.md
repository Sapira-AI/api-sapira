# Módulo 12 · Suscripciones (Stripe) — 2 tablas de prod (2026-08-22)

> Convención y reglas: `../README.md`. Rarezas verificadas: `../NOTAS-ESPEJO.md`. Veredictos de producto: `docs/v2-rediseno/04-spec-modelo-dominio-v2/00-tablas-por-modulo.md` (no aplican en este paso).
> Origen de TODO lo que está en esta carpeta: lectura en vivo de prod `hklompkypzqtglprfobu` vía MCP de Supabase el 2026-08-22 — `list_tables verbose` + `execute_sql` de solo lectura sobre `pg_catalog` (`scripts/espejo/snapshots/suscripciones.{pgmeta,catalog}.json`); metadata real de las entities existentes en `suscripciones.existing.json` (`scripts/espejo/extract-existing-metadata.ts`). Generado con `scripts/espejo/generate-espejo.py`.

## A · Tablas que YA tenían entity en el repo (0) — no se tocaron ni se duplicaron

Ninguna: todas las tablas de este módulo carecían de entity.

## B · Tablas SIN entity → espejos creados (2), APAGADOS

| Tabla (filas, RLS) | Espejo · clase | Cols | PK | UNIQUE | CHECK | FKs (→ tabla, ON DELETE) | Índices | Triggers | Policies |
|---|---|---|---|---|---|---|---|---|---|
| `subscriptions` (434, RLS on) | `subscription.espejo.ts` · `Subscription` | 31 | `subscriptions_pkey` (id) | `uq_subscriptions_holding_external` | `subscriptions_status_check` | `subscriptions_company_id_fkey` → companies (RESTRICT)<br>`subscriptions_holding_id_fkey` → company_holdings (CASCADE)<br>`subscriptions_connection_id_fkey` → stripe_connections<br>`subscriptions_client_entity_id_fkey` → client_entities (RESTRICT)<br>`subscriptions_client_id_fkey` → clients (RESTRICT) | `idx_subscriptions_client_entity_id`, `idx_subscriptions_client_id`, `idx_subscriptions_company_id`, `idx_subscriptions_connection_id`, `idx_subscriptions_external_id`, `idx_subscriptions_holding_id`, `idx_subscriptions_source`, `idx_subscriptions_status` | update_subscriptions_updated_at · BEFORE UPDATE FOR EACH ROW → update_stripe_updated_at_column() | 4 |
| `subscription_items` (456, RLS on) | `subscription-item.espejo.ts` · `SubscriptionItem` | 28 | `subscription_items_pkey` (id) | `uq_subscription_items_holding_external` | — | `subscription_items_holding_id_fkey` → company_holdings (CASCADE)<br>`subscription_items_subscription_id_fkey` → subscriptions (CASCADE)<br>`subscription_items_product_id_fkey` → products (RESTRICT) | `idx_subscription_items_external_id`, `idx_subscription_items_holding_id`, `idx_subscription_items_product_id`, `idx_subscription_items_stripe_product_id`, `idx_subscription_items_subscription_id` | update_subscription_items_updated_at · BEFORE UPDATE FOR EACH ROW → update_stripe_updated_at_column() | 4 |

Cada espejo contiene, leído en vivo: columnas con tipo real (`timestamp with/without time zone`, `varchar` + `length`, `numeric` + `precision/scale`, enums de Postgres con sus valores, `text[]`, `jsonb`, `uuid`…), nullable, default y comentario; PK con nombre (`primaryKeyConstraintName`); `@Unique`/`@Check`/`@Index` con nombre real (índices parciales con `where`; los índices con expresión, orden u otro método se documentan en el JSDoc pero no se declaran porque `@Index` no los representa); una relación `@ManyToOne` por FK con `onDelete` real y `foreignKeyConstraintName` — hacia la entity existente (`@/modules/...`) si la tabla destino ya la tiene, o hacia el espejo de su módulo; cabecera JSDoc con filas, RLS, comentario de tabla, tablas que la referencian, triggers y policies (nombre, comando, roles). Las expresiones `USING`/`WITH CHECK` de las policies quedan en `scripts/espejo/snapshots/suscripciones.catalog.json` (`policies_detail`) para el paso 4.

**Cómo están apagados (código técnico)**: el archivo termina en `.espejo.ts`, no en `.entity.ts`. `database.module.ts` carga entities con `entities: [__dirname + '/../../**/*.entity{.ts,.js}']`, así que no los ve, y ningún módulo los incluye en `TypeOrmModule.forFeature([...])`. `database.module.spec.ts` falla si aparece un `.entity.ts` dentro de `entities/<modulo>/`. Para encenderlos en el paso 3: renombrar a `.entity.ts` y registrarlos en el `forFeature` del módulo que los use.

## C · Columnas exactas de cada espejo (2 tablas)

<details><summary><code>subscriptions</code> → <code>subscription.espejo.ts</code> · 31 columnas</summary>

| Columna | Tipo Postgres | Nulo | Default | Comentario |
|---|---|---|---|---|
| `id` 🔑 | uuid | no | gen_random_uuid() |  |
| `holding_id` | uuid | no | — |  |
| `company_id` | uuid | no | — |  |
| `client_id` | uuid | no | — |  |
| `client_entity_id` | uuid | no | — |  |
| `client_name_commercial` | text | sí | — |  |
| `legal_client_name` | text | sí | — |  |
| `external_id` | text | no | — | ID de la suscripción en el sistema externo (ej: sub_xxx para Stripe) |
| `source` | text | no | 'stripe'::text | Sistema origen: stripe, chargebee, etc. Extensible para futuras integraciones. |
| `connection_id` | uuid | sí | — |  |
| `status` | text | no | — |  |
| `start_date` | timestamp with time zone | sí | — |  |
| `canceled_at` | timestamp with time zone | sí | — |  |
| `cancel_at_period_end` | boolean | sí | false |  |
| `ended_at` | timestamp with time zone | sí | — |  |
| `current_period_start` | date | sí | — |  |
| `current_period_end` | date | sí | — |  |
| `billing_cycle_anchor` | timestamp with time zone | sí | — |  |
| `cancellation_reason` | text | sí | — |  |
| `cancellation_comment` | text | sí | — |  |
| `currency` | text | no | 'USD'::text |  |
| `monthly_amount` | numeric(18,2) | sí | 0 | Suma de monthly_amount de todos los subscription_items activos |
| `collection_method` | text | sí | 'charge_automatically'::text |  |
| `system_currency` | text | sí | 'USD'::text |  |
| `fx_to_system` | numeric(18,6) | sí | 1 | Tipo de cambio de currency a system_currency. Default 1 cuando son iguales. |
| `monthly_amount_system_currency` | numeric(18,2) | sí | 0 |  |
| `notes` | text | sí | — | Campo libre editable por usuario de Sapira (único campo editable) |
| `metadata` | jsonb | sí | '{}'::jsonb |  |
| `created_at` | timestamp with time zone | sí | now() |  |
| `updated_at` | timestamp with time zone | sí | now() |  |
| `last_synced_at` | timestamp with time zone | sí | — |  |

</details>
<details><summary><code>subscription_items</code> → <code>subscription-item.espejo.ts</code> · 28 columnas</summary>

| Columna | Tipo Postgres | Nulo | Default | Comentario |
|---|---|---|---|---|
| `id` 🔑 | uuid | no | gen_random_uuid() |  |
| `subscription_id` | uuid | no | — |  |
| `holding_id` | uuid | no | — |  |
| `external_id` | text | no | — |  |
| `stripe_product_id` | text | sí | — | ID del producto en Stripe (ej: prod_xxx). Usado para mapeo via stripe_product_mappings. |
| `stripe_price_id` | text | sí | — | ID del precio/plan en Stripe (ej: pay_per_vehicle_2025). |
| `product_id` | uuid | sí | — |  |
| `product_name` | text | sí | — |  |
| `item_type` | text | sí | 'Digital'::text | Tipo fijo para filtros y análisis MRR (ej: Digital). Desde Master Data. |
| `quantity` | numeric(18,4) | sí | 1 |  |
| `unit_price` | numeric(18,6) | sí | 0 | Precio unitario en la moneda de la suscripción. Ya convertido de centavos para Stripe (÷100). |
| `monthly_amount` | numeric(18,2) | sí | 0 | Calculado: quantity × unit_price |
| `currency` | text | sí | 'USD'::text |  |
| `system_currency` | text | sí | 'USD'::text |  |
| `fx_to_system` | numeric(18,6) | sí | 1 |  |
| `unit_price_system_currency` | numeric(18,6) | sí | 0 |  |
| `monthly_amount_system_currency` | numeric(18,2) | sí | 0 |  |
| `billing_scheme` | text | sí | — |  |
| `interval` | text | sí | 'month'::text |  |
| `interval_count` | integer | sí | 1 |  |
| `current_period_start` | date | sí | — |  |
| `current_period_end` | date | sí | — |  |
| `start_date` | date | sí | — |  |
| `canceled_at` | timestamp with time zone | sí | — |  |
| `discounts` | jsonb | sí | '[]'::jsonb |  |
| `metadata` | jsonb | sí | '{}'::jsonb |  |
| `created_at` | timestamp with time zone | sí | now() |  |
| `updated_at` | timestamp with time zone | sí | now() |  |

</details>

## Verificación (sin conexión a la DB)

- `suscripciones.entities.spec.ts`: metadata TypeORM en memoria vs `suscripciones.prod-snapshot.ts` — columnas + nullabilidad, PK, FKs (tabla y ON DELETE), UNIQUE, CHECK e índices declarables — y que ningún espejo duplica una tabla de `scripts/espejo/existing-entities.json`.
- `../../database.module.spec.ts`: `synchronize: false`, nadie habilita sincronización, ningún `.entity.ts` dentro de `entities/<modulo>/`.
