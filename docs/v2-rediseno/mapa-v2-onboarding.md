# Mapa v2 · Onboarding de datos históricos (módulo `onboarding`)

> 13-10-2026 · Construido (entrega 1 de [`spec-onboarding-y-mrr-historico-v2.md`](./spec-onboarding-y-mrr-historico-v2.md) §8.1,
> con la corrección de Domi del 13-10: la importación no crea clientes comerciales, paso "Registrar histórico" y arranque rápido sin
> producto ni período inventados). Código: `src/modules/onboarding/`. Regla común del MRR histórico: `src/modules/metrics/mrr-historico.ts`.
> Migración `1791900000000-OnboardingDatosHistoricos` aplicada en QA y prod (v0.0.145). **Cierre v1 14-10** (decisiones de Domi): §2b, sin
> migración nueva y sin commit. **Ajustes 18-10** (Domi): serie mensual del MRR histórico y sus opciones de filtro (§2c), resumen de facturas
> previas sin `pending`, `companies` en la línea y retiro de `PATCH …/:key/months`; sin migración. **Segunda tanda 18-10**: "No aplica" viejo =
> "No activado" sin leer el texto libre (§1), serie por concepto y por dimensión (§2c) y corte U14 en dos casos (mes de empalme silencioso vs
> histórico después del inicio del contrato, §1 y §2); sin migración. **Registro = `batch_id` × cliente × moneda × contrato (18-10, Domi,
> definitivo)**: la bandeja lista "MRR legacy" con uno o varios productos y un solo estado (tres: pendiente, relacionada, no activada), clave de
> 4 partes con `root_key`, sin "Quitar" ni `ended`, con **Unificar**, contrato con un ítem por producto, registro por cliente × moneda al
> registrar y `target_key` para continuar uno (§1, §2 y §2b); sin migración. Lo escrito antes del 18-10 sobre "serie" y `series_key` queda
> reemplazado por esto.

## 1. Reglas transversales

- Controller `onboarding` con `SupabaseAuthGuard` + `HoldingScopeGuard` + `RequirePermissionGuard`: lecturas `VIEW_CONFIGURACION`,
  escrituras (y vistas previas que validan escrituras) `EDIT_CONFIGURACION`. Holding solo por el header `x-holding-id`.
- Paginación `{ data, total, currentPage, pages, limit }` (default `limit` 25, máx. 200). Errores `{ message, errors?[{ field, message }] }`.
  409 `{ code, message, blockers? }`.
- Toda escritura: `withApiWriter` (transacción con `sapira.writer = 'api'` primero) + evento en `onboarding_events`. Ninguna escritura
  dispara notificaciones, correos ni sincronizaciones (lo verifica `onboarding-history.service.spec.ts` › costura).
- `link` y `contract` reconstruyen el devengo (`revenue_schedule_rebuild`) **solo si el contrato está Activo**: un borrador En revisión no
  tiene devengo (se arma al activarse) y reconstruirlo crearía filas de un borrador que Métricas leería.
- **Registro (18-10, Domi, definitivo)**: lo que lista la bandeja y lo que se opera por clave es `mrr_legacy.batch_id` × cliente comercial ×
  moneda de contrato × contrato (`migrated_to_contract_id`, o sin contrato): "un MRR legacy", las facturas que la usuaria registró de una vez
  para un cliente, con **uno o varios productos** (lo que agrupaba `useMRRLegacyGroups` del front anterior). `batch_id` **no** es el lote de
  importación (`invoices_legacy.import_batch_id`): es el id del registro. Las filas con `migrated_to_contract_id = X` forman el registro
  relacionado con X (uno por contrato) y las filas sin contrato el registro sin contrato; un `batch_id` con varios clientes (cargas masivas) es
  un registro por cliente. Cada registro tiene un solo estado. Nada cambia en los datos (el vínculo sigue por fila) ni en la serie (§2c) ni en
  Métricas.
- **Clave de registro** `key`: base64url de `batch_id|client_id|contract_currency|<contract_id o vacío>` (`encodeLineKey`/`decodeLineKey` en
  `onboarding-common.ts`; `batch_id`, `client_id` y contrato UUID, moneda de 3 letras). La clave anterior (`client_id|product_name|…`) y la de
  3 partes **no** valen como registro → 400 con `errors[{ field }]`. Cada registro trae además `root_key` (base64url de las 3 primeras partes,
  `encodeRootKey`): la misma antes y después de empalmar o desvincular. En `onboarding_events.line_key` va la **raíz** sin codificar
  (`rawRootKey`): el historial sigue al registro; `GET /onboarding/events?lineKey=` acepta la clave del registro o la raíz (`decodeRootKey`).

### Estado derivado de un registro (§3.1)

**Tres estados.** Con contrato: `linked` (la clave lleva el `contract_id`; `issues` solo aplica acá). Sin contrato: `pending` (alguna fila sin
marcar) o `closed` ("No activado": todas marcadas; **código siempre `churn`**, nota libre opcional en `skip_reason`). **Sin `removed`, sin
"Quitar" y sin `ended`** (18-10, Domi): un duplicado se corrige con "Editar línea"; no sabemos si un registro terminó si la usuaria no lo marca.
**Motivo efectivo: `skip_reason_code` o, si está vacío, `churn`; el texto libre no se interpreta** (`legacySkipCodeSql`, `skipReasonCodeOf`).
`legacyRemovedSql` queda por si existiera una fila con código `duplicate` | `error` (prod 18-10: 0 en todos los holdings). Dentro del registro
se calculan `products[]` (uno por nombre: `product_id` del catálogo por nombre, primer y último mes, meses, `mrr_last` de **su** último mes
vivo), `first/last_month`, `live_last`, `mrr_last` (= Σ `products[].mrr_last`, como sumaba el front anterior y como nacen los ítems del
contrato), `months_count`, `invoices_count`, `companies`, `legal_names` y `registered_at` (primera fila).
Prod 18-10 (SimpliRoute, solo lectura, SQL nueva): 11.845 filas, 736 `batch_id` (721 de un cliente; 15 con varios, hasta 39: cargas masivas
de enero y marzo), 161 clientes registrados en varias veces → **960 registros** = 68 pending · 692 linked · 200 closed; 123 con varios
productos (máx. 6: UNILEVER MÉXICO MXN). Avon CARD USD = 5 relacionados (CTR-2026-175/176/210/217/218) + 2 pendientes (1 mes de nov-2024 en el
lote de CTR-176 y 15 meses, 1.440 USD, en otro lote) + 1 no activado MXN con 2 productos; Logytech CLF = 2 relacionados (CTR-93-CL, CTR-94-CO)
+ 1 pendiente (may-2026), todos del mismo `batch_id`. Los lotes masivos: `632cfa2f` 39 registros de 39 clientes, `a94134cb` 33 de 30,
`2a86def2` 25 de 22. (Modelo anterior, serie × contrato: 969 registros sobre 913 series.)

