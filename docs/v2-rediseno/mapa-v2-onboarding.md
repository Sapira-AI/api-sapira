# Mapa v2 · Onboarding de datos históricos (módulo `onboarding`)

> 13-10-2026 · Construido (entrega 1 de [`spec-onboarding-y-mrr-historico-v2.md`](./spec-onboarding-y-mrr-historico-v2.md) §8.1,
> con la corrección de Domi del 13-10: la importación no crea clientes comerciales, paso "Registrar histórico" y arranque rápido sin
> producto ni período inventados). Código: `src/modules/onboarding/`. Regla común del MRR histórico: `src/modules/metrics/mrr-historico.ts`.
> Migración `1791900000000-OnboardingDatosHistoricos` aplicada en QA y prod (v0.0.145). **Cierre v1 14-10** (decisiones de Domi): §2b, sin
> migración nueva y sin commit. **Ajustes 18-10** (Domi): serie mensual del MRR histórico y sus opciones de filtro (§2c), resumen de facturas
> previas sin `pending`, `companies` en la línea y retiro de `PATCH …/:key/months`; sin migración.

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

Precedencia: `pending` (tiene filas sin empalme ni cierre; **un solo estado** desde el 14-10, `ended` = su último mes < mes en curso del
holding) → `linked` (sin pendientes, con filas empalmadas) → `closed` (filas con motivo `churn`) → `removed` (solo filas `duplicate` | `error`).
Motivo efectivo: `skip_reason_code` o, en filas viejas, el texto libre (`duplic` → `duplicate`, `error` → `error`, otro → `churn`).
Prod 13-10 (SimpliRoute): 913 líneas = 85 pending (80 ya terminadas, `ended`) · 630 linked · 195 closed · 3 removed. 16 de las pendientes
tienen además filas empalmadas (sus facturas empalmadas no cambian de producto ni moneda: §2b).

### Qué cuenta en métricas (una sola regla)

`legacyCountedConditions()`: recurrente + corte U14 (no cuenta la fila empalmada desde el primer mes con MRR de su contrato) + no quitada.
La usan Métricas (`MetricsDataService.loadLegacyRows`), Dashboard y lista de Clientes (`HoldingMetricsService`), Cliente 360
(`ClientMetricsService.getMrr`, antes sin corte ni filtro de recurrente) y el `counted` del detalle de una línea.

## 2. Endpoints

### `GET /onboarding/summary`

```json
{ "history": { "lines": 913, "pending": 85, "pending_ended": 80, "linked": 630, "closed": 195, "removed": 3, "clients_without_contract": 196 },
  "splice": { "gap": 28, "overlap_cut": 83, "contract_without_mrr": 12 },
  "previous_invoices": { "total": 8975, "without_history": 155, "with_history": 8820, "linked": 267, "by_status": { "Pagada": 1734, "Enviada": 7241, "Vencida": 0 } },
  "settings": { "metrics_history_start": "2025-01", "system_currency": "USD" } }
```
Cifras: SimpliRoute en prod, lectura del 13-10 (solo lectura). `splice` es **por contrato** (como la auditoría S8): último mes de MRR histórico empalmado vs primer mes con MRR del contrato.
`previous_invoices`: `without_history` = sin MRR histórico registrado (con o sin contrato), `with_history` = con MRR histórico (`without_history +
with_history = total`), `linked` = con contrato vinculado (con o sin histórico). **18-10**: se retiró `pending` (sin contrato y sin histórico:
139 contra 155 sin registrar, confundía); prod 18-10: 8.975 = 155 sin histórico + 8.820 con histórico, 267 con contrato. `history.pending`
cuenta todas las pendientes y `pending_ended` las que ya terminaron (subconjunto); `closed` (fue baja) y `removed` (duplicado o error) van por
separado.

### `GET /onboarding/history/lines`

Query: `status` (CSV de `pending,linked,closed,removed`; `pending_ended` ya no es estado → 400), `ended` (`true` = pendientes cuyo último mes
ya pasó, "terminó sin resolver"; `false` = pendientes vigentes), `clientId`, `product` (nombre exacto), `batchId`, `search` (cliente, producto
o razón social), `page`, `limit`, `sortBy` (`client|product|last_month|mrr|status`; `status` ordena por prioridad), `sortOrder`. **Sin
`sortBy`**: prioridad de estado (pending → linked → closed → removed) y luego cliente. Fila:

