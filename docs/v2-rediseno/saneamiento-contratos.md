# Saneamiento de Contratos (bloque previo al módulo `contracts`)

> Desde el 24-09-2026 · Domi + Claude. Criterio rector (14-09): **ningún módulo pasa al front nuevo sucio**; el paso 0
> de cada módulo es sanear su familia de funciones. Diagnóstico y decisiones: [`auditoria-contratos.md`](./auditoria-contratos.md).
> Este documento es el **registro de lo ejecutado** y la lista de la **segunda capa** (lo que cambia al pasar al front nuevo).

## Reglas del bloque

- El front viejo (`sapira-ai`, `app.aisapira.com`) **sigue funcionando**: todo lo que usa se mantiene compatible.
- Esquema solo como código en `api-sapira` (migraciones + assets), primero QA y después producción con OK de Domi.
- No se tocan datos de clientes en producción (filas, contratos concretos): Domi los revisa caso a caso.
- **Retiro con doble confirmación** (sin ventana de observación, decisión de Domi 24-09: el front viejo se reemplaza en
  semanas): (1) código — ningún llamador alcanzable en los tres repos, ni función, trigger o `cron.job` que la use;
  (2) uso real — 0 llamadas en los logs del gateway (`/rest/v1/rpc/<nombre>`) de los últimos 30 días.

## Capa 1 · Ejecutado

### 1. Retiro de funciones sin uso (24-09)

| Qué | Dónde |
|---|---|
| `DROP` de 14 firmas: `create_contract_renewal` **v1** (la v2 se queda), `create_contract_upsell`, `create_contract_downsell`, `create_contract_churn`, `register_item_non_renewal`, `migrate_contracts_to_new_workflow`, `get_contract_reconciliation`, `activate_legacy_contract`, `validate_legacy_activation`, `derive_contract_items_from_legacy`, `confirm_legacy_invoice_reconciliation` ×2, `bulk_reconcile_legacy_invoices` ×2 | migración `1790292150143-RetiraFuncionesContratosYLegacyMuertas` + 11 assets borrados de `functions/` + v1 quitada de `functions/create_contract_renewal.sql` |
| `recalc_revenue_for_contract`: sin `EXECUTE` para PUBLIC/anon/authenticated (la sigue llamando `approve_contract_amendment`, cross-sell vivo) | `grants/020-contracts-internal-functions-execute.sql` |
| Código muerto del front viejo: 3 paneles legacy sin montar (`ContractActivationPanel`, `ContractLegacyAnalysisPanel`, `LegacyInvoiceReconciliationTable`) con sus hooks, servicio, tipos y `README_RECONCILIACION_MASIVA.md`; `WorkflowDashboard` + `WorkflowMigrationCard` + `useMigrateContracts`; `ContratosGlobalReconciliation` + `ContractReconciliationModal` + `useContractReconciliation`; `AmendmentApprovalsModal` + `useAmendmentApprovals`; `DownSellingModal`; mutaciones sin consumidor de `useContractAmendments` (`createUpsell`, `createDownsell`, `createChurn`, `registerNonRenewal`, `createAmendmentWithInvoices`) | `sapira-ai/src/components/contratos/**` |

**Evidencia**: grep en `sapira-ai`, `api-sapira`, `front-sapira`; cadena de imports hasta una página (ninguna llega); en
prod `pg_proc.prosrc` (única dependencia interna: `activate_legacy_contract` → `validate_legacy_activation`, ambas salen;
el cron de auto-renovación usa la v2 de renovación), `pg_trigger`, `cron.job`; logs del gateway 25-08 → 24-09 con los 30
días con datos: 0 llamadas a las 14 firmas y a `recalc_revenue_for_contract` (`create_contract_renewal`: 11, todas v2).
Verificación: `vite build` del front viejo OK, `tsc` sin errores nuevos (los 96 existentes no tocan estos archivos),
tests de `src/databases/postgresql` 617/617.

**Estado**: ✅ QA y ✅ producción (24-09). En ambas, `schema:status` final: 0 migraciones pendientes, 857 assets
aplicados, 0 "solo en la base"; verificado en el catálogo que las 14 firmas no existen, que la v2 de renovación y sus
llamadores (auto-renovación, cross-sell, `approve_contract_amendment`) siguen, y que `recalc_revenue_for_contract` ya no
es ejecutable por `anon`/`authenticated` (su llamador corre como `postgres`). Snapshot de prod refrescado: solo cambia el
catálogo de funciones (las 14) y el conteo de `sapira_typeorm_migrations`; ningún `*.prod-snapshot.ts`. Front viejo:
commit `d0a98ae` en `sapira-ai` (se puede desplegar en cualquier orden: lo borrado no era alcanzable).