### Corte U14: mes de empalme vs histórico después del contrato (18-10, Domi)

El corte sigue en el conteo (toda fila empalmada en un mes ≥ primer mes con MRR de su contrato deja de contar; Métricas nunca cuenta dos
veces), pero se reporta en dos casos (`legacySeamMonthSql` / `legacyAfterContractSql` de `mrr-historico.ts`, sobre filas recurrentes no quitadas):
- **Mes de empalme** (`period_month = first_month`): normal con ciclos a mitad de mes; se corta en silencio. Solo `summary.splice.seam_months`
  (informativo) y `splice.seam_month` del detalle.
- **Histórico después del inicio del contrato** (`period_month > first_month`): error de datos a corregir. `summary.splice.history_after_contract`,
  `after_contract` de la serie, filtro `issue=history_after_contract` y `issues[]` de la línea, `splice.months_after_contract[]`.

Prod 18-10 (SimpliRoute): mes de empalme en 17 línea × contrato (14 contratos, 22 filas, 24.537,96 USD); histórico después del contrato en
16 meses de 6 líneas y 5 contratos (17 filas, 32.951,67 USD en total; 3.945,79 USD en jul-2026): Buscalibre Mexico (PATHFINDER+ y RETOOL, MXN),
Cuestamoras (WSP STD, USD), SALAV-ROSHFRANS (PATHFINDER+, MXN), Arca Continental Ecuador (PATHFINDER+, USD) y Punto Azul (PATHFINDER+, CLF).
(El `overlap_cut` del 13-10 contaba 83 contratos; con los datos corregidos desde entonces eran 18.)

### Qué cuenta en métricas (una sola regla)

`legacyCountedConditions()`: recurrente + corte U14 (no cuenta la fila empalmada desde el primer mes con MRR de su contrato) + no quitada
(código explícito `duplicate` | `error`). La usan Métricas (`MetricsDataService.loadMrrLines`), Dashboard y lista de Clientes
(`HoldingMetricsService`), Cliente 360 (`ClientMetricsService.getMrr`, antes sin corte ni filtro de recurrente), la serie (§2c) y el `counted`
del detalle de una línea. `legacyRemovedSql` además en Ingresos (aviso `legacy_unlinked`, `RevenueMetricsService`) y en la cobertura de meses de
Registrar histórico.

## 2. Endpoints

### `GET /onboarding/summary`

```json
{ "history": { "records": 960, "pending": 68, "linked": 692, "closed": 200 },
  "splice": { "gap": 29, "seam_months": 17, "history_after_contract": { "months": 16, "records": 6, "contracts": 5 }, "contract_without_mrr": 12 },
  "previous_invoices": { "total": 8975, "without_history": 155, "with_history": 8820, "linked": 267, "adopted": 10, "by_status": { "Pagada": 1734, "Enviada": 7241, "Vencida": 0 } },
  "settings": { "metrics_history_start": "2025-01", "system_currency": "USD" } }
```
Cifras: SimpliRoute en prod, lectura del 18-10 (solo lectura; `splice` y `previous_invoices` de la lectura anterior del mismo día). `history`
cuenta **registros** (`batch_id` × cliente × moneda × contrato, §1) en tres estados: `records` = total; **sin `lines`, `pending_ended`,
`removed` ni `clients_without_contract`** (18-10, Domi). `splice.gap` y `contract_without_mrr` son **por contrato** (como la auditoría S8; el
front renombra `contract_without_mrr` a "Contratos relacionados sin activar"): último mes de MRR histórico empalmado vs primer mes con MRR del
contrato. **18-10**: `overlap_cut` se reemplazó por `seam_months` (mes de empalme, informativo: registros con fila en el primer mes de su
contrato) y `history_after_contract{ months (registro × mes), records, contracts }` (filas en meses posteriores, a corregir), ambos sobre filas
recurrentes no quitadas. `history.closed` conserva la clave: la etiqueta visible es "No activado" (marcadas sin código o con `churn`).
`previous_invoices`: `without_history` = sin MRR histórico registrado (con o sin contrato), `with_history` = con MRR histórico (`without_history +
with_history = total`), `linked` = con contrato vinculado (con o sin histórico), `adopted` = adoptadas como factura del contrato
(`reconciled_invoice_id` no nulo, §4.3b; el front muestra esta y no `linked`, que es un resto del front anterior). **18-10**: se retiró `pending` (sin contrato y sin histórico:
139 contra 155 sin registrar, confundía); prod 18-10: 8.975 = 155 sin histórico + 8.820 con histórico, 267 con contrato.

### `GET /onboarding/history/lines`

Lista **registros** (`batch_id` × cliente × moneda × contrato, §1). Query: `status` (CSV de `pending,linked,closed`; `removed` y
`pending_ended` → 400), `issue` (`history_after_contract` = registros con histórico después del inicio de su contrato, 18-10), `clientId`,
`product` (nombre exacto: registros que **contienen** ese producto; el agregado sigue siendo de todo el registro), `batchId` (el registro),
`contractId`, `search` (cliente, producto o razón social), `page`, `limit`, `sortBy` (`client|product|last_month|mrr|status|registered_at`;
`product` ordena por el producto principal, `status` por prioridad), `sortOrder`. `ended` ya no existe (→ 400). **Sin `sortBy`**: prioridad de
estado (pending → linked → closed) y luego cliente. Fila:

```json
{ "key": "…", "root_key": "…", "batch_id": "…", "client": { "id": "…", "name": "ACME" }, "currency": "USD",
  "products": [{ "product_name": "PATHFINDER+", "product_id": "…|null", "first_month": "2025-01", "last_month": "2026-06", "months_count": 18, "mrr_last": 90.5, "mrr_last_system": 90.5 },
               { "product_name": "Soporte", "product_id": "…", "first_month": "2026-01", "last_month": "2026-06", "months_count": 6, "mrr_last": 30, "mrr_last_system": 30 }],
  "first_month": "2025-01", "last_month": "2026-06", "months_count": 18, "mrr_last": 120.5, "mrr_last_system": 120.5,
  "status": "pending", "contract": { "id": "…", "contract_number": "CTR-2026-9", "status": "Activo" } | null,
  "invoices_count": 18, "skip_reason": "nota|null", "companies": [{ "id": "…", "legal_name": "Simplit SpA" }],
  "legal_names": ["ACME SpA"], "registered_at": "2026-09-01T12:00:00.000Z", "issues": ["history_after_contract"] }
```
`key` = registro (4 partes), `root_key` = raíz (3 partes), §1. `status` = `linked` si tiene contrato; si no, `pending | closed` solo con sus
filas. `products[]` ordenados por `mrr_last` desc; `product_id` = producto del catálogo con el mismo nombre (la tabla no guarda `product_id`);
`mrr_last*` del registro = Σ de los productos en su último mes vivo (sin filas quitadas). `legal_names` = razones sociales (texto de las
facturas) de sus filas; `registered_at` = `MIN(created_at)`. Se retiraron `series_key`, `product_name`, `product_id`, `ended`, `batch_ids`,
`skip_reason_code`.
`companies` (18-10, también en el detalle): compañías emisoras distintas de sus filas (`mrr_legacy.company_id`), por nombre; el front sugiere
registros "del mismo emisor y receptor". `issues` (18-10): `history_after_contract` si el registro tiene filas recurrentes no quitadas
empalmadas en meses posteriores al primer mes con MRR de su contrato; `[]` si no.

### `GET /onboarding/history/lines/:key`

Registro + `months[{ id, period_month, product_name, subtotal_contract_currency, mrr_legacy, mrr_legacy_system_currency, term, is_recurring,
invoice_number, invoice_legacy_id, invoice_currency, amount_invoice_currency (asignado en moneda de factura, misma base que el subtotal: todo el
plazo), fx_contract_to_invoice, fx_contract_to_system, counted, state: pending|linked|closed, contract_id }]` (meses × producto),
`invoices[{ id, invoice_number, issue_date, currency, total, status, contract_id, registration }]`, `splice{ gap_months, seam_month,
months_after_contract[], contract_first_month }` (contra el contrato empalmado; primer mes = RSM o, sin devengo, el primer inicio recurrente;
**18-10**: `overlap_months` se separó en `seam_month` = ese primer mes si el registro también lo tiene, o `null`, y `months_after_contract` =
meses posteriores, a corregir; misma forma en `link` y en la vista previa del contrato), `candidates[{ id, contract_number, status, products[],
currency, start_date, end_date, score }]` (mismo cliente, no borrados ni cancelados; +2 si tiene alguno de los productos del registro, +1
moneda, +1 arranca al mes siguiente; top 10) y `events[]` (últimos 50 **de la raíz**: los mismos antes y después de empalmar). `months[]` e
`invoices[]` son solo los del registro. 404 fuera del holding.

### Escrituras sobre un registro

Toda operación por clave acota las filas al registro (`batch_id`, `client_id`, `contract_currency` y `migrated_to_contract_id IS NULL` o `=
contrato de la clave`, `recordRows` en `onboarding-history.service.ts`): nunca cruza a otro registro de la misma raíz. Sobre un registro con
contrato, `link`, `close`, `reopen`, `unify` y `…/contract` responden 409 con su código antes de tocar la base. Todo evento va con la raíz.

| Ruta | Sobre | Body | Efecto | Respuesta | 409 |
|---|---|---|---|---|---|
| `POST …/:key/link` | sin contrato | `{ contract_id }` | **todas** las filas pendientes (todos los productos) → `migrated_to_contract_id/_at/_by`; sus facturas sin contrato → `invoices_legacy.contract_id`; devengo si Activo | `{ line, splice }`: `line` = el **registro relacionado** resultante (misma raíz × ese contrato, clave nueva); `splice` suma los meses que ese contrato ya tenía en la raíz | `contract_other_client`, `line_not_pending`; 404 contrato |
| `POST …/:key/unlink` | con contrato | — | quita el empalme de todas sus filas; desvincula las facturas que solo respaldaban ese empalme | el **registro sin contrato** resultante (`pending`) | `line_not_linked` |
| `POST …/:key/close` | sin contrato | `{ notes? }` | "No activar": pendientes → `skip_activation`, `skip_reason_code = 'churn'` (siempre), `skip_activation_reason = notes` o NULL | el registro (`closed`) | `line_not_pending` |
| `POST …/:key/reopen` | sin contrato | — | no activadas → pendiente | el registro (`pending`) | `line_not_closed` |
| `POST …/lines/unify` | 2–50 sin contrato, pendientes, mismo cliente y moneda | `{ keys[] }` (el primero manda; repetidas se ignoran) | `UPDATE mrr_legacy SET batch_id = <el del primero>` en las filas de los demás; `UPDATE onboarding_events SET line_key = <raíz resultante>` para las raíces fusionadas; evento `history_unified { batch_id, merged_batch_ids[], rows, records }` | el registro resultante | `record_not_pending` (relacionado o sin pendientes), `unify_mismatch` (otro cliente o moneda); 400 menos de dos distintos o clave rota (`keys.i`) |