```json
{ "key": "…", "client": { "id": "…", "name": "ACME" }, "product_name": "PATHFINDER+", "product_id": "…|null", "currency": "USD",
  "first_month": "2025-01", "last_month": "2026-06", "months_count": 18, "mrr_last": 120.5, "mrr_last_system": 120.5,
  "status": "pending", "ended": true, "contract": { "id": "…", "contract_number": "CTR-2026-9", "status": "Activo" } | null,
  "batch_ids": ["…"], "invoices_count": 18, "skip_reason_code": "churn|duplicate|error|null", "skip_reason": "texto|null",
  "companies": [{ "id": "…", "legal_name": "Simplit SpA" }] }
```
`product_id`: producto del catálogo con el mismo nombre (la tabla no guarda `product_id`). `mrr_last*`: último mes sin filas quitadas.
`companies` (18-10, también en el detalle): compañías emisoras distintas de sus filas (`mrr_legacy.company_id`), por nombre; el front sugiere
series "del mismo emisor y receptor". Prod 18-10: 912 de 913 líneas tienen una sola compañía.

### `GET /onboarding/history/lines/:key`

Línea + `months[{ id, period_month, subtotal_contract_currency, mrr_legacy, mrr_legacy_system_currency, term, is_recurring, invoice_number,
invoice_legacy_id, invoice_currency, amount_invoice_currency (asignado en moneda de factura, misma base que el subtotal: todo el plazo),
fx_contract_to_invoice, fx_contract_to_system, counted, state: pending|linked|closed|removed, contract_id }]`, `invoices[{ id, invoice_number, issue_date, currency,
total, status, contract_id }]`, `splice{ gap_months, overlap_months, contract_first_month }` (contra el contrato empalmado; primer mes = RSM
o, sin devengo, el primer inicio recurrente), `candidates[{ id, contract_number, status, products[], currency, start_date, end_date, score }]`
(mismo cliente, no borrados ni cancelados; +2 producto, +1 moneda, +1 arranca al mes siguiente; top 10) y `events[]` (últimos 50). 404
fuera del holding.

### Escrituras sobre una línea (todas devuelven la línea salvo `link`)

| Ruta | Body | Efecto | 409 |
|---|---|---|---|
| `POST …/:key/link` | `{ contract_id }` | meses **pendientes** → `migrated_to_contract_id/_at/_by`; sus facturas sin contrato → `invoices_legacy.contract_id`; devengo si Activo. Respuesta `{ line, splice }` | `contract_other_client`, `line_not_pending`; 404 contrato |
| `POST …/:key/unlink` | — | quita el empalme; desvincula las facturas que solo respaldaban ese empalme | `line_not_linked` |
| `POST …/:key/close` | `{ reason? }` | pendientes → `skip_activation`, `skip_reason_code = churn`, texto = `reason` o "Fue baja" | `line_not_pending` |
| `POST …/:key/remove` | `{ reason: duplicate\|error, notes? }` | filas no empalmadas y no quitadas → `skip_reason_code = reason` | `line_not_removable` |
| `POST …/:key/reopen` | — | cerradas o quitadas (no empalmadas) → pendiente | `line_not_closed` |

### Editar línea (cierre v1 14-10) — ver §2b

La única forma de corregir una línea es `PATCH …/:key` por factura (§2b). `PATCH …/:key/months` (editar meses sueltos) **se retiró el 18-10**
(ruta, DTO, método y spec; la ruta responde 404; no había eventos `history_months_edited` en prod).

### Contrato desde la línea

- `GET …/:key/contract/defaults` → `{ client_id, client_entity_id, company_id, contract_currency, items:[{ key, product_id, product_name,
  item_type: 'Fijo', quantity, unit_price, billing_frequency: 'Mensual', billing_method: 'Anticipado', term_months: 12, start_date,
  is_recurring: true, category: 'RENEWAL' }], origin: { type: 'history', line_key }, warnings[] }`. Razón social y compañía de la última factura; unitario =
  MRR del último mes ÷ cantidad (cantidad solo si el mes tiene una fila con cantidad); inicio = último mes vivo + 1.