### 2. Modelo FX v2: `purpose` en tasas de contrato y dirección única (28-09, código listo, sin aplicar)

- Migración `1790610000000-AddFxRatePurposeAndCompanyFxPolicy`: `contract_fx_period_rates.purpose` (company | invoice,
  default company) + índice (contract_id, purpose); `companies.fx_company_policy` (monthly_avg). `down()` se niega si
  ya hay tasas `invoice`.
- Assets: `revenue_schedule_apply_fx_for_contract` (fixed_period: directa × tasa, inversa 1/tasa, solo `company`),
  `calculate_contract_fx_rate` y `bulk_confirm_fx_policy` (solo `company`). Firmas sin cambios.
- Migración de datos `1790610000001-FixHankaCompanyFxRatesDirection`: 5 tasas CLF → CLP de Hanka Robotics
  (CTR-2025-004, -007, -009, CTR-2026-007) de 0.000025 a 40.000 + rebuild del RSM. Solo corre con el asset nuevo
  aplicado (si no, aborta y queda pendiente); idempotente; `down()` simétrico. SimpliRoute CTR-2026-215 fuera.
- Pendiente fuera de este repo: el front viejo (`useContractFxRates`, `ContractFxCompanyConfig`) lee todas las filas de
  `contract_fx_period_rates`; con tasas `invoice` las mostraría como de compañía. Filtrar `purpose = 'company'` allá.
- Detalle: `mapa-v2-contratos.md` §3b.

### 3. Alta v2: catálogo de documentos tributarios, condiciones de factura y edición de borrador (28-09, código listo, sin aplicar)

- Migración `1790620000000-CreateTaxDocumentTypes`: tabla `tax_document_types` (UNIQUE país+código, CHECK de `kind`,
  índice país+activo, RLS activo) y `contracts.tax_document_type_id` (FK + índice). `down()` quita la columna y la tabla;
  `document_type` conserva la familia, así que no se pierde la decisión fiscal.
- Assets: `seed/003-tax-document-types.sql` (17 filas: CL, PE, MX, CO y genéricos `*`; idempotente) y
  `rls/tax_document_types_select_authenticated.sql` (solo lectura; no hay policy de escritura a propósito).
- Orden: migración → `postgres:assets --only seed/003-tax-document-types.sql --only rls/tax_document_types_select_authenticated.sql`
  → código. Sin la migración, `form-options`, crear, activar y el 360 fallan (consultan la tabla); sin el seed, el catálogo
  viene vacío y la creación cae al tipo de documento sugerido por país, como antes.
- Endpoints nuevos: `GET /contracts/:id/form`, `PUT /contracts/:id`, `PATCH /contracts/:id/terms`; `form-options` con
  `?client_entity_id`. Eventos nuevos en `contract_lifecycle_events`: `DRAFT_UPDATED`, `TERMS_UPDATED`.
- Verificado en QA (solo lectura, 28-09): FKs hacia `contract_items` — `invoice_items` (SET NULL), `quantities` y
  `invoice_items_legacy_match` (CASCADE), `revenue_schedule_monthly` y `contract_amendment_items` (NO ACTION),
  `sapira_quantity_imports` (SET NULL), auto-FKs de renovación/relación (NO ACTION / SET NULL). No existe ninguna tabla
  `*_detail*`. Por eso `PUT` exige borrador sin facturas y rechaza quitar ítems con `quantities` (409); RSM y amendments no
  existen en un borrador (`trigger_rsm_on_contract_item_change` sale si el contrato no está Activo).
- Trigger de condiciones: `invoices_fill_terms_from_contract_trigger` es **BEFORE INSERT** en `invoices`; el `PATCH` de
  condiciones no toca facturas existentes (documentado en la respuesta y en el mapa §2b). Los triggers no se modifican.
- Pendiente: `contratos.entities.spec` no cambia (la entity `Contract` no es espejo); la tabla nueva se mide con
  `tax-document-type.entity.spec.ts` hasta que exista en prod. `database.module.spec` sigue en rojo por
  `holding_integration_settings` (tabla del catálogo sin entity, ajena a este bloque).
- Detalle funcional: `mapa-v2-contratos.md` §2b (bloque "Alta v2") y §6.