`POST …/:key/remove` **se eliminó** (18-10, Domi): no hay "Quitar" ni estado `removed`; un duplicado se corrige con "Editar línea".

### Editar línea (cierre v1 14-10) — ver §2b

La única forma de corregir un registro es `PATCH …/:key` por factura (§2b). `PATCH …/:key/months` (editar meses sueltos) **se retiró el 18-10**
(ruta, DTO, método y spec; la ruta responde 404; no había eventos `history_months_edited` en prod).

### Contrato desde el registro

- `GET …/:key/contract/defaults` → `{ client_id, client_entity_id, company_id, contract_currency, items:[{ key: 'history-N', product_id,
  product_name, item_type: 'Fijo', quantity, unit_price, billing_frequency: 'Mensual', billing_method: 'Anticipado', term_months: 12, start_date,
  is_recurring: true, category: 'RENEWAL' }], products[] (nombres), origin: { type: 'history', record_key }, warnings[] }`. **Un ítem por
  producto del registro** (18-10): unitario = MRR del producto en su último mes vivo ÷ cantidad (cantidad solo si ese mes tiene una sola fila con
  cantidad); inicio = último mes vivo del registro + 1 para todos. Razón social y compañía de la fila con más MRR del último mes. Avisos por
  producto fuera del catálogo o sin MRR, sin razón social y registro sin pendientes.
- `POST …/:key/contract/preview` (body `CreateContractDto` + `origin?` + `products?`) → la respuesta de `POST /contracts/preview` + `splice`
  (contra el primer inicio recurrente del body, con los meses pendientes de los productos elegidos).
- `POST …/:key/contract` (registro sin contrato; body + `products?: string[]` = nombres de los productos del registro que se empalman, por
  defecto todos; uno fuera queda pendiente en el registro sin contrato; un nombre ajeno → 400 `products.i`) → `{ contract: { id,
  contract_number }, line }` con `line` = el **registro relacionado nuevo** (misma raíz × contrato creado). Ítems en `RENEWAL` salvo
  `items[].category` explícita (Domi 14-10: viene de algo que ya existía). `ContractDraftsService.create` (su transacción) y luego el empalme en
  otra; si el empalme falla, el borrador se elimina (`ContractDraftsService.remove`). `origin` y `products` no se mandan al generador ni se
  guardan en el contrato: quedan en el empalme y en el evento `history_contract_created`. 409 `contract_other_client`, `line_not_pending`
  (también sobre un registro con contrato o si los productos elegidos no tienen pendientes).

### Facturas previas

- `GET /onboarding/previous-invoices` — query `status` (CSV `Pagada,Enviada,Vencida`), `linked` (`true|false`), `hasHistory` (`true|false`),
  `clientId`, `entityId`, `companyId` (emisora), `country` (ISO-2 de la razón social, `client_entities.country_code`), `batchId`, `search`,
  `from`, `to` (AAAA-MM-DD), `page`, `limit`, `sortBy` (`issue_date|due_date|invoice_number|client|total|status`), `sortOrder`. Fila: `{ id,
  invoice_number, issue_date, due_date, entity{id,legal_name,tax_id}|null, legal_client_name, client_tax_id, client{id,name}|null,
  company{id,legal_name}, currency, amount, vat, total, status, source_type, source_system, notes, country, origin: 'external',
  contract{id,contract_number}|null, batch_id, has_history, adopted{ invoice_id, invoice_number, status, contract_id, contract_number }|null }`.
  Query `adopted` (`true|false`): adoptadas como factura del contrato (§4.3b de la spec) o no.
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
  `{ batch_id, inserted, skipped_duplicates, errors, entities_created, needs_client, history_rows_created, history_records_touched[] (claves),
  history_batch_ids[] (registros de MRR legacy creados: uno por cliente × moneda, 18-10), history_skipped[{ row, invoice_number, reason }] }`
  (histórico de las facturas `ready`, §2b). **Nunca crea clientes comerciales** (`client_id`
  ajeno → 400). Con `client_id` la razón social nace por `insertClientEntity` (camino único de Clientes); sin él, suelta. Se insertan
  `new` y `needs_client` (sin cliente); `errors` cuenta `error` + `needs_entity` no resueltas. 409 `nothing_to_import` (rollback total).
- `POST /onboarding/previous-invoices/:id/client` `{ client_id }` → detalle de la factura. Inserta el vínculo en `client_entity_clients`
  (principal si la razón social no tenía cliente; el trigger `sync_client_entity_primary_client` copia `client_entities.client_id`) y
  completa `client_id` en las facturas previas de esa razón social que no lo tenían. 409 `invoice_without_entity`; 404 cliente o factura.