- `POST …/:key/contract/preview` (body `CreateContractDto` + `origin?`) → la respuesta de `POST /contracts/preview` + `splice` (contra el
  primer inicio recurrente del body).
- `POST …/:key/contract` → `{ contract: { id, contract_number }, line }`. Ítems en `RENEWAL` salvo `items[].category` explícita (Domi 14-10:
  viene de algo que ya existía). `ContractDraftsService.create` (su transacción) y luego el
  empalme en otra; si el empalme falla, el borrador se elimina (`ContractDraftsService.remove`). `origin` no se guarda en el contrato (no
  hay columna): queda en el empalme y en el evento `history_contract_created`. 409 `contract_other_client`, `line_not_pending`.

### Facturas previas

- `GET /onboarding/previous-invoices` — query `status` (CSV `Pagada,Enviada,Vencida`), `linked` (`true|false`), `hasHistory` (`true|false`),
  `clientId`, `entityId`, `companyId` (emisora), `country` (ISO-2 de la razón social, `client_entities.country_code`), `batchId`, `search`,
  `from`, `to` (AAAA-MM-DD), `page`, `limit`, `sortBy` (`issue_date|due_date|invoice_number|client|total|status`), `sortOrder`. Fila: `{ id,
  invoice_number, issue_date, due_date, entity{id,legal_name,tax_id}|null, legal_client_name, client_tax_id, client{id,name}|null,
  company{id,legal_name}, currency, amount, vat, total, status, source_type, source_system, notes, country, origin: 'external',
  contract{id,contract_number}|null, batch_id, has_history }`.
- `GET /onboarding/previous-invoices/filter-options` → `{ companies: [{ id, legal_name }], countries: string[] }`: solo compañías emisoras y
  países de razón social presentes en las facturas previas del holding (prod 15-10: 12 compañías, 21 países).
- `GET /onboarding/previous-invoices/:id` → factura (con `notes` y `country`) + `items[{ … description completa, id, description, product_external_code, quantity, unit_price, discount_pct,
  currency, subtotal, tax_amount, total }]` + `history_months[{ id, period_month, product_name, contract_currency, subtotal_contract_currency,
  mrr_legacy, mrr_legacy_system_currency, term, is_recurring, contract_id }]` + `events[]`.
- `POST /onboarding/previous-invoices/import/preview` — body del contrato §5 + opcionales por fila `client_crm_id`, `client_number`,
  `erp_invoice_id`, `country` (ISO-2), `notes` y, por línea, el **histórico en el mismo paso** (14-10): `product` (nombre o código del
  catálogo), `period_from`, `period_to` (AAAA-MM), `contract_currency`, `amount_contract_currency` (todo el período), `is_recurring` (máx.
  2.000 facturas, 200 líneas c/u). Respuesta (las filas traen además `history`, ver §2b):

```json
{ "rows": [{ "row": 7, "status": "new|duplicate|error|needs_entity|needs_client", "errors": ["…"],
    "entity": { "id": "…", "legal_name": "…" } | null, "client": { "id": "…", "name": "…" } | null,
    "entity_suggestion": { "legal_name": "…", "tax_id": "…|null", "country": "BR|null", "client_candidates": [{ "id": "…", "name": "…", "score": 0.8 }] } | null,
    "company": { "id": "…" } | null }],
  "summary": { "new": 0, "duplicate": 0, "error": 0, "needs_entity": 0, "needs_client": 0, "by_currency": [{ "currency": "BRL", "count": 95, "total": 0 }],
    "history_ready": 0, "history_incomplete": 0, "history_error": 0 },
  "missing_entities": [{ "legal_name": "…", "tax_id": "…|null", "rows": [7], "client_candidates": [] }],
  "missing_companies": ["…"] }
```
  Precedencia `error` > `duplicate` > `needs_entity` > `needs_client` > `new`. Duplicado: mismo `invoice_number` en el holding o en la
  planilla, o mismo id del ERP (`odoo_integration_id`). Razón social: RUT normalizado (sin puntos, guiones ni espacios) o nombre exacto
  (minúsculas, espacios colapsados). Cliente comercial: el de la razón social (`client_id` o vínculo principal/único en
  `client_entity_clients`); si no tiene, el de `clients.salesforce_account_id = client_crm_id` o `clients.client_number = client_number`
  (si falta la razón social, ese cliente va como primer candidato con `score` 1 y el país sugerido es el de la fila). Candidatos: `pg_trgm`
  `similarity ≥ 0,3`, top 5. Compañía emisora: `companies.legal_name` exacto; si hay varias con ese nombre (SimpliRoute tiene tres
  "SimpliRoute S.A.S") se desempata por moneda de la factura; si sigue ambigua o no existe → `error`. País sugerido = el de la compañía.