### 4. Pricing v2 etapas 1 y 2: modelos de precio, tramos y consumo (28-09, código listo, sin aplicar)

- Spec: [`spec-pricing-v2.md`](./spec-pricing-v2.md); qué se construyó: [`mapa-v2-contratos.md`](./mapa-v2-contratos.md) §2f.
- Migración `1790630000000-CreatePricingV2`: tablas `billable_metrics`, `prices` (con `invoice_line_mode` y
  `charge_flat_when_free`, spec §3.8/§3.5), `consumption_entries` (con `invoice_id` → factura que lleva el consumo, spec §4.4),
  `consumption_entry_revisions` (RLS activo), `contract_items.price_id` (FK + índice), `invoice_items.pricing_breakdown` y
  `quantity_source` (CHECK), y `invoice_items_quantity_check` de `> 0` a `>= 0` (un consumo 0 deja la línea en 0, spec §2.3;
  única transición sobre un objeto existente; el `down()` la revierte y falla a propósito si ya hay líneas en 0).
- Assets: `rls/holding_access_billable_metrics.sql`, `rls/holding_access_prices.sql`, `rls/holding_access_consumption_entries.sql`,
  `rls/holding_access_consumption_entry_revisions.sql` (espejo de `holding_access_contract_items`). Ningún trigger, función
  ni seed nuevo. Inventario: `espejo.existing.ts`, `scripts/espejo/existing-entities.json`, `module-map.json`, README (393 rls).
- Orden: migración `1790620000000` (documentos tributarios) → migración `1790630000000` → `postgres:assets --only` de las 4
  policies → código. Sin la migración, crear/editar/activar contratos con `price` y todo `/consumption` y `/billable-metrics`
  fallan (consultan las tablas); los contratos sin `price` siguen igual.
- Endpoints nuevos: `POST /contracts/price-preview`; `items[].price` en crear/preview/editar y `form`; `PUT
  /contracts/:id/items/:itemId/consumption/:periodStart`, `POST /contracts/:id/consumption/preview`, `POST
  /contracts/:id/consumption/bulk`, `GET /contracts/:id/consumption` (rehecho), `GET /contracts/:id/consumption/pending`,
  `GET /consumption/pending`; `GET/POST /billable-metrics`, `GET/PATCH /billable-metrics/:id`, `POST /billable-metrics/:id/archive`.
  Eventos nuevos en `contract_lifecycle_events`: `PRICE_CHANGED`, `CONSUMPTION_RECORDED`, `CONSUMPTION_CORRECTED`.
- Verificado en QA (solo lectura, 28-09): triggers de `invoice_items` (4: dos BEFORE INSERT, `sync_invoice_item_contract_id`
  BEFORE INSERT OR UPDATE que sale con `contract_item_id` puesto, `update_invoice_items_updated_at` BEFORE UPDATE) y de
  `invoices` (6; en el UPDATE del encabezado recalcula moneda del sistema `auto_populate_invoice_fx_to_system`; el RSM no
  se dispara para Por Emitir, por eso `revenue_schedule_rebuild(contrato, mes)` es explícito). `invoice_items_quantity_check`
  es `> 0` en QA (motivo del cambio). Ninguna función de QA lee `sapira.writer`. Las tablas y columnas nuevas no existen
  en QA. `quantities` no se escribe desde v2 (§7): `GET /:id/consumption` la lee como `source = legacy`.
- Specs en rojo esperados hasta aplicar y refrescar el snapshot de prod: `contratos.entities.spec` (`contract_items` suma
  `price_id`, FK e índice). `invoice_items` no es espejo (sin snapshot). `database.module.spec` sigue en rojo por
  `holding_integration_settings` (ajeno). La tabla nueva se mide con `pricing-v2.entity.spec.ts`.
- Pendiente (canal DWH): `bigquery.service.ts` escribiendo `consumption_entries` con `source = dwh` e `idempotency_key`;
  migración de `quantities` al switch (§7). El catálogo versionado (etapa 3) quedó en la sección 6.

### 5. Modificaciones de contrato v2: Changes API con vista previa (28-09, código listo, sin esquema nuevo)

- Spec: [`spec-modificaciones-contrato-v2.md`](./spec-modificaciones-contrato-v2.md) §4; qué se construyó y qué queda abierto:
  [`mapa-v2-contratos.md`](./mapa-v2-contratos.md) §2d ("Modificaciones v2 construidas").