- `POST /onboarding/previous-invoices/register-history/preview` — body `{ invoices:[{ invoice_id, period_from, period_to,
  contract_currency, amount_contract_currency, is_recurring?, products:[{ product_id, amount_contract_currency }], target_key? }],
  target_key? }` (máx. 2.000) → `{ rows:[{ invoice_id, invoice_number, invoice_currency, amount_invoice_currency, months[], mrr_per_month,
  fx_contract_to_invoice, products[{ product_id, product_name, amount, mrr_per_month }], record_key, record_exists, existing_records[{ key,
  batch_id, products[], first_month, last_month, months_count, mrr_last, registered_at }], warnings[], errors[] }], summary{ invoices, ready,
  with_warnings, with_errors, rows_to_create, records_touched[], records_to_create } }`. **Registro de destino (18-10, Domi)**: al aplicar
  nace un registro (`batch_id`) **por cliente × moneda de contrato** dentro de la misma aplicación (como el modal del front anterior), con todos
  los productos de la factura adentro, salvo `target_key` ("continuar un registro": un registro **pendiente** existente del mismo cliente y
  moneda al que se suman las filas; por factura, o global para las que no traen el suyo). `record_key` = la clave del `target_key` validado o
  `null` (el `batch_id` nuevo no existe aún); `record_exists` = se suma a uno existente; `existing_records[]` = registros pendientes del cliente
  en esa moneda, para elegir uno. `summary.records_touched` = claves distintas de los registros existentes que recibirían filas (sin las
  facturas bloqueadas); `records_to_create` = registros nuevos (cliente × moneda sin destino). Helpers `OnboardingRegisterService.recordsOf` /
  `pendingRecords` (reutilizan `lineCtes`). Avisos: `sum_mismatch` (Σ productos vs monto ±1 %), `month_already_covered` (el cliente × producto ×
  moneda ya tiene ese mes), `fx_outlier` (misma moneda y fx ≠ 1, o ±20 % de la mediana del holding para el par),
  `fx_one_with_different_currencies` (monedas distintas y fx entre 0,98 y 1,02: el monto de contrato se copió del de factura; 14-10),
  `no_client`. Una sola regla: `fxWarningsOf` + `loadFxReferences` de `onboarding-register.service.ts`. Errores: `not_found`,
  `already_registered`, `invoice_without_items`, `invalid_period` (hasta < desde o > 36 meses), `invalid_amount`, `product_not_found`,
  `duplicate_product`, `currency_not_enabled`, `no_client`, `target_not_found` (no es un registro pendiente del holding), `target_mismatch`
  (otro cliente u otra moneda); un `target_key` que no decodifica es 400 (`invoices.i.target_key` | `target_key`).
- `POST /onboarding/previous-invoices/register-history` → `{ created_rows, records_touched[] (keys), batch_ids[], skipped[{ invoice_id,
  reason }] }`. Una fila `mrr_legacy` por producto × mes no cubierto: `split_index` = posición del producto, `invoice_item_legacy_id` = primera
  línea de la factura, `subtotal_contract_currency` = parte del producto por todo el período, `term` = meses, `mrr_legacy` = parte ÷ meses,
  `fx_contract_to_invoice` = neto de factura ÷ monto de contrato, `allocated_invoice_currency` = parte × fx, `product_name` del catálogo
  (`mrr_legacy` no tiene `product_id`), `batch_id` = el del registro (§ arriba). Marca `reconciliation_status = 'mrr_legacy'`. Evento
  `history_registered` por factura con la raíz del registro y `continued` (raíz del `target_key`, o `null`). Bloquean: los errores y
  `sum_mismatch`.
- `POST /onboarding/previous-invoices/import/:batchId/revert` → `{ batch_id, removed, history_rows_removed }` (borra las facturas del lote y
  sus líneas y, antes, el MRR histórico **que creó la misma importación**: `mrr_legacy.batch_id` ∈ `history_batch_ids` del evento
  `previous_invoices_imported` del lote —o el lote mismo si la importación es anterior al 18-10— y sin empalmar). 404 lote inexistente; 409
  `batch_has_history` (histórico ajeno a esos registros —otro registro, una unificación— o empalmado) | `batch_linked` | `already_reverted`. Las
  razones sociales creadas por la importación se conservan.
- `GET /onboarding/previous-invoices/batches` → `[{ id, label, created_at, created_by, count, reverted }]` (desde los eventos
  `previous_invoices_imported` / `previous_invoices_reverted`).

### Adoptar como factura del contrato (§4.3b de la spec; `onboarding-adopt.service.ts`)

- `POST /onboarding/previous-invoices/adopt/preview` `{ contract_id?, invoices:[{ invoice_id, months?: ['AAAA-MM'] (1–24, por defecto el mes de
  emisión), keep_remainder? }] }` (1–50) → `{ client, contracts[{ id, contract_number, status, contract_currency, client_entity_id, company_id,
  first_month, last_month, pending_months[] }] (del cliente comercial de las facturas; `pending_months` = meses con Por Emitir sin borrador en
  el ERP), contract|null, invoices[{ invoice, months[], keep_remainder, targets[{ month, kind: 'replace'|'create', invoice_id (Por Emitir que se
  reescribe | factura plantilla), target_amount_contract_currency, coverage_contract_currency, remainder_contract_currency|null,
  template_invoice_number }], amounts{ contract_currency, invoice_currency, fx_contract_to_invoice, amount_contract_currency,
  vat_contract_currency, status }|null, history_months[], blockers[{ code, message }], warnings[{ code, message }], can_apply }], can_apply }`.
  Bloqueos: `already_adopted`, `no_client`, `other_client`, `no_issue_date`, `no_amount`, `contract_other_client`, `contract_without_invoices`,
  `month_already_invoiced`, `erp_draft`, `before_contract`, `fx_missing`. Avisos: `amount_differs` (> 10 % sin remanente), `entity_differs`,
  `company_differs`. Cobertura por mes = neto en moneda de contrato × neto del destino ÷ Σ destinos (`allocateCoverage`).
- `POST /onboarding/previous-invoices/adopt` `{ contract_id, invoices[], notes? }` → todo o nada (contrato `FOR UPDATE`, vista previa
  recalculada dentro de la transacción): `{ applied, contract, adopted[{ previous_invoice_id, invoice_number, invoices[{ invoice_id, month,
  created, remainder_invoice_id }] }] }`. Por destino: `replace` = `UPDATE invoices` (estado, número, fechas, moneda, fx, neto/IVA/total,
  `is_legacy`, `legacy_invoice_id`, `legacy_source_system`, `odoo_invoice_id`, `sent_to_odoo_at = now()`, `pdf_url`, nota) con
  `status = 'Por Emitir'` como condición (409 `target_changed`), líneas reescaladas (`scaleLines`, `fx_rate_source = 'previous_invoice'`);
  antes, si hay remanente, `INSERT` de la Por Emitir nueva (copia del encabezado, `split_from_invoice_id`, `split_reason = 'legacy_partial'`).
  `create` = `INSERT invoices` + `invoice_items` desde la plantilla (409 `template_missing`). Luego `refreshInvoiceSystemAmounts`, evento
  `INVOICE_ADOPTED_FROM_PREVIOUS` en `contract_lifecycle_events` por destino, `DELETE mrr_legacy` de la previa (meses en el evento),
  `invoices_legacy.reconciliation_status = 'migrated'` + `reconciled_invoice_id` (primer destino) + `contract_id` + `reconciled_at`, evento
  `previous_invoice_adopted`; al final un `revenue_schedule_rebuild(contrato, primer mes tocado)`. No toca `contract_invoices`.
  Pagos: el ERP busca por `x_sapira_invoice_id`, que la factura del ERP no lleva → la adoptada conserva su estado (mejora pendiente: propagar
  el estado de la previa desde el import de staging).