- `POST /onboarding/previous-invoices/import` — body + `create_entities?: [{ legal_name, tax_id?, country (ISO-2), client_id? }]` →
  `{ batch_id, inserted, skipped_duplicates, errors, entities_created, needs_client, history_rows_created, history_lines_touched[] (claves),
  history_skipped[{ row, invoice_number, reason }] }` (histórico de las facturas `ready`, §2b). **Nunca crea clientes comerciales** (`client_id`
  ajeno → 400). Con `client_id` la razón social nace por `insertClientEntity` (camino único de Clientes); sin él, suelta. Se insertan
  `new` y `needs_client` (sin cliente); `errors` cuenta `error` + `needs_entity` no resueltas. 409 `nothing_to_import` (rollback total).
- `POST /onboarding/previous-invoices/:id/client` `{ client_id }` → detalle de la factura. Inserta el vínculo en `client_entity_clients`
  (principal si la razón social no tenía cliente; el trigger `sync_client_entity_primary_client` copia `client_entities.client_id`) y
  completa `client_id` en las facturas previas de esa razón social que no lo tenían. 409 `invoice_without_entity`; 404 cliente o factura.
- `POST /onboarding/previous-invoices/register-history/preview` — body `{ invoices:[{ invoice_id, period_from, period_to,
  contract_currency, amount_contract_currency, is_recurring?, products:[{ product_id, amount_contract_currency }] }] }` (máx. 2.000) →
  `{ rows:[{ invoice_id, invoice_number, invoice_currency, amount_invoice_currency, months[], mrr_per_month, fx_contract_to_invoice,
  products[{ product_id, product_name, amount,
  mrr_per_month, line_key, line_exists }], line_key, line_exists, warnings[], errors[] }], summary{ invoices, ready, with_warnings, with_errors,
  rows_to_create, lines_touched[] } }`. **Línea de destino (18-10)**: `line_key` = la clave (codificada) de la línea a la que se sumaría,
  calculada como al aplicar (cliente comercial | producto del catálogo | moneda de contrato; la misma del `lines_touched` de aplicar), por
  producto y, en la fila, la del primer producto (una factura con varios productos cae en varias líneas); `null` sin cliente o sin producto.
  `line_exists` = esa línea ya tiene filas en el holding (cualquier estado). `summary.lines_touched` = claves distintas de las facturas que se
  aplicarían (sin las bloqueadas por errores o `sum_mismatch`). Helper único `OnboardingRegisterService.linesOf`. Avisos:
  `sum_mismatch` (Σ productos vs monto ±1 %), `month_already_covered` (la misma línea ya tiene ese mes), `fx_outlier` (misma moneda y fx ≠ 1,
  o ±20 % de la mediana del holding para el par), `fx_one_with_different_currencies` (monedas distintas y fx entre 0,98 y 1,02: el monto de
  contrato se copió del de factura; 14-10), `no_client`. Una sola regla: `fxWarningsOf` + `loadFxReferences` de `onboarding-register.service.ts`. Errores: `not_found`, `already_registered`, `invoice_without_items`,
  `invalid_period` (hasta < desde o > 36 meses), `invalid_amount`, `product_not_found`, `duplicate_product`, `currency_not_enabled`, `no_client`.