- Sin migración ni asset: escribe en `contract_items`, `invoices`, `invoice_items`, `contract_fx_period_rates`, `contracts` y
  `contract_lifecycle_events` con las columnas existentes (`origin`, `Idempotency-Key`, before/after en `metadata`, Supuesto 5).
- Endpoints nuevos: `POST /contracts/:id/changes/preview` (no escribe) y `POST /contracts/:id/changes` (una transacción; 409 `blocked`
  con el preview; 400 con advertencias sin motivo). Tipos: `billing_conditions`, `change_entity`, `item_remove`, `contract_cancel`,
  `renewal` (mismo precio), `item_add` (con `price` inline de Pricing v2 → fila en `prices` + `price_id`), `item_change` (sin frecuencia ni término). `reactivate`/`pause`/`resume`/`price_adjustment` → 400.
- Eventos nuevos: `CONDITIONS_UPDATED`, `ENTITY_CHANGED`; los de ítems usan los tipos normalizados (`UPSELL`, `CROSS_SELL`, `DOWNSELL`,
  `CHURN`, `RENEWAL`) con `event_subtype` (`early`, `non_renewal`, `contract_cancel`, `quantity`, `price`, `RENEGOTIATION`, `mixed`).
- Piezas: `contract-changes.ts` (reglas puras y `planChange`), `contract-changes.service.ts`, `dtos/contract-changes.dto.ts`;
  `insertEngineInvoices`/`insertEngineLines` extraídos de la activación (mismo patrón B), `itemPeriods`/`nextPeriodStart` en el generador,
  `buildItemGroups` ya no cuenta el espejo de una baja cuya base churneó (manual §10). Tests: `contract-changes.spec.ts` (31) y
  `contract-changes.service.spec.ts` (12, QueryRunner simulado: orden ítems → facturas → contrato → RSM → evento, emitidas intocables).
- Triggers que corren al aplicar (verificados en el corpus del repo, no en la base): `trg_set_contract_item_categoria` respeta la
  categoría explícita; `set_contract_item_end_date` recalcula el fin al insertar (por eso el fin explícito se fija con un UPDATE
  posterior); `auto_calculate_pricing_fields` deriva el mensual (`unit × qty` o `final / term` en CHURN/DOWNSELL); guards de período
  se respetan (bloqueo `period_closed` antes de escribir); `prevent_end_date_update_when_active` con `sapira.bypass_end_date_guard`
  solo en la sentencia del fin + evento; `trigger_rsm_on_contract_item_change` puede correr además (U9) y el rebuild explícito manda.
  Ninguna función lee `sapira.writer` todavía; la API igual lo fija.
- Fuera de alcance (ABIERTO en la spec): reactivación, pausa, reajuste, renovación con cambio de precio (S3-15), renegociación de
  frecuencia/término, cambio de moneda del contrato, cliente comercial y compañía emisora. RSM: prorrateo de CHURN y doble prorrateo
  (U5/S5-16) siguen pendientes en `revenue_schedule_rebuild_contract_ccy`.

### 6. Pricing v2 etapa 3: catálogo de precios versionado (28-09, código listo, sin aplicar)

- Spec: [`spec-pricing-v2.md`](./spec-pricing-v2.md) §2.2 y §5 (filas "3 ✅"); qué se construyó: [`mapa-v2-contratos.md`](./mapa-v2-contratos.md) §2f P7.
- Esquema: sin tabla ni migración nueva. La migración **sin aplicar** `1790630000000-CreatePricingV2` suma la columna `prices.notes`
  (text NULL, nota interna de la versión) editada en su lugar junto a `price.entity.ts` y `pricing-v2.entity.spec.ts`; `owner`,
  `version`, `supersedes_price_id` y `list_price_id` ya existían. Sin asset nuevo (`rls/holding_access_prices.sql` cubre el catálogo).
- Endpoints nuevos (`prices.controller.ts`, `SupabaseAuthGuard` + `HoldingScopeGuard`): `GET /prices`, `POST /prices`, `GET /prices/:id`,
  `PATCH /prices/:id`, `POST /prices/:id/publish`, `POST /prices/:id/archive`, `POST /prices/:id/new-version`. Reglas: nace `draft` con
  `version = max(producto + moneda) + 1`; solo el borrador se edita (409); publicar archiva la activa anterior de la misma cadena y fija
  `supersedes_price_id` en una transacción con `FOR UPDATE`; archivar se permite con contratos (conservan su copia) y avisa con
  `contracts_count`. `contracts_count` = contratos no eliminados con `contract_items.price_id` = fila o copia con `list_price_id` = fila.