### Arranque rápido

- `POST /onboarding/quick-start/preview` `{ as_of: 'AAAA-MM', entity_ids?, history_months? (0–24) }` → `{ proposals:[{ entity{id,legal_name},
  client{id,name}|null, last_invoice{ id, number, issue_date, total, amount, currency }, items[{ description, quantity, unit_price, subtotal,
  product_id|null, product_suggestion{id,name}|null }], contract{ start_date, currency, billing_frequency, billing_method },
  history_months_found, flags[] }], summary{ proposals, ready, flags{ no_client, no_product, already_has_contract, multi_currency },
  by_currency[], records_to_create } }`; cada propuesta trae además `invoice_currency`, `amount_invoice_currency`, `fx_contract_to_invoice`,
  `warnings[]`, `errors[]` (14-10) y `existing_records[]` (18-10: registros **pendientes** del cliente comercial en la moneda completada, misma
  forma que en Registrar histórico; solo para las propuestas con lo completado, `[]` si no). Ya no hay `line_key`/`line_exists`/`lines_touched`:
  el arranque crea un registro (`batch_id`) **nuevo por propuesta** (cliente × moneda), que nace relacionado con el contrato creado. Body
  opcional `proposals?` (mismo de aplicar): con él, fx, avisos y errores salen del motor de Registrar histórico; sin él, la propuesta es en la
  moneda de la factura (fx 1, sin avisos). Última factura = emitida antes del día 1 del mes siguiente a `as_of`. `product_id` solo si el código
  de la línea calza exacto con `products.product_code`; `product_suggestion` si además (o solo) la descripción calza exacta con el nombre. Sin
  descripción → ambos `null` y `no_product`. Nunca propone período.
- `POST /onboarding/quick-start` `{ as_of, proposals:[{ entity_id, period_from, period_to, contract_currency, amount_contract_currency,
  products:[{ product_id, amount_contract_currency, quantity?, unit_price? }], billing_frequency?, billing_method?, term_months? }] }` →
  `{ created:[{ entity_id, contract{ id, contract_number }, history_rows, record_key }], skipped:[{ entity_id, reason, message? }] }`
  (`record_key` = el registro relacionado nuevo: su `batch_id` × cliente × moneda × contrato creado). Por cliente: contrato En revisión con
  `ContractDraftsService.create` (un ítem por producto, `item_type` Fijo, categoría `RENEWAL`, cantidad o 1, unitario o monto mensual ÷
  cantidad, inicio = mes siguiente al último mes cubierto —el `period_to` o el de emisión si es posterior—, 12 meses, Mensual Anticipado por
  defecto) y después, en otra transacción, el registro de la última factura (mismo motor que Registrar histórico) con las filas ya
  empalmadas al contrato y la factura vinculada. Si el registro falla, el borrador se elimina. Motivos de `skipped`: `no_invoice`,
  `no_client`, `no_product`, los errores de Registrar histórico, `contract_error`, `history_error`.

### `GET /onboarding/events`

Query `lineKey?` (la clave de un registro —con o sin contrato— o su `root_key`: **se busca por la raíz** `batch_id|client_id|contract_currency`,
así el historial sigue al registro aunque se empalme o se desvincule; clave rota → 400), `entityId?`, `page`, `limit` → paginado de `{ id,
type, line_key (raíz codificada; `null` si el evento guardó otra forma), entity_type, entity_id, payload, actor{id,name}|null, created_at }`.
Tipos: `history_line_edited`, `history_linked`, `history_unlinked`, `history_closed`, `history_reopened`, `history_unified`,
`history_contract_created`, `history_registered`, `previous_invoices_imported`, `previous_invoices_reverted`, `previous_invoice_client_linked`,
`quick_start_applied`, `previous_invoice_adopted`. `history_removed` se retiró (18-10; prod: 0 eventos guardados de cualquier tipo). Al
unificar, los eventos de las raíces fusionadas pasan a la raíz resultante.

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
- **Semántica**: por cada factura listada se borran sus filas de `mrr_legacy` **en este registro** (mismo `batch_id`, cliente, moneda y
  contrato; todos sus productos) y se regeneran con `OnboardingRegisterService.registerInTx` en modo `replace` (`ReplaceOptions`) **con el
  mismo `batch_id`** (18-10): no rige `already_registered`; el cliente es el del registro; los meses de las filas reemplazadas no cuentan como
  cubiertos (`month_already_covered` solo contra otras facturas del mismo cliente × producto × moneda); el tipo de cambio parte del monto en
  moneda de factura que el registro tenía asignado de esa factura (Σ `allocated_invoice_currency` ÷ plazo de sus filas; sin él, el neto de la
  factura), no del neto completo (que puede repartirse en otros registros); los `split_index` nuevos van después de los usados en esa línea de
  factura. Mismas fórmulas que Registrar histórico (`subtotal` = parte del producto por todo el período, `term` = meses, `mrr_legacy` = parte ÷
  meses, `allocated` = parte × fx).
