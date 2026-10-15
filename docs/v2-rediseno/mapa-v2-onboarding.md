# Mapa v2 · Onboarding de datos históricos (módulo `onboarding`)

> 13-10-2026 · Construido (entrega 1 de [`spec-onboarding-y-mrr-historico-v2.md`](./spec-onboarding-y-mrr-historico-v2.md) §8.1,
> con la corrección de Domi del 13-10: la importación no crea clientes comerciales, paso "Registrar histórico" y arranque rápido sin
> producto ni período inventados). Código: `src/modules/onboarding/`. Regla común del MRR histórico: `src/modules/metrics/mrr-historico.ts`.
> Migración `1791900000000-OnboardingDatosHistoricos` **sin aplicar** (QA → prod con OK de Domi). Sin commit.

## 1. Reglas transversales

- Controller `onboarding` con `SupabaseAuthGuard` + `HoldingScopeGuard` + `RequirePermissionGuard`: lecturas `VIEW_CONFIGURACION`,
  escrituras (y vistas previas que validan escrituras) `EDIT_CONFIGURACION`. Holding solo por el header `x-holding-id`.
- Paginación `{ data, total, currentPage, pages, limit }` (default `limit` 25, máx. 200). Errores `{ message, errors?[{ field, message }] }`.
  409 `{ code, message, blockers? }`.
- Toda escritura: `withApiWriter` (transacción con `sapira.writer = 'api'` primero) + evento en `onboarding_events`. Ninguna escritura
  dispara notificaciones, correos ni sincronizaciones (lo verifica `onboarding-history.service.spec.ts` › costura).
- `link` y `contract` reconstruyen el devengo (`revenue_schedule_rebuild`) **solo si el contrato está Activo**: un borrador En revisión no
  tiene devengo (se arma al activarse) y reconstruirlo crearía filas de un borrador que Métricas leería.
- **Clave de línea** `key`: base64url de `client_id|product_name|contract_currency` (`encodeLineKey`/`decodeLineKey` en
  `onboarding-common.ts`; el producto puede traer `|`, `/` o tildes). Clave inválida → 400. En `onboarding_events.line_key` va sin codificar.

### Estado derivado de una línea (§3.1)

Precedencia: `pending` / `pending_ended` (tiene filas sin empalme ni cierre; `pending_ended` si su último mes < mes en curso del holding) →
`linked` (sin pendientes, con filas empalmadas) → `closed` (filas con motivo `churn`) → `removed` (solo filas `duplicate` | `error`).
Motivo efectivo: `skip_reason_code` o, en filas viejas, el texto libre (`duplic` → `duplicate`, `error` → `error`, otro → `churn`).
Prod 13-10 (SimpliRoute): 913 líneas = 5 pending · 80 pending_ended · 630 linked · 195 closed · 3 removed.

### Qué cuenta en métricas (una sola regla)

`legacyCountedConditions()`: recurrente + corte U14 (no cuenta la fila empalmada desde el primer mes con MRR de su contrato) + no quitada.
La usan Métricas (`MetricsDataService.loadLegacyRows`), Dashboard y lista de Clientes (`HoldingMetricsService`), Cliente 360
(`ClientMetricsService.getMrr`, antes sin corte ni filtro de recurrente) y el `counted` del detalle de una línea.

## 2. Endpoints

### `GET /onboarding/summary`

```json
{ "history": { "lines": 913, "pending": 5, "pending_ended": 80, "linked": 630, "closed": 195, "removed": 3, "clients_without_contract": 196 },
  "splice": { "gap": 28, "overlap_cut": 83, "contract_without_mrr": 12 },
  "previous_invoices": { "total": 8975, "pending": 139, "linked": 267, "by_status": { "Pagada": 1734, "Enviada": 7241, "Vencida": 0 } },
  "settings": { "metrics_history_start": "2025-01", "system_currency": "USD" } }
```
Cifras: SimpliRoute en prod, lectura del 13-10 (solo lectura). `splice` es **por contrato** (como la auditoría S8): último mes de MRR histórico empalmado vs primer mes con MRR del contrato.
`previous_invoices.pending` = sin contrato y sin MRR histórico registrado.

### `GET /onboarding/history/lines`

Query: `status` (CSV de `pending,pending_ended,linked,closed,removed`), `clientId`, `product` (nombre exacto), `batchId`, `search`
(cliente, producto o razón social), `page`, `limit`, `sortBy` (`client|product|last_month|mrr|status`), `sortOrder`. Fila:

```json
{ "key": "…", "client": { "id": "…", "name": "ACME" }, "product_name": "PATHFINDER+", "product_id": "…|null", "currency": "USD",
  "first_month": "2025-01", "last_month": "2026-06", "months_count": 18, "mrr_last": 120.5, "mrr_last_system": 120.5,
  "status": "pending_ended", "ended": true, "contract": { "id": "…", "contract_number": "CTR-2026-9", "status": "Activo" } | null,
  "batch_ids": ["…"], "invoices_count": 18, "skip_reason_code": "churn|duplicate|error|null", "skip_reason": "texto|null" }
```
`product_id`: producto del catálogo con el mismo nombre (la tabla no guarda `product_id`). `mrr_last*`: último mes sin filas quitadas.

### `GET /onboarding/history/lines/:key`

Línea + `months[{ id, period_month, subtotal_contract_currency, mrr_legacy, mrr_legacy_system_currency, term, is_recurring, invoice_number,
invoice_legacy_id, counted, state: pending|linked|closed|removed, contract_id }]`, `invoices[{ id, invoice_number, issue_date, currency,
total, status, contract_id }]`, `splice{ gap_months, overlap_months, contract_first_month }` (contra el contrato empalmado; primer mes = RSM
o, sin devengo, el primer inicio recurrente), `candidates[{ id, contract_number, status, products[], currency, start_date, end_date, score }]`
(mismo cliente, no borrados ni cancelados; +2 producto, +1 moneda, +1 arranca al mes siguiente; top 10) y `events[]` (últimos 50). 404
fuera del holding.

### Escrituras sobre una línea (todas devuelven la línea salvo `link`)

| Ruta | Body | Efecto | 409 |
|---|---|---|---|
| `PATCH …/:key/months` | `{ months:[{ id, subtotal_contract_currency?, is_recurring? }] }` (1–500) | escribe `mrr_legacy`/`momentum` explícitos y recalcula `fx_contract_to_invoice`; el trigger de moneda de sistema recalcula al nombrar `mrr_legacy` en el SET; evento `history_months_edited` con antes/después. Mes ajeno a la línea → 400 `months.i.id` | — |
| `POST …/:key/link` | `{ contract_id }` | meses **pendientes** → `migrated_to_contract_id/_at/_by`; sus facturas sin contrato → `invoices_legacy.contract_id`; devengo si Activo. Respuesta `{ line, splice }` | `contract_other_client`, `line_not_pending`; 404 contrato |
| `POST …/:key/unlink` | — | quita el empalme; desvincula las facturas que solo respaldaban ese empalme | `line_not_linked` |
| `POST …/:key/close` | `{ reason? }` | pendientes → `skip_activation`, `skip_reason_code = churn`, texto = `reason` o "Fue baja" | `line_not_pending` |
| `POST …/:key/remove` | `{ reason: duplicate\|error, notes? }` | filas no empalmadas y no quitadas → `skip_reason_code = reason` | `line_not_removable` |
| `POST …/:key/reopen` | — | cerradas o quitadas (no empalmadas) → pendiente | `line_not_closed` |

### Contrato desde la línea

- `GET …/:key/contract/defaults` → `{ client_id, client_entity_id, company_id, contract_currency, items:[{ key, product_id, product_name,
  item_type: 'Fijo', quantity, unit_price, billing_frequency: 'Mensual', billing_method: 'Anticipado', term_months: 12, start_date,
  is_recurring: true }], origin: { type: 'history', line_key }, warnings[] }`. Razón social y compañía de la última factura; unitario =
  MRR del último mes ÷ cantidad (cantidad solo si el mes tiene una fila con cantidad); inicio = último mes vivo + 1.
- `POST …/:key/contract/preview` (body `CreateContractDto` + `origin?`) → la respuesta de `POST /contracts/preview` + `splice` (contra el
  primer inicio recurrente del body).
- `POST …/:key/contract` → `{ contract: { id, contract_number }, line }`. `ContractDraftsService.create` (su transacción) y luego el
  empalme en otra; si el empalme falla, el borrador se elimina (`ContractDraftsService.remove`). `origin` no se guarda en el contrato (no
  hay columna): queda en el empalme y en el evento `history_contract_created`. 409 `contract_other_client`, `line_not_pending`.

### Facturas previas

- `GET /onboarding/previous-invoices` — query `status` (CSV `Pagada,Enviada,Vencida`), `linked` (`true|false`), `clientId`, `entityId`,
  `batchId`, `search`, `from`, `to` (AAAA-MM-DD), `page`, `limit`, `sortBy` (`issue_date|due_date|invoice_number|client|total|status`),
  `sortOrder`. Fila: `{ id, invoice_number, issue_date, due_date, entity{id,legal_name,tax_id}|null, legal_client_name, client_tax_id,
  client{id,name}|null, company{id,legal_name}, currency, amount, vat, total, status, source_type, source_system, origin: 'external',
  contract{id,contract_number}|null, batch_id, has_history }`.
