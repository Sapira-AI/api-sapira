# Módulo 4 · Cotizaciones y catálogo — 5 tablas de prod (2026-08-22)

> Convención y reglas: `../README.md`. Rarezas verificadas: `../NOTAS-ESPEJO.md`. Veredictos de producto: `docs/v2-rediseno/04-spec-modelo-dominio-v2/00-tablas-por-modulo.md` (no aplican en este paso).
> Origen de TODO lo que está en esta carpeta: lectura en vivo de prod `hklompkypzqtglprfobu` vía MCP de Supabase el 2026-08-22 — `list_tables verbose` + `execute_sql` de solo lectura sobre `pg_catalog` (`scripts/espejo/snapshots/cotizaciones-catalogo.{pgmeta,catalog}.json`); metadata real de las entities existentes en `cotizaciones-catalogo.existing.json` (`scripts/espejo/extract-existing-metadata.ts`). Generado con `scripts/espejo/generate-espejo.py`.

## A · Tablas que YA tenían entity en el repo (4) — no se tocaron ni se duplicaron

Estas entities están **prendidas en producción** exactamente como estaban (`database.module.ts` las carga por el glob `src/**/*.entity.ts` y sus módulos las registran en `forFeature`). "Estado vs prod" = diff entre lo que la entity declara hoy (metadata TypeORM real) y la DB en vivo; es el insumo para completarlas en el paso 3 con Leon.

| Tabla (filas) | Entity existente (archivo · clase) | Estado vs prod | Columnas que faltan en la entity | Columnas que sobran | Diferencias en columnas existentes | Constraints / índices / FKs que la entity no declara |
|---|---|---|---|---|---|---|
| `quotes` (345) | `src/modules/salesforce/entities/quote.entity.ts` · `Quote` | ⚠️ difiere de prod | — | — | `client_id`: NOT NULL en la entity vs nullable en DB<br>`created_at`: default `CURRENT_TIMESTAMP` vs DB `now()` | nombre de PK `quotes_pkey`<br>FK `quotes_client_contact_id_fkey` → client_contacts<br>FK `quotes_client_id_fkey` → clients ON DELETE CASCADE<br>FK `fk_quotes_holding_id` → company_holdings ON DELETE CASCADE<br>FK `quotes_seller_id_fkey1` → sellers<br>FK `fk_quotes_stage` → quote_stages<br>índice `idx_quotes_holding_id`<br>índice `idx_quotes_quote_number`<br>índice `idx_quotes_salesforce_opportunity_id` (parcial)<br>índice `idx_quotes_salesforce_opportunity_unique` (UNIQUE, parcial) |
| `quote_items` (409) | `src/modules/salesforce/entities/quote-item.entity.ts` · `QuoteItem` | ⚠️ difiere de prod | — | — | `holding_id`: default `None` vs DB `gen_random_uuid()` | nombre de PK `quote_items_pkey`<br>CHECK `chk_quote_items_price_entry_mode`<br>CHECK `quote_items_billing_frequency_check`<br>CHECK `quote_items_billing_method_check`<br>CHECK `quote_items_discount_type_check`<br>FK `quote_items_product_id_fkey` → products<br>FK `fk_quote_items_holding_id` → company_holdings ON DELETE CASCADE<br>FK `quote_items_quote_id_fkey` → quotes ON DELETE CASCADE<br>índice `idx_quote_items_holding_id`<br>índice `idx_quote_items_quote_item_number` (parcial)<br>índice `idx_quote_items_quote_item_number_unique` (UNIQUE, parcial)<br>índice `idx_quote_items_salesforce_line_item_id` (parcial)<br>índice `idx_quote_items_salesforce_line_item_unique` (UNIQUE, parcial)<br>índice `idx_quote_items_sf_product` (parcial)<br>índice con expresión `idx_quote_items_custom_fields` |
| `quote_stages` (43) | `src/modules/salesforce/entities/quote-stage.entity.ts` · `QuoteStage` | ⚠️ difiere de prod | — | — | — | nombre de PK `quote_stages_pkey`<br>UNIQUE `quote_stages_holding_id_name_key` (holding_id, name)<br>UNIQUE `quote_stages_holding_id_position_key` (holding_id, position)<br>FK `quote_stages_holding_id_fkey` → company_holdings ON DELETE CASCADE |
| `products` (76) | `src/modules/odoo/entities/products.entity.ts` · `Product` | ⚠️ difiere de prod | — | — | `created_at`: NOT NULL en la entity vs nullable en DB<br>`created_at`: default `CURRENT_TIMESTAMP` vs DB `now()` | nombre de PK `products_pkey`<br>FK `products_holding_id_fkey` → company_holdings<br>índice `idx_products_odoo_product_id` (parcial)<br>índice `idx_products_odoo_tax_ids` (parcial)<br>índice `idx_products_product_code`<br>índice `idx_products_salesforce_product_id`<br>índice `idx_products_stripe_product_id` (parcial) |