- `items[].price_id` deja de dar 400 "etapa 3" en `POST /contracts`, `POST /contracts/preview`, `PUT /contracts/:id` e `item_add`
  (`POST /contracts/:id/changes`): el catálogo debe existir en el holding, estar `active`, ser del mismo producto y de la moneda del
  contrato, y no venir junto a `price` (400 `items.N.price_id` / `change.items.N.price_id`); medido + Anticipado → 400 salvo seat, como
  el inline. El contrato recibe su **copia** en `prices` (`owner = contract`, v1, `list_price_id` = catálogo, nombre del catálogo) y
  `contract_items.price_id` apunta a la copia, nunca al catálogo. `GET /contracts/:id/form` devuelve `price` (la copia) y `list_price_id`
  (campo de solo lectura en el DTO; se conserva si vuelve igual); en PUT, otro catálogo o un spec distinto crea la versión siguiente
  de la copia (`supersedes_price_id`, la anterior `archived`, evento `PRICE_CHANGED`).
- Piezas: `catalog-prices.ts` (`loadCatalogPrices`, `catalogPriceErrors`, compartidas por alta y modificaciones), `prices.service.ts`,
  `dtos/price.dto.ts` (`QueryPricesDto` con orden por lista blanca, `CreatePriceDto`, `UpdatePriceDto`, `NewPriceVersionDto`),
  `price-rows.ts` (`list_price_id` en `PRICE_COLUMNS` y `priceSummaryFromRow`), `usesPricingModel` en `create-contract.dto.ts`
  (con `price_id` el `unit_price` deja de ser obligatorio). Tests: `prices.service.spec.ts` (16: SQL de lista y filtros, detalle,
  crear/editar/publicar/archivar/nueva versión, reglas compartidas, DTOs, controlador), `contract-pricing.spec.ts` (+5: validación,
  vista previa, copia al crear, `form` + PUT), `contract-changes.spec.ts` (+1) y `contract-changes.service.spec.ts` (+1) para `item_add`.
- Verificación local (28-09): `tsc`, `eslint` y `jest src/modules/contracts` (19 suites, 449 tests) en verde. El proceso local en
  `:8082` corre `dist/` compilado antes de este cambio: `GET /billable-metrics` → 401 y `GET /prices` → 404 hasta `yarn build` +
  reinicio (no se reinició ni se levantó una segunda instancia: `salesforce-sync-run.worker` escribiría en la base cada segundo).
  El cableado de DI lo cubre `contracts.module.spec.ts` (incluye `PricesController`/`PricesService`).
- Pendiente: pantalla "Planes y precios" en front-sapira (spec §6), tramos en cotizaciones, "a cuáles contratos aplica en la
  renovación" (spec §1), canal DWH (sección 4).

### 7. Cotizaciones v2: módulo `quotes` (28-09, código listo, sin aplicar)

- Mapa: [`mapa-v2-cotizaciones.md`](./mapa-v2-cotizaciones.md) §10 (qué se construyó, supuestos Q-A1..A9 aplicados, formas exactas de la API).
- Esquema aditivo, **sin aplicar en ninguna base**: migración `1790650000000-QuotesV2` (entities primero: `quote_stages.kind` + UNIQUE parcial,
  11 columnas nuevas en `quotes`, `quote_items.price_id`, `prices.quote_id` + `owner = quote` recreando sus dos CHECK, tabla `quote_events`
  con RLS; datos: backfill de `kind` por nombre, sin crear "Contrato creado" donde falta —decidido Domi 29-09—) + 3 assets (`rls/holding_access_quote_events.sql`,
  `triggers/quotes_set_updated_at.sql`, `functions/create_default_quote_stages_for_holding.sql` editada en su lugar). Depende de
  `1790630000000-CreatePricingV2` (crea `prices`). Ninguna migración con `DROP COLUMN`; `down()` honesto.
- Contratos: solo `contract-drafts.service.ts` (`fromQuote` lee `payment_terms_json`, `stage_kind`, `price_id` → `price`;
  `lockQuote` excluye borradas; `markQuoteContractCreated` por `kind` y evento `CONTRACT_CREATED`) y su spec; `pricing-v2.entity.spec.ts`
  por `prices.quote_id`. Nada más del módulo se tocó.