- `GET /onboarding/previous-invoices/:id` → factura + `items[{ id, description, product_external_code, quantity, unit_price, discount_pct,
  currency, subtotal, tax_amount, total }]` + `history_months[{ id, period_month, product_name, contract_currency, subtotal_contract_currency,
  mrr_legacy, mrr_legacy_system_currency, term, is_recurring, contract_id }]` + `events[]`.
- `POST /onboarding/previous-invoices/import/preview` — body del contrato §5 + opcionales por fila `client_crm_id`, `client_number`,
  `erp_invoice_id` (máx. 2.000 facturas, 200 líneas c/u). Respuesta:

```json
{ "rows": [{ "row": 7, "status": "new|duplicate|error|needs_entity|needs_client", "errors": ["…"],
    "entity": { "id": "…", "legal_name": "…" } | null, "client": { "id": "…", "name": "…" } | null,
    "entity_suggestion": { "legal_name": "…", "tax_id": "…|null", "country": "BR|null", "client_candidates": [{ "id": "…", "name": "…", "score": 0.8 }] } | null,
    "company": { "id": "…" } | null }],
  "summary": { "new": 0, "duplicate": 0, "error": 0, "needs_entity": 0, "needs_client": 0, "by_currency": [{ "currency": "BRL", "count": 95, "total": 0 }] },
  "missing_entities": [{ "legal_name": "…", "tax_id": "…|null", "rows": [7], "client_candidates": [] }],
  "missing_companies": ["…"] }
```
  Precedencia `error` > `duplicate` > `needs_entity` > `needs_client` > `new`. Duplicado: mismo `invoice_number` en el holding o en la
  planilla, o mismo id del ERP (`odoo_integration_id`). Razón social: RUT normalizado (sin puntos, guiones ni espacios) o nombre exacto
  (minúsculas, espacios colapsados). Cliente comercial: el de la razón social (`client_id` o vínculo principal/único en
  `client_entity_clients`); si no tiene, el de `clients.salesforce_account_id = client_crm_id` o `client_number`. Candidatos: `pg_trgm`
  `similarity ≥ 0,3`, top 5. Compañía emisora: `companies.legal_name` exacto; si hay varias con ese nombre (SimpliRoute tiene tres
  "SimpliRoute S.A.S") se desempata por moneda de la factura; si sigue ambigua o no existe → `error`. País sugerido = el de la compañía.
- `POST /onboarding/previous-invoices/import` — body + `create_entities?: [{ legal_name, tax_id?, country (ISO-2), client_id? }]` →
  `{ batch_id, inserted, skipped_duplicates, errors, entities_created, needs_client }`. **Nunca crea clientes comerciales** (`client_id`
  ajeno → 400). Con `client_id` la razón social nace por `insertClientEntity` (camino único de Clientes); sin él, suelta. Se insertan
  `new` y `needs_client` (sin cliente); `errors` cuenta `error` + `needs_entity` no resueltas. 409 `nothing_to_import` (rollback total).
- `POST /onboarding/previous-invoices/:id/client` `{ client_id }` → detalle de la factura. Inserta el vínculo en `client_entity_clients`
  (principal si la razón social no tenía cliente; el trigger `sync_client_entity_primary_client` copia `client_entities.client_id`) y
  completa `client_id` en las facturas previas de esa razón social que no lo tenían. 409 `invoice_without_entity`; 404 cliente o factura.
- `POST /onboarding/previous-invoices/register-history/preview` — body `{ invoices:[{ invoice_id, period_from, period_to,
  contract_currency, amount_contract_currency, is_recurring?, products:[{ product_id, amount_contract_currency }] }] }` (máx. 2.000) →
  `{ rows:[{ invoice_id, invoice_number, months[], mrr_per_month, fx_contract_to_invoice, products[{ product_id, product_name, amount,
  mrr_per_month }], warnings[], errors[] }], summary{ invoices, ready, with_warnings, with_errors, rows_to_create } }`. Avisos:
  `sum_mismatch` (Σ productos vs monto ±1 %), `month_already_covered` (la misma línea ya tiene ese mes), `fx_outlier` (misma moneda y fx ≠ 1,
  o ±20 % de la mediana del holding para el par), `no_client`. Errores: `not_found`, `already_registered`, `invoice_without_items`,
  `invalid_period` (hasta < desde o > 36 meses), `invalid_amount`, `product_not_found`, `duplicate_product`, `currency_not_enabled`, `no_client`.