- `POST /onboarding/previous-invoices/register-history` → `{ created_rows, lines_touched[] (keys), skipped[{ invoice_id, reason }], batch_id }`.
  Una fila `mrr_legacy` por producto × mes no cubierto: `split_index` = posición del producto, `invoice_item_legacy_id` = primera línea de la
  factura, `subtotal_contract_currency` = parte del producto por todo el período, `term` = meses, `mrr_legacy` = parte ÷ meses,
  `fx_contract_to_invoice` = neto de factura ÷ monto de contrato, `allocated_invoice_currency` = parte × fx, `product_name` del catálogo
  (`mrr_legacy` no tiene `product_id`). Marca `reconciliation_status = 'mrr_legacy'`. Bloquean: los errores y `sum_mismatch`.
- `POST /onboarding/previous-invoices/import/:batchId/revert` → `{ batch_id, removed, history_rows_removed }` (borra las facturas del lote y
  sus líneas y, antes, el MRR histórico **del mismo lote**: `mrr_legacy.batch_id` = lote y sin empalmar). 404 lote inexistente; 409
  `batch_has_history` (histórico ajeno al lote —otro registro o una edición de la línea— o empalmado) | `batch_linked` | `already_reverted`. Las
  razones sociales creadas por la importación se conservan.
- `GET /onboarding/previous-invoices/batches` → `[{ id, label, created_at, created_by, count, reverted }]` (desde los eventos
  `previous_invoices_imported` / `previous_invoices_reverted`).

### Arranque rápido

- `POST /onboarding/quick-start/preview` `{ as_of: 'AAAA-MM', entity_ids?, history_months? (0–24) }` → `{ proposals:[{ entity{id,legal_name},
  client{id,name}|null, last_invoice{ id, number, issue_date, total, amount, currency }, items[{ description, quantity, unit_price, subtotal,
  product_id|null, product_suggestion{id,name}|null }], contract{ start_date, currency, billing_frequency, billing_method },
  history_months_found, flags[] }], summary{ proposals, ready, flags{ no_client, no_product, already_has_contract, multi_currency },
  by_currency[] } }`; cada propuesta trae además `invoice_currency`, `amount_invoice_currency`, `fx_contract_to_invoice`, `warnings[]`,
  `errors[]` (14-10) y `line_key`, `line_exists` (18-10, con `summary.lines_touched[]`; misma regla que Registrar histórico, solo para las
  propuestas con lo completado: sin producto no hay línea → `null`/`false`). Body opcional `proposals?` (mismo de aplicar): con él, fx, avisos y errores salen del motor de Registrar histórico; sin él,
  la propuesta es en la moneda de la factura (fx 1, sin avisos). Última factura = emitida antes del día 1 del mes siguiente a `as_of`. `product_id` solo si el código de la línea calza
  exacto con `products.product_code`; `product_suggestion` si además (o solo) la descripción calza exacta con el nombre. Sin descripción →
  ambos `null` y `no_product`. Nunca propone período.
- `POST /onboarding/quick-start` `{ as_of, proposals:[{ entity_id, period_from, period_to, contract_currency, amount_contract_currency,
  products:[{ product_id, amount_contract_currency, quantity?, unit_price? }], billing_frequency?, billing_method?, term_months? }] }` →
  `{ created:[{ entity_id, contract{ id, contract_number }, history_rows }], skipped:[{ entity_id, reason, message? }] }`. Por cliente:
  contrato En revisión con `ContractDraftsService.create` (un ítem por producto, `item_type` Fijo, categoría `RENEWAL`, cantidad o 1, unitario o monto mensual ÷
  cantidad, inicio = mes siguiente al último mes cubierto —el `period_to` o el de emisión si es posterior—, 12 meses, Mensual Anticipado por
  defecto) y después, en otra transacción, el registro de la última factura (mismo motor que Registrar histórico) con las filas ya
  empalmadas al contrato y la factura vinculada. Si el registro falla, el borrador se elimina. Motivos de `skipped`: `no_invoice`,
  `no_client`, `no_product`, los errores de Registrar histórico, `contract_error`, `history_error`.