## B · Tablas SIN entity → espejos creados (1), APAGADOS

| Tabla (filas, RLS) | Espejo · clase | Cols | PK | UNIQUE | CHECK | FKs (→ tabla, ON DELETE) | Índices | Triggers | Policies |
|---|---|---|---|---|---|---|---|---|---|
| `quote_attachments` (0, RLS on) | `quote-attachment.espejo.ts` · `QuoteAttachment` | 11 | `quote_attachments_pkey` (id) | — | `quote_attachments_attachment_type_check` | `quote_attachments_quote_id_fkey` → quotes (CASCADE)<br>`quote_attachments_uploaded_by_fkey` → users | `idx_quote_attachments_attachment_type`, `idx_quote_attachments_holding_id`, `idx_quote_attachments_quote_id` | — | 4 |

Cada espejo contiene, leído en vivo: columnas con tipo real (`timestamp with/without time zone`, `varchar` + `length`, `numeric` + `precision/scale`, enums de Postgres con sus valores, `text[]`, `jsonb`, `uuid`…), nullable, default y comentario; PK con nombre (`primaryKeyConstraintName`); `@Unique`/`@Check`/`@Index` con nombre real (índices parciales con `where`; los índices con expresión, orden u otro método se documentan en el JSDoc pero no se declaran porque `@Index` no los representa); una relación `@ManyToOne` por FK con `onDelete` real y `foreignKeyConstraintName` — hacia la entity existente (`@/modules/...`) si la tabla destino ya la tiene, o hacia el espejo de su módulo; cabecera JSDoc con filas, RLS, comentario de tabla, tablas que la referencian, triggers y policies (nombre, comando, roles). Las expresiones `USING`/`WITH CHECK` de las policies quedan en `scripts/espejo/snapshots/cotizaciones-catalogo.catalog.json` (`policies_detail`) para el paso 4.

**Cómo están apagados (código técnico)**: el archivo termina en `.espejo.ts`, no en `.entity.ts`. `database.module.ts` carga entities con `entities: [__dirname + '/../../**/*.entity{.ts,.js}']`, así que no los ve, y ningún módulo los incluye en `TypeOrmModule.forFeature([...])`. `database.module.spec.ts` falla si aparece un `.entity.ts` dentro de `entities/<modulo>/`. Para encenderlos en el paso 3: renombrar a `.entity.ts` y registrarlos en el `forFeature` del módulo que los use.

## C · Columnas exactas de cada espejo (1 tablas)

<details><summary><code>quote_attachments</code> → <code>quote-attachment.espejo.ts</code> · 11 columnas</summary>

| Columna | Tipo Postgres | Nulo | Default | Comentario |
|---|---|---|---|---|
| `id` 🔑 | uuid | no | gen_random_uuid() |  |
| `quote_id` | uuid | no | — |  |
| `file_name` | text | no | — |  |
| `file_url` | text | no | — |  |
| `file_type` | text | sí | — |  |
| `file_size` | integer | sí | — |  |
| `attachment_type` | text | no | — | Tipo: acceptance (aceptación cliente), purchase_order (OC), hes (HES), contract, other |
| `uploaded_by` | uuid | sí | — |  |
| `uploaded_at` | timestamp with time zone | sí | now() |  |
| `holding_id` | uuid | no | — |  |
| `created_at` | timestamp with time zone | sí | now() |  |

</details>

## Verificación (sin conexión a la DB)

- `cotizaciones-catalogo.entities.spec.ts`: metadata TypeORM en memoria vs `cotizaciones-catalogo.prod-snapshot.ts` — columnas + nullabilidad, PK, FKs (tabla y ON DELETE), UNIQUE, CHECK e índices declarables — y que ningún espejo duplica una tabla de `scripts/espejo/existing-entities.json`.
- `../../database.module.spec.ts`: `synchronize: false`, nadie habilita sincronización, ningún `.entity.ts` dentro de `entities/<modulo>/`.