- `POST /onboarding/previous-invoices/register-history` → `{ created_rows, lines_touched[] (keys), skipped[{ invoice_id, reason }], batch_id }`.
  Una fila `mrr_legacy` por producto × mes no cubierto: `split_index` = posición del producto, `invoice_item_legacy_id` = primera línea de la
  factura, `subtotal_contract_currency` = parte del producto por todo el período, `term` = meses, `mrr_legacy` = parte ÷ meses,
  `fx_contract_to_invoice` = neto de factura ÷ monto de contrato, `allocated_invoice_currency` = parte × fx, `product_name` del catálogo
  (`mrr_legacy` no tiene `product_id`). Marca `reconciliation_status = 'mrr_legacy'`. Bloquean: los errores y `sum_mismatch`.
- `POST /onboarding/previous-invoices/import/:batchId/revert` → `{ batch_id, removed }` (borra las facturas del lote y sus líneas). 404 lote
  inexistente; 409 `batch_has_history` | `batch_linked` | `already_reverted`. Las razones sociales creadas por la importación se conservan.
- `GET /onboarding/previous-invoices/batches` → `[{ id, label, created_at, created_by, count, reverted }]` (desde los eventos
  `previous_invoices_imported` / `previous_invoices_reverted`).

### Arranque rápido

- `POST /onboarding/quick-start/preview` `{ as_of: 'AAAA-MM', entity_ids?, history_months? (0–24) }` → `{ proposals:[{ entity{id,legal_name},
  client{id,name}|null, last_invoice{ id, number, issue_date, total, amount, currency }, items[{ description, quantity, unit_price, subtotal,
  product_id|null, product_suggestion{id,name}|null }], contract{ start_date, currency, billing_frequency, billing_method },
  history_months_found, flags[] }], summary{ proposals, ready, flags{ no_client, no_product, already_has_contract, multi_currency },
  by_currency[] } }`. Última factura = emitida antes del día 1 del mes siguiente a `as_of`. `product_id` solo si el código de la línea calza
  exacto con `products.product_code`; `product_suggestion` si además (o solo) la descripción calza exacta con el nombre. Sin descripción →
  ambos `null` y `no_product`. Nunca propone período.
- `POST /onboarding/quick-start` `{ as_of, proposals:[{ entity_id, period_from, period_to, contract_currency, amount_contract_currency,
  products:[{ product_id, amount_contract_currency, quantity?, unit_price? }], billing_frequency?, billing_method?, term_months? }] }` →
  `{ created:[{ entity_id, contract{ id, contract_number }, history_rows }], skipped:[{ entity_id, reason, message? }] }`. Por cliente:
  contrato En revisión con `ContractDraftsService.create` (un ítem por producto, `item_type` Fijo, cantidad o 1, unitario o monto mensual ÷
  cantidad, inicio = mes siguiente al último mes cubierto —el `period_to` o el de emisión si es posterior—, 12 meses, Mensual Anticipado por
  defecto) y después, en otra transacción, el registro de la última factura (mismo motor que Registrar histórico) con las filas ya
  empalmadas al contrato y la factura vinculada. Si el registro falla, el borrador se elimina. Motivos de `skipped`: `no_invoice`,
  `no_client`, `no_product`, los errores de Registrar histórico, `contract_error`, `history_error`.

### `GET /onboarding/events`

Query `lineKey?` (la de la URL), `entityId?`, `page`, `limit` → paginado de `{ id, type, line_key, entity_type, entity_id, payload,
actor{id,name}|null, created_at }`. Tipos: `history_months_edited`, `history_linked`, `history_unlinked`, `history_closed`,
`history_removed`, `history_reopened`, `history_contract_created`, `history_registered`, `previous_invoices_imported`,
`previous_invoices_reverted`, `previous_invoice_client_linked`, `quick_start_applied`.

### `PATCH /settings/holding/preferences` (+ `metrics_history_start`)

Ver [`contrato-api-configuracion.md`](./contrato-api-configuracion.md) §9.2b. Métricas (clientes y cohortes) arranca en el mayor entre el
primer dato y este mes.

## 3. Otros cambios de la entrega

- Etiquetas visibles: `sourceLabel` "MRR histórico", motivo de churn "MRR histórico sin contrato", subcategorías "MRR histórico nuevo /
  terminado", "Variación MRR histórico", "MRR histórico → contrato", fórmula del MRR y el aviso `legacy_unlinked` de Ingresos. Los códigos
  internos (`source = legacy`, `LEGACY_*`) no cambian.
- Filas quitadas (duplicado o error) dejan de contar en Métricas, Dashboard, Clientes y Cliente 360 (lectura del texto libre: 58 filas de
  SimpliRoute, hasta ≈6,5 mil USD/mes entre dic-2024 y jul-2026).

## 4. Fuera de esta entrega

Mapeo libre de columnas, planilla de MRR histórico directo, contratos vigentes con `facturar_desde`, última factura multi período
(§3.3.4) y facturas previas en Cobranza (entrega 2); checklist, alta por términos y retiro de RPC/tablas viejas (entrega 3).