- Las filas nuevas **conservan** el empalme de las reemplazadas (`migrated_to_contract_id/_at/_by`) y, si todas estaban no activadas, ese
  estado; el `INSERT` devuelve `RETURNING id` y esas marcas se aplican solo a las filas recién insertadas (nunca a otras del mismo lote). Una
  factura con meses empalmados que cambia de **moneda** → 409 `line_linked_rekey` (período, montos y productos sí: el producto vive dentro del
  registro). Una factura que queda sin filas (todo cubierto) vuelve a `reconciliation_status = 'pending'`.
- Si la moneda cambia, las filas nuevas caen en el registro de la misma raíz con esa moneda: `lines_touched[]` (el propio y el de destino) y
  `rekey: { from, to }` cuando **todo** el registro se movió a uno solo de destino. Cambiar un producto ya no mueve nada (18-10).
- **Vista previa** → `{ line{ key, batch_id, currency, products[{ product_name, product_id, mrr_last }], first_month, last_month,
  months_count }, months[{ period_month, subtotal_contract_currency (mensual), mrr_contract_ccy, mrr_system_ccy, fx_contract_to_system,
  invoice_id, invoice_number, invoice_currency, amount_invoice_currency (mensual), fx_contract_to_invoice, is_recurring, products[], status }],
  totals{ mrr_last_contract_ccy, mrr_last_system_ccy, system_currency }, warnings[{ code, invoice_id?, period_month?, message }], rekey,
  lines_touched[] }`. `line` y `months` son del registro resultante (el de destino si hay `rekey`), por factura × mes: `kept` (igual), `changed`
  (otros montos, recurrencia, productos o registro), `added`, `removed`. Moneda de sistema de lo regenerado: `loadLegacySystemFx`
  (`src/modules/metrics/mrr-historico-fx.ts`, réplica del trigger `calculate_mrr_legacy_system_currency`); lo que no cambia muestra lo
  guardado. Avisos del motor por factura (`sum_mismatch`, `fx_outlier`, `fx_one_with_different_currencies`, `no_client`;
  `month_already_covered` uno por mes) y `line_linked_rekey_blocked`. Helpers puros en `onboarding-line-edit.ts`.
- **PATCH** → `{ line | null, key, lines_touched[] }` (`key` = la de destino si hubo `rekey`; `line` null si el registro quedó vacío). Eventos:
  `history_registered` por factura (del motor) y `history_line_edited` (registros pedidos, antes/después, filas borradas y creadas,
  `lines_touched`, `rekey`, `record_key`, `batch_id`), ambos con la raíz del registro. Se edita cualquier registro; las filas nuevas heredan su
  contrato, así una factura de un registro relacionado sigue en ese registro.
- **Detalle del registro**: `months[].product_name` (meses × producto) e `invoices[].registration: { period_from, period_to, contract_currency,
  amount_contract_currency (total), is_recurring, products: [{ product_id, product_name, amount_contract_currency }] }` (uno por producto de la
  factura en este registro; Σ subtotal ÷ plazo; `product_id` null si el nombre no está en el catálogo), para prellenar el formulario.

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

Para el Resumen: ver mes a mes el MRR histórico que cuenta (por concepto y por dimensión), el histórico después del inicio del contrato, lo
quitado y el traspaso histórico → contrato. Lectura
`VIEW_CONFIGURACION`. Código: `onboarding-series.service.ts` (reutiliza `legacyCountedConditions`/`legacyRemovedSql` de
`src/modules/metrics/mrr-historico.ts` y la regla del devengo de `MetricsDataService.loadMrrLines`; nada duplicado).

### `GET /onboarding/history/series`

Query: `currency` (`system` por defecto | `contract` | `invoice`), `companyId` (compañía emisora, `mrr_legacy.company_id`), `clientId` (cliente
comercial), `entityId` (razón social receptora: la de la factura de origen, `invoices_legacy.client_entity_id`), `country` (ISO-2 de esa razón
social, `client_entities.country_code`), `from`, `to` (`AAAA-MM`), `groupBy` (`none` por defecto | `client` | `entity` | `product` | `company`),
`top` (1–1000, por defecto 15; 1000 = todas, para desplegar "Otros") y `concept` (opcional: `linked` | `not_activated` | `pending`; sin él, los tres). Por defecto `from` = el mayor entre
`metrics_history_start` del holding y el primer mes con datos del filtro (como
Métricas); `to` = el último mes con datos del filtro (en SimpliRoute, 2027-02 por facturas multi mes: el front puede pedir `to` = mes en curso).
`to < from` o más de 120 meses → 400.

```json
{ "currency_mode": "system", "system_currency": "USD",
  "months": [{ "month": "2026-09", "counted": 47004.83, "counted_linked": 33811.85, "counted_not_activated": 23.16, "counted_pending": 13169.82,
               "after_contract": 0, "removed": 0, "contracts": 465641.69, "by_currency": [] }],
  "rows": [{ "key": "<client_id>", "label": "Grupo F", "currency": null, "values": [29700] }, { "key": "others", "label": "Otros", "currency": null, "values": [180.27] }],
  "totals": { "last_month": "2026-09", "counted_last": 47004.83, "lines": 24, "clients": 22, "rows_total": 77 },
  "filters_applied": { "currency": "system", "companyId": null, "clientId": null, "entityId": null, "country": null, "groupBy": "client", "top": 15,
                       "concept": null, "from": "2026-09", "to": "2026-09" } }
```

- Solo filas **recurrentes** (el MRR histórico es recurrente). Por fila: `removed` si está quitada (código explícito `duplicate` | `error`); si
  no, `after_contract` si su mes es **posterior** al primer mes con MRR de su contrato empalmado (histórico después del inicio del contrato, error
  de datos); el **mes de empalme** (mismo mes) se corta en silencio y no aparece en ningún monto (18-10); si no, `counted`. `counted` es
  exactamente lo que suma Métricas (`legacyCountedConditions`); `counted + after_contract + removed` = todo el MRR histórico recurrente del mes
  menos el de los meses de empalme.
