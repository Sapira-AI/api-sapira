# Módulo 10 · Integraciones — Stripe — 7 tablas de prod (2026-09-23)

> Convención y reglas: `../../README.md`. Rarezas verificadas: `../../NOTAS-ESPEJO.md`. Veredictos de producto: `docs/v2-rediseno/04-spec-modelo-dominio-v2/00-tablas-por-modulo.md` (no aplican en este paso).
> Origen de TODO lo que está en esta carpeta: lectura en vivo de prod `hklompkypzqtglprfobu` vía MCP de Supabase el 2026-09-23 — `list_tables verbose` + `execute_sql` de solo lectura sobre `pg_catalog` (`scripts/espejo/snapshots/integraciones-stripe.{pgmeta,catalog}.json`); metadata real de las entities existentes en `integraciones-stripe.existing.json` (`scripts/espejo/extract-existing-metadata.ts`). Generado con `scripts/espejo/generate-espejo.py`.

## A · Tablas que YA tenían entity en el repo (7) — no se tocaron ni se duplicaron

Estas entities están **prendidas en producción** exactamente como estaban (`database.module.ts` las carga por el glob `src/**/*.entity.ts` y sus módulos las registran en `forFeature`). "Estado vs prod" = diff entre lo que la entity declara hoy (metadata TypeORM real) y la DB en vivo; es el insumo para completarlas en el paso 3 con Leon.

| Tabla (filas) | Entity existente (archivo · clase) | Estado vs prod | Columnas que faltan en la entity | Columnas que sobran | Diferencias en columnas existentes | Constraints / índices / FKs que la entity no declara |
|---|---|---|---|---|---|---|
| `stripe_connections` (1) | `src/databases/postgresql/entities/integraciones/stripe/stripe-connection.entity.ts` · `StripeConnection` | ⚠️ difiere de prod | — | — | — | nombre de PK `stripe_connections_pkey`<br>CHECK `stripe_connections_mode_check` |
| `stripe_customers_stg` (416) | `src/databases/postgresql/entities/integraciones/stripe/stripe-customers-stg.entity.ts` · `StripeCustomersStg` | ⚠️ difiere de prod | — | — | — | nombre de PK `stripe_customers_stg_pkey` |
| `stripe_invoices_stg` (4768) | `src/databases/postgresql/entities/integraciones/stripe/stripe-invoices-stg.entity.ts` · `StripeInvoicesStg` | ⚠️ difiere de prod | — | — | — | nombre de PK `stripe_invoices_stg_pkey` |
| `stripe_subscriptions_stg` (544) | `src/databases/postgresql/entities/integraciones/stripe/stripe-subscriptions-stg.entity.ts` · `StripeSubscriptionsStg` | ⚠️ difiere de prod | — | — | — | nombre de PK `stripe_subscriptions_stg_pkey` |
| `stripe_product_mappings` (73) | `src/databases/postgresql/entities/integraciones/stripe/stripe-product-mapping.entity.ts` · `StripeProductMapping` | ⚠️ difiere de prod | — | — | — | nombre de PK `stripe_product_mappings_pkey` |
| `stripe_sync_jobs` (208) | `src/databases/postgresql/entities/integraciones/stripe/stripe-sync-job.entity.ts` · `StripeSyncJob` | ⚠️ difiere de prod | — | — | — | nombre de PK `stripe_sync_jobs_pkey`<br>índice con expresión `idx_stripe_sync_jobs_created_at` |
| `stripe_customers_bigquery` (26406) | `src/databases/postgresql/entities/integraciones/stripe/stripe-customer-bigquery.entity.ts` · `StripeCustomerBigQuery` | ⚠️ difiere de prod | — | — | — | nombre de PK `stripe_customers_bigquery_pkey` |

## B · Tablas SIN entity previa → espejos generados (0): 0 promovidas, 0 apagadas

Ninguna: todas las tablas de este módulo ya tienen entity en el repo; este módulo solo documenta el diff (sección A). No hay espejos, snapshot ni spec.