- Verificación local (28-09): `tsc`, `eslint`, `jest src/modules/quotes src/modules/contracts` (24 suites, 483 tests) en verde; QA de solo lectura
  para confirmar el `ILIKE` del backfill contra las 14 etapas reales. El proceso en `:8082` sigue con su `dist/` anterior (sin reinicio).
- Pendiente para el switch: sync SF ignora `deleted_at`; `apply_quote_downsell_to_contract` se retira (§5 del mapa de Contratos); UNIQUE de
  `quote_number` tras resolver duplicados de prod; bulk y `contract-targets`; BFF `app/api/cotizaciones/*` + `/lab/cotizaciones` en front-sapira.
- Q-A4 **decidido por Domi (29-09): no.** La compañía emisora se elige solo al crear el contrato; `quotes.company_id` se retiró de migración,
  entity, DTOs, servicios, `fromQuote` y del front (wizard, filtros, columnas). Bloque "Contrato creado" de la migración: **decidido (29-09),
  no se crea**; "Procesada previamente" (SimpliRoute) se backfillea como `contract_created` y el UNIQUE parcial queda solo para `signed`/`lost`.

### 8. Facturas en el Contrato 360, etapas 1 y 2: enviar al ERP, emisión externa, reprogramar y FX por factura (29-09, código listo, sin esquema)

- Spec: [`spec-facturas-en-contrato-360.md`](./spec-facturas-en-contrato-360.md) §3.1–3.3 y §4 (orden §7, etapas 1 y 2 sin `erp-withdraw`);
  formas exactas y decisiones en [`mapa-v2-contratos.md`](./mapa-v2-contratos.md) §2c F6–F8b y §2e E3.
- **Sin esquema nuevo** (regla dura de Domi 29-09: nunca columnas, funciones ni endpoints que dupliquen algo existente). La primera versión traía
  `1790660000000-InvoiceFxAndErp` (`invoices.fx_policy`, `fx_rate`, `fx_rate_source`, `fx_confirmed_at`, `issued_externally`): se retiró junto con sus
  columnas en la entity y su spec. Reutiliza lo existente: tasa en `invoices.fx_contract_to_invoice` (NULL = spot pendiente, valor = fija), origen en
  `invoice_items.fx_rate_source` + `fx_rate_date` de las líneas recalculadas, confirmación/quién/cuándo en el evento `INVOICE_FX_CHANGED`, emisión
  externa en el evento `INVOICE_ISSUED_EXTERNALLY`. Los campos de respuesta (`fx_policy`, `fx_rate`, `fx_rate_source`, `fx_confirmed_at`,
  `issued_externally`, `erp_sync_state`) son derivados y conservan sus nombres para el front. Nada que aplicar en QA/prod.
- Código: `src/modules/contracts/contract-invoices.ts` (lógica pura: bloqueos, vencimiento, fechas, matemática FX incluida la de
  `apply_fixed_fx_to_contract` para el neto exacto), `contract-invoices.service.ts` (transacción, locks, eventos), `dtos/contract-invoices.dto.ts`,
  12 rutas nuevas en `contracts.controller.ts` (`send-now`, `mark-issued`, `reschedule`, `fx` por factura y `reschedule-bulk`, `fx-bulk`, cada una con
  `/preview`), `ContractsModule` importa `InvoicesModule`; `invoice-scheduler.service.ts` suma `sendInvoiceById` (envío puntual reutilizando
  `sendInvoiceToOdoo`) y el guard U12/B3 sobre datos existentes (contrato `fixed` + monedas distintas + `fx_contract_to_invoice` NULL → omitida con
  aviso, nunca spot en silencio); `contracts.service.ts` agrega los campos derivados y `history[]` al detalle y `fx_policy`/`fx_rate`/
  `issued_externally`/`original_issue_date` a la lista.
- Funciones viejas que quedan anotadas como reemplazadas (se retiran al switch, mapa §5): `apply_fixed_fx_to_contract` (por `…/fx`),
  `reschedule_invoice_safe` + tabla `invoice_reschedules` (por `…/reschedule` + evento), `emit_invoice_manually` (por `…/mark-issued`, sin división),
  el `UPDATE invoices` directo de `ContratoFacturasTab.tsx:490-512` (front viejo). Ninguna se toca ahora.