- **Por concepto (18-10)**: `counted = counted_linked + counted_not_activated + counted_pending`. `counted_linked` = filas empalmadas a un
  contrato (meses anteriores al corte); `counted_not_activated` = no empalmadas, `skip_activation` con motivo efectivo `churn` ("No activado",
  incluye el "No aplica" viejo sin código); `counted_pending` = ni empalmadas ni marcadas. Igual en cada entrada de `by_currency`.
- **Filtro por concepto (18-10, Domi: "al ver por cliente, razón social, producto o compañía, filtrar por concepto")**: con `concept`
  (`linked` | `not_activated` | `pending`), lo que cuenta se limita a las filas de ese concepto con **el mismo predicado** que separa los
  `counted_*` (`CONCEPT_SQL` en `onboarding-series.service.ts`; no hay otra regla): `months[].counted` = `counted_<concept>` y los otros dos
  `counted_*` van en 0, también en `by_currency`; `rows[]`, "Otros" y `totals.rows_total` consideran solo esas filas (filas + Otros siguen
  cuadrando con `counted`); `totals.counted_last` también. `after_contract` y `removed` **no cambian** (no son conceptos de lo que cuenta), ni
  `contracts`, `lines` y `clients` (filas del filtro, con o sin concepto). `filters_applied.concept` (`null` sin él). Valor fuera de la lista → 400.
- Montos: `system` = `mrr_legacy_system_currency`; `contract` = `mrr_legacy` agrupado por `contract_currency`; `invoice` =
  `allocated_invoice_currency ÷ term` agrupado por `invoice_currency`. En `contract` e `invoice`, los montos del mes son `null` y
  `by_currency[{ currency, counted, counted_linked, counted_not_activated, counted_pending, after_contract, removed }]` trae una entrada por
  moneda (en `system`, `by_currency` = `[]`).
- **Por dimensión (18-10)**, con `groupBy` ≠ `none`: `rows[{ key, label, currency, values[] }]` con `values` alineado con `months` (la `counted`
  del mes en la moneda del modo). `client` = cliente comercial (`clients.name_commercial`), `entity` = razón social receptora de la factura de
  origen (sin factura: `key` `none`, "Sin razón social"), `product` = `product_name`, `company` = compañía emisora. En `system` hay una fila por
  entidad (`currency: null`); en `contract`/`invoice`, una por entidad × moneda (`key` + `currency` es único). Se devuelven las `top` primeras
  por su `counted` **en moneda de sistema** del último mes del rango con datos (desempate por la suma del rango, luego etiqueta) y, si quedan
  más, una fila `{ key: 'others', label: 'Otros' }` (en `contract`/`invoice`, una por moneda con sobrante) calculada como `counted` del mes −
  filas mostradas: **filas + Otros = `counted`** del mes (o de la moneda) al centavo. `totals.rows_total` = entidades distintas con monto en el
  rango; con `groupBy=none`, `rows` = `[]` y `rows_total` = `null`.
- `contracts`: MRR del devengo (`revenue_schedule_monthly.mrr_period_contracted_system_ccy`, sin filas de total ni de pendiente de renovar,
  contratos no borrados: la columna y el filtro de Métricas, que es la misma cifra que `mrr_period_system_ccy` salvo el pendiente de renovar)
  de los contratos empalmados a filas del filtro (sin el rango: una línea no se corta por mes), siempre en moneda de sistema.
- Meses sin datos van con ceros. `totals.last_month` = `to`; `counted_last` = `counted` de ese mes **en moneda de sistema** en los tres modos;
  `lines` y `clients` = líneas (cliente × producto × moneda) y clientes con filas del filtro en el rango.
- Prod 18-10, sin el texto libre (SimpliRoute, `system`, `counted` = linked + no activado + pendiente · `after_contract` · `contracts`): 2026-07
  119.774,72 = 81.300,15 + 699,05 + 37.775,52 · 3.945,79 · 419.564,47; 2026-08 60.054,17 = 37.811,52 + 23,16 + 22.219,49 · 0 · 465.322,11;
  2026-09 47.004,83 = 33.811,85 + 23,16 + 13.169,82 · 0 · 465.641,69. `groupBy=client` (jul–sep): 15 clientes + Otros (72.950,16 · 12.941,07 ·
  180,27) de 77, suma = `counted` al centavo en los tres meses; lo mismo con `entity` (80), `product` (7, sin Otros) y `company` (4); en
  `contract` cuadra por moneda. La partición por concepto cuadra en los 38 meses de la serie completa.

### `GET /onboarding/history/filter-options`

`{ companies: [{ id, legal_name }], countries: string[], currencies: { contract: string[], invoice: string[] }, products: string[] }`: solo lo presente en el MRR
histórico del holding (compañías de `mrr_legacy.company_id`, países de la razón social de la factura de origen, monedas de contrato y de
factura). Prod 18-10: 5 compañías, 16 países, contrato `CLF, CLP, COP, MXN, PEN, USD, UYU`; factura además `UF` (filas viejas con `UF` en vez
de `CLF`: dato, no se normaliza aquí).

## 3. Otros cambios de la entrega

- Etiquetas visibles: `sourceLabel` "MRR histórico", motivo de churn "MRR histórico sin contrato", subcategorías "MRR histórico nuevo /
  terminado", "Variación MRR histórico", "MRR histórico → contrato", fórmula del MRR y el aviso `legacy_unlinked` de Ingresos. Los códigos
  internos (`source = legacy`, `LEGACY_*`) no cambian.
- Filas quitadas (duplicado o error) dejan de contar en Métricas, Dashboard, Clientes y Cliente 360. **18-10**: solo con código explícito; la
  lectura del texto libre (58 filas de SimpliRoute) se retiró y esas filas vuelven a contar como "No activado" (§1).

## 4. Fuera de esta entrega

Mapeo libre de columnas, planilla de MRR histórico directo, contratos vigentes con `facturar_desde`, última factura multi período
(§3.3.4) y facturas previas en Cobranza (entrega 2); checklist, alta por términos y retiro de RPC/tablas viejas (entrega 3).