### `GET /onboarding/events`

Query `lineKey?` (la de la URL), `entityId?`, `page`, `limit` → paginado de `{ id, type, line_key, entity_type, entity_id, payload,
actor{id,name}|null, created_at }`. Tipos: `history_line_edited`, `history_linked`, `history_unlinked`, `history_closed`,
`history_removed`, `history_reopened`, `history_contract_created`, `history_registered`, `previous_invoices_imported`,
`previous_invoices_reverted`, `previous_invoice_client_linked`, `quick_start_applied`.

### `PATCH /settings/holding/preferences` (+ `metrics_history_start`)

Ver [`contrato-api-configuracion.md`](./contrato-api-configuracion.md) §9.2b. Métricas (clientes y cohortes) arranca en el mayor entre el
primer dato y este mes.

## 2b. Cierre v1 14-10 (decisiones de Domi)

### Editar línea = volver a registrar sus facturas

Decisión de Domi (14-10, "las facturas son la fuente"): **no existen meses sin factura**. Editar una línea es volver a registrar, con el motor
de Registrar histórico, las facturas que la respaldan.

- `POST /onboarding/history/lines/:key/edit/preview` y `PATCH /onboarding/history/lines/:key` (escritura `EDIT_CONFIGURACION`). Body
  `{ invoices: [{ invoice_id, period_from: 'AAAA-MM', period_to: 'AAAA-MM', contract_currency, amount_contract_currency, is_recurring?,
  products: [{ product_id, amount_contract_currency }] }] }` (1–500; mismo DTO que Registrar histórico). Una entrada por factura de la línea;
  las no listadas no cambian. 400: factura que no es de la línea o repetida, y los errores del motor (`invoices.i`: período inválido, producto
  fuera del catálogo, moneda no habilitada, monto inválido…); en el PATCH también la suma de productos que no cuadra (`invoices.i.products`).
- **Semántica**: por cada factura listada se borran sus filas de `mrr_legacy` **en esta línea** (mismo cliente, producto y moneda; también
  las quitadas) y se regeneran con `OnboardingRegisterService.registerInTx` en modo `replace` (`ReplaceOptions`): no rige
  `already_registered`; el cliente es el de la línea; los meses de las filas reemplazadas no cuentan como cubiertos (`month_already_covered`
  solo contra otras facturas de la misma línea o de la línea de destino); el tipo de cambio parte del monto en moneda de factura que la línea
  tenía asignado de esa factura (Σ `allocated_invoice_currency` ÷ plazo de sus filas; sin él, el neto de la factura), no del neto completo
  (que puede repartirse en otras líneas); los `split_index` nuevos van después de los usados en esa línea de factura. Mismas fórmulas que
  Registrar histórico (`subtotal` = parte del producto por todo el período, `term` = meses, `mrr_legacy` = parte ÷ meses, `allocated` = parte
  × fx). Un lote (`batch_id`) por edición.
- Las filas nuevas **conservan** el empalme de las reemplazadas (`migrated_to_contract_id/_at/_by`) y, si todas tenían el mismo cierre o
  quita, ese motivo. Una factura con meses empalmados que cambia de producto o moneda → 409 `line_linked_rekey` (período y montos sí). Una
  factura que queda sin filas (todo cubierto) vuelve a `reconciliation_status = 'pending'`.
- Si un producto o la moneda cambian, las filas nuevas caen en otra línea: `lines_touched[]` (la propia y las de destino) y `rekey: { from,
  to }` cuando **toda** la línea se movió a una sola línea de destino.