- Hallazgo de la QA de solo lectura en prod (29-09): **`invoices.updated_at` no existe** (sí en `invoice_items`). **Corregido el 29-09**: se quitó
  `updated_at = now()` de los 7 `UPDATE invoices` del módulo (6 en `contract-changes.service.ts`, 1 en `consumption.service.ts`). Comparación de
  solo lectura de todas las columnas que v2 escribe (SET/INSERT) en `invoices`, `invoice_items`, `contracts`, `contract_items` contra
  `information_schema.columns` de prod: sin desajustes. `contract_lifecycle_events.event_type` no tiene CHECK (los tipos nuevos entran sin migración);
  tipos ya vistos en prod: `INVOICE_CANCELLED`, `INVOICE_CREDIT_NOTE`, `INVOICE_EMITTED_MANUALLY`, `INVOICE_UNCONSOLIDATION`, `INVOICE_UNIFICATION`.
  Las consultas nuevas (lock `FOR UPDATE OF i` con LATERAL, `mode() WITHIN GROUP … FILTER`, `EXISTS` sobre eventos) se validaron con `EXPLAIN` en
  prod dentro de una transacción `READ ONLY`.
- Jest: `uuid` v13 es solo ESM y `InvoiceSchedulerService` lo importa; al importar el scheduler desde Contratos, los specs que cargan
  `contracts.controller`/`contracts.module` (y `quotes.module.spec`) llevan `jest.mock('uuid', …)` como ya hacían el del scheduler y los de Salesforce.
- Verificación local (29-09): `tsc`, `eslint`, `jest src/modules/contracts src/modules/invoices src/modules/quotes src/databases/postgresql/entities/facturacion`
  (28 suites, 645 tests) en verde; sin commit; la API en `:8082` sigue con su `dist/` anterior.
- Pendiente (etapa 1 de la spec): `POST …/erp-withdraw` (cancelar el borrador en Odoo por API, decisión #10 de Leon; hasta entonces una PE con
  `odoo_invoice_id` bloquea reprogramar/FX/emisión externa con `sent_to_erp_draft`); BFF `app/api/contratos/[id]/facturas/*` + menú ⋯ / vista rápida
  en front-sapira.

### 9. Costura `sapira.writer = 'api'`: lógica en la API, triggers solo invariantes (30-09, código listo, sin commit, sin aplicar)

- Decisión de Domi (30-09): con `sapira.writer = 'api'` todo trigger legacy de Contratos/Facturas/Cotizaciones es no-op para la API
  salvo los invariantes (guard de período y validadores de moneda); el front viejo no fija la marca y no cambia. Regla:
  [`logica-en-api-triggers.md`](../reglas-desarrollo/logica-en-api-triggers.md). Detalle, orden y prueba en QA:
  [`activacion-costura-triggers.md`](./activacion-costura-triggers.md) § Construido.
- API: `setApiWriter`/`withApiWriter` (`src/modules/contracts/api-writer.ts`) como primera sentencia de toda transacción v2 que
  escribe; `api-written-fields.ts` escribe lo que rellenaban los triggers (precios derivados, `term`, booking, `company_currency`, FX a
  sistema de contrato y facturas, grupo y condiciones de factura) y **se retira el patrón B** (líneas con `contract_item_id` en el INSERT,
  en activación, cambios, NC espejo y consumos).
- Assets: guard en 23 funciones (`functions/…`, lista exacta en el doc de la costura), **U9** en los 3 `trigger_rsm_on_*` (holding de la
  fila), función de generación unificada `SECURITY DEFINER` + migración `1790660000000-UnificaTriggerGeneracionFacturas` (DROP del
  trigger duplicado; se borra su asset). `grants/030` (REVOKE de `generate_missing_invoices_for_contract`) **aparte y sin aplicar**: el
  front viejo la llama por rpc desde la pestaña Legacy (`LegacyContractActivationModal.tsx:161`).
- Para retiro con doble confirmación: `validate_fx_confirmation_before_firmado` + trigger `validate_fx_before_firmado`,
  `trigger_generate_invoices_on_status_change`, `generate_missing_invoices_for_contract`.
- Verificación local (30-09): `tsc`, `eslint`, `jest` completo (101 suites; única roja preexistente `database.module.spec`,
  tabla `holding_integration_settings` sin entity, ajena a este bloque); specs nuevos `api-written-fields.spec.ts` y
  `costura-sapira-writer.spec.ts`.

## Cambio de estrategia (Domi 25-09)