- **Vista previa** → `{ line{ key, product_name, product_id, currency, first_month, last_month, months_count }, months[{ period_month,
  subtotal_contract_currency (mensual), mrr_contract_ccy, mrr_system_ccy, fx_contract_to_system, invoice_id, invoice_number, invoice_currency,
  amount_invoice_currency (mensual), fx_contract_to_invoice, is_recurring, status }], totals{ mrr_last_contract_ccy, mrr_last_system_ccy,
  system_currency }, warnings[{ code, invoice_id?, period_month?, message }], rekey, lines_touched[] }`. `line` y `months` son de la línea
  resultante (la de destino si hay `rekey`), por factura × mes: `kept` (igual), `changed` (otros montos, recurrencia o línea), `added`,
  `removed`. Moneda de sistema de lo regenerado: `loadLegacySystemFx` (`src/modules/metrics/mrr-historico-fx.ts`, réplica del trigger
  `calculate_mrr_legacy_system_currency`); lo que no cambia muestra lo guardado. Avisos del motor por factura (`sum_mismatch`, `fx_outlier`,
  `fx_one_with_different_currencies`, `no_client`; `month_already_covered` uno por mes) y `line_linked_rekey_blocked`. Helpers puros en
  `onboarding-line-edit.ts`.
- **PATCH** → `{ line | null, key, lines_touched[] }` (`key` = la de destino si hubo `rekey`; `line` null si la línea quedó vacía). Eventos:
  `history_registered` por factura (del motor) y `history_line_edited` (registros pedidos, antes/después, filas borradas y creadas,
  `lines_touched`, `rekey`).
- **Detalle de línea**: `invoices[].registration: { period_from, period_to, contract_currency, amount_contract_currency, is_recurring,
  products: [{ product_id, product_name, amount_contract_currency }] }` derivado de sus filas en esta línea (Σ subtotal ÷ plazo; `product_id`
  null si el nombre no está en el catálogo), para prellenar el formulario.

### Categoría Renovación

`CreateContractDto.items[].category?` (`NEW | REACTIVATION | UPSELL | CROSS-SELL | RENEWAL`; CHURN / DOWNSELL no, son espejos de baja):
`ContractDraftsService` la escribe tal cual en INSERT y UPDATE de ítems de borrador (`COALESCE($33, itemCategoriaSql(...))`); sin ella, la
regla por historial del cliente de siempre. El alta desde una línea y el arranque rápido mandan `RENEWAL`.

### Histórico en la importación

Por factura, `history: { status: none|ready|incomplete|error, errors[], product{ id, name }|null (el de la primera línea),
fx_contract_to_invoice (neto ÷ Σ montos de contrato), warnings[] (fx) }`. `ready` = todas las líneas con los cinco campos válidos, mismo
período, moneda y recurrencia, Σ subtotales = neto ±1 % y cliente comercial; `incomplete` = faltan campos (errores "Línea N: falta …");
`error` = producto inexistente o ambiguo, período inválido (hasta < desde o > 36 meses), moneda no habilitada, líneas con distinto período o
moneda, suma que no cuadra o sin cliente comercial; `none` = ninguna línea trae histórico. `import` llama a
`OnboardingRegisterService.registerInTx` en la misma transacción con las facturas `ready` recién insertadas (productos sumados por producto) y
el lote de la importación como `batch_id`; lo que el registro salte va en `history_skipped`. Una factura `incomplete`/`error` se importa sin
histórico.

## 2c. Serie del MRR histórico (ajustes 18-10, Domi)

Para el Resumen: ver mes a mes el MRR histórico que cuenta, lo que corta el solape, lo quitado y el traspaso histórico → contrato. Lectura
`VIEW_CONFIGURACION`. Código: `onboarding-series.service.ts` (reutiliza `legacyCountedConditions`/`legacyRemovedSql` de
`src/modules/metrics/mrr-historico.ts` y la regla del devengo de `MetricsDataService.loadMrrLines`; nada duplicado).

### `GET /onboarding/history/series`

Query: `currency` (`system` por defecto | `contract` | `invoice`), `companyId` (compañía emisora, `mrr_legacy.company_id`), `clientId` (cliente
comercial), `entityId` (razón social receptora: la de la factura de origen, `invoices_legacy.client_entity_id`), `country` (ISO-2 de esa razón
social, `client_entities.country_code`), `from`, `to` (`AAAA-MM`). Por defecto `from` = el mayor entre `metrics_history_start` del holding y el
primer mes con datos del filtro (como Métricas); `to` = el último mes con datos del filtro (en SimpliRoute, 2027-02 por facturas multi mes: el
front puede pedir `to` = mes en curso). `to < from` o más de 120 meses → 400.