En vez de corregir en su lugar las funciones que el front viejo usa, **se construye la v2 al lado** (endpoints y lógica
nuevos, rediseñados) y lo viejo se retira módulo por módulo al switch. Plan por módulo:
[`mapa-v2-contratos.md`](./mapa-v2-contratos.md) (luego Facturas y Cotizaciones). Los U de la auditoría quedan
cubiertos por diseño en ese mapa (columna "Evita de raíz").

## Capa 1 · Lo único que se corrige en su lugar (triggers compartidos, afectan a los dos fronts)

Cada uno se presenta a Domi antes de tocarlo (funciones, casos que corrige, qué no debe romper, prueba).

| # | Qué | Piezas |
|---|---|---|
| 2 | U13 · el sync de cantidades no toca NC (+ su gemela al borrar) | `sync_invoice_items_amounts_from_quantities`, `restore_invoice_items_amounts_on_quantity_delete` |
| 3 | U9 · los triggers del RSM toman el holding del registro, no de la sesión — **construido 30-09 con la costura (§9), sin aplicar** | `trigger_rsm_on_*` |
| 4 | U8 · el rebuild parcial carga el devengo acumulado previo + rebuild completo (OK aparte: reescribe el devengo de todos los clientes) | `revenue_schedule_rebuild_contract_ccy` |
| 5 | Costura `sapira.writer = 'api'`: todo trigger legacy no-op para la API salvo invariantes (decisión de Domi 30-09) — **construido (§9), sin aplicar** | ver `mapa-v2-contratos.md` §4 y [`activacion-costura-triggers.md`](./activacion-costura-triggers.md) |

## Capa 2 · Al pasar al front nuevo (se documenta ahora, se ejecuta con el módulo `contracts`)

Cambios que exigen que el front viejo deje de llamar la función, o que son rediseño y no fix:

| Pieza | Cambio | Fuente |
|---|---|---|
| `mark_contract_signed_safe` | Fusionar en `bulk_activate_contracts` (`POST /contracts/activate`) y retirar | auditoría §2b |
| `approve_contract_amendment` + `recalc_revenue_for_contract` | Portar solo la rama CROSS_SELL a la API; retirar ambas (el flujo de aprobación se elimina, S3-10) | §2a |
| `regenerate_contract_invoices_from_items` / `_for_restructure` | Fusionar en una | §2c |
| Generación y mantenimiento de facturas | Dos piezas: **Generar** (al activar) y **Aplicar cambios** (estado objetivo, cambio mínimo); absorben sync, reschedule, modificaciones, cantidades | S4-2 |
| `standardize_invoice_items` | Desaparece o solo rellena lo vacío (el generador calcula la línea) | S4a, Complejos #3 |
| Unificar / consolidar / desunificar | Se retiran por multimoneda en el contrato y ruta declarada | S4-5, S4-6 |
| FX | Política y tasa por factura; una sola convención de tasa; nunca 1 silencioso | S6, S5-10/11 |
| Creación y activación (S2-6) | En vez de bloquear al activar, **garantizar la base desde la creación**: el contrato nace siempre con cronograma y la compañía emisora con `tax_rate` (validado en `POST /contracts` y en la configuración de compañías). La guarda al activar queda solo como red. **Domi (25-09)**: no se prioriza como fix del front viejo; la base se hace bien desde el inicio en el módulo nuevo | S2-6, S1-12 |
| `inherit_auto_renew_from_quote_item` (S1-5) | Respetar la auto-renovación desmarcada en la cotización (hoy trata `false` igual que null). **Diferido por Domi (25-09)** a Contratos + Cotizaciones en el front nuevo: no bloquea el día a día | S1-5 |
| `invoice-scheduler.service.ts` (U12) | "Fijo" sin tasa bloquea el envío y alerta, en vez de salir a spot en silencio. **Diferido por Domi (25-09)** al módulo que toque la emisión en el front nuevo. Expuestas al 24-09: 11 PE desde el 1-oct (CTR-2026-74 y 96 con auto-envío, 151 sin auto-envío) + 8 de meses pasados que el scheduler ya no toma | S6-2, B3 |
| RSM | Motor con granularidad, cierre de meses, variables leídos en el rebuild | S5 |
| Legacy | Módulo Historia del cliente; fusionar los dos "crear contrato" y las dos reconciliaciones | S8 |
| Tenancy | Todas las funciones vivas validan el holding de la sesión, o pasan a la API | §1, decisión #2 |
| `REVOKE` a `authenticated` | Al migrar cada módulo, las funciones que el front viejo deja de llamar quedan solo para la API | §1 |