```json
{ "currency_mode": "system", "system_currency": "USD",
  "months": [{ "month": "2026-09", "counted": 47004.83, "cut": 368.42, "removed": 0, "contracts": 465641.69, "by_currency": [] }],
  "totals": { "last_month": "2026-09", "counted_last": 47004.83, "lines": 24, "clients": 22 },
  "filters_applied": { "currency": "system", "companyId": null, "clientId": null, "entityId": null, "country": null, "from": "2026-09", "to": "2026-09" } }
```

- Solo filas **recurrentes** (el MRR histórico es recurrente). Por fila: `removed` si está quitada (duplicado o error); si no, `cut` si su mes es
  ≥ primer mes con MRR de su contrato empalmado (solape, corte U14); si no, `counted`. `counted` es exactamente lo que suma Métricas
  (`legacyCountedConditions`); `counted + cut + removed` = todo el MRR histórico recurrente del mes.
- Montos: `system` = `mrr_legacy_system_currency`; `contract` = `mrr_legacy` agrupado por `contract_currency`; `invoice` =
  `allocated_invoice_currency ÷ term` agrupado por `invoice_currency`. En `contract` e `invoice`, `counted/cut/removed` del mes son `null` y
  `by_currency[{ currency, counted, cut, removed }]` trae una entrada por moneda (en `system`, `by_currency` = `[]`).
- `contracts`: MRR del devengo (`revenue_schedule_monthly.mrr_period_contracted_system_ccy`, sin filas de total ni de pendiente de renovar,
  contratos no borrados: la columna y el filtro de Métricas, que es la misma cifra que `mrr_period_system_ccy` salvo el pendiente de renovar)
  de los contratos empalmados a filas del filtro (sin el rango: una línea no se corta por mes), siempre en moneda de sistema.
- Meses sin datos van con ceros. `totals.last_month` = `to`; `counted_last` = `counted` de ese mes **en moneda de sistema** en los tres modos;
  `lines` y `clients` = líneas (cliente × producto × moneda) y clientes con filas del filtro en el rango.
- Prod 18-10 (SimpliRoute, `system`): 2026-07 counted 114.933,50 · cut 22.704,61 · removed 5.229,12 · contracts 419.564,47; 2026-08 75.628,57 ·
  20.214,90 · 0 · 465.322,11; 2026-09 47.004,83 · 368,42 · 0 · 465.641,69. `counted` = MRR histórico de Métricas al centavo; el MRR de todos
  los contratos en Métricas es 439.948,38 / 513.902,69 / 522.055,27 (la diferencia son contratos sin histórico empalmado).

### `GET /onboarding/history/filter-options`

`{ companies: [{ id, legal_name }], countries: string[], currencies: { contract: string[], invoice: string[] } }`: solo lo presente en el MRR
histórico del holding (compañías de `mrr_legacy.company_id`, países de la razón social de la factura de origen, monedas de contrato y de
factura). Prod 18-10: 5 compañías, 16 países, contrato `CLF, CLP, COP, MXN, PEN, USD, UYU`; factura además `UF` (filas viejas con `UF` en vez
de `CLF`: dato, no se normaliza aquí).

## 3. Otros cambios de la entrega

- Etiquetas visibles: `sourceLabel` "MRR histórico", motivo de churn "MRR histórico sin contrato", subcategorías "MRR histórico nuevo /
  terminado", "Variación MRR histórico", "MRR histórico → contrato", fórmula del MRR y el aviso `legacy_unlinked` de Ingresos. Los códigos
  internos (`source = legacy`, `LEGACY_*`) no cambian.
- Filas quitadas (duplicado o error) dejan de contar en Métricas, Dashboard, Clientes y Cliente 360 (lectura del texto libre: 58 filas de
  SimpliRoute, hasta ≈6,5 mil USD/mes entre dic-2024 y jul-2026).

## 4. Fuera de esta entrega

Mapeo libre de columnas, planilla de MRR histórico directo, contratos vigentes con `facturar_desde`, última factura multi período
(§3.3.4) y facturas previas en Cobranza (entrega 2); checklist, alta por términos y retiro de RPC/tablas viejas (entrega 3).
