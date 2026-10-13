# Spec — Onboarding de datos históricos y MRR histórico (v2)

> **Estado: aprobada para construir en el laboratorio (Domi, 13-10-2026).** Base: decisiones S8-1…S8-8 de
> [`auditoria-contratos.md`](./auditoria-contratos.md) (24-09), §1.8 de [`spec-revenue-y-metricas.md`](./spec-revenue-y-metricas.md),
> [`analisis-fx-y-mrr-historico.md`](./analisis-fx-y-mrr-historico.md), el diseño de onboarding masivo del front viejo
> (`sapira-ai/docs/onboarding/DISEÑO_onboarding_masivo.md`) y la práctica de la industria (ChartMogul, Baremetrics, Chargebee,
> Zuora, Maxio, Stripe, Ordway, Zenskar). No cubre el pre-onboarding comercial (`spec-preonboarding-prueba-guiada.md`).
> Nace en `/lab/onboarding` (solo super admin) y se publica como submódulo de Administración ("Datos históricos").

## 1. Por qué desde cero

- Hoy **ninguna ruta de la API escribe el histórico**: `mrr_legacy`, `invoices_legacy`, `invoice_items_legacy` y
  `invoice_items_legacy_match` se cargaban con RPC del front viejo o con SQL en producción; las funciones siguen expuestas y
  nadie las llama.
- El front viejo tenía **tres caminos paralelos** (factura → MRR legacy → contrato; contrato legacy → conciliar facturas →
  activar; relacionar a contrato existente), conciliación línea a línea con cuatro triggers y mucho código muerto.
- **El histórico sí se usa.** Solo SimpliRoute: 11.848 filas (2024-01 → 2027-02, 684 clientes, 863 pares cliente × producto),
  9.657 empalmadas a 527 contratos, 1.615 "no aplica" con motivo en texto libre y **665 pendientes** en 67 líneas (63 ya
  terminaron y salen como churn falso; 4 vigentes). 196 clientes con histórico no tienen contrato. Empalme: 403 exactos, 83 con
  solape (U14 lo corta), **28 con hueco**, **12 sin MRR en el devengo**. Facturas previas: SimpliRoute 8.975 (132 pendientes),
  TiMining 119 y uPlanner 254 (migradas a `invoices` con `is_legacy`).
- **Brasil y Argentina** (SimpliRoute, no facturan desde el ERP): 60 + 35 razones sociales, cero contratos, cero historia. Hay
  una planilla con 1.921 facturas de Brasil (nov-2024 → ago-2026, 126 clientes, 100 con factura en 2026, BRL, sin RUT, sin
  producto ni descripción en las líneas; 95 facturas de 79 clientes en jul-2026). Es el **piloto** del módulo.

### Por qué las facturas son la fuente (Domi)

Los clientes grandes no conocen sus contratos ni tienen el MRR cuadrado con lo facturado: las planillas de MRR de
SimpliRoute estaban infladas y desactualizadas; la única fuente honesta fue la factura. Otros holdings (uPlanner, TiMining)
sí tienen sus contratos controlados en planillas. El módulo soporta las tres entradas y las lleva al mismo resultado.

## 2. Principios

1. **Arranque rápido es el camino principal** (S8-1): por cliente, la **última factura** a una fecha define el estado
   vigente; de ahí nace el contrato con fecha de corte. La historia anterior (MRR histórico) es opcional y se completa
   después, o nunca.
2. **Dos cosas distintas**: el contrato vigente factura y devenga desde el corte; el histórico entra como MRR por cliente ×
   producto × mes. Nunca se generan facturas ni devengo "sintéticos" de meses históricos ni saldos de apertura: con el
   arranque desde la última factura el saldo sale solo, y cuando hay facturas reales se reconstruye desde ellas (como se hizo
   con TiMining y uPlanner).
3. **Un mes, una fuente por línea** (U14, ya en producción): el histórico cuenta hasta el mes anterior al primer mes con MRR
   del contrato empalmado. El cambio de fuente no es "nuevo" ni "churn".
4. **Facturas previas = evidencia y cobranza**: externas, sin DTE, sin ERP, sin impuestos recalculados, sin devengo. Las
   pendientes y vencidas sirven para cobrar; las pagadas, para el historial del cliente.
5. **Motor único de import** (S8-5): archivo → mapeo de columnas → validación con errores por fila → **vista previa
   obligatoria** → aplicar en una transacción → lote reversible. Durante la importación no salen correos, tareas ni
   sincronizaciones. **Nunca se crean clientes ni razones sociales solos**: la vista previa los propone y la usuaria los
   confirma en bloque, con país y moneda explícitos.
6. **Sin conciliación línea a línea** ni catálogo de motivos: una línea sin contrato que terminó fue **baja**; un duplicado o
   un error de carga se **quita** (deja de contar en todo), no se marca. Nada se borra físicamente.
7. **Sin SQL en producción**: todo lo que hoy se hace a mano (registrar, empalmar, cerrar, corregir, cargar un mes nuevo)
   tiene su acción en pantalla con vista previa.

## 3. Modelo

### 3.1 Línea de MRR histórico (sobre `mrr_legacy`, sin tabla nueva)

- **Grano de lectura**: cliente comercial × producto × moneda de contrato (clave `client_id|product_name|contract_currency`);
  las filas siguen siendo mes × ítem de factura. `product_id` obligatorio en lo nuevo (el texto `product_name` se conserva).
- **Estado derivado**: `pending` (sin empalme ni cierre; `pending_ended` si su último mes ya pasó), `linked`
  (`migrated_to_contract_id`), `closed` (`skip_activation` con motivo `churn`: cuenta hasta su último mes), `removed`
  (`skip_activation` con motivo `duplicate` | `error`: no cuenta en nada). Los 1.615 textos libres actuales se leen como
  `churn` salvo que contengan "duplic" o "error" (sin tocar datos; se normalizan al escribir).
- **Validaciones**: un mes no se repite en la misma línea; al empalmar se informa hueco (último mes + 1 ≠ primer mes con MRR
  del contrato) y solape (lo corta U14); el contrato debe ser del mismo cliente comercial (otra moneda está permitida, S8-1).
- **Edición** de meses (monto en moneda de contrato, recurrente) con registro de cambios (M15).

### 3.2 Facturas previas (`invoices_legacy` + `invoice_items_legacy`)

- Entran por planilla (mismas dos hojas que la plantilla que ya conocen los clientes) o desde el ERP (staging existente).
  Campos: número, fechas, razón social (RUT o nombre exacto), compañía emisora, moneda, neto, IVA, total, estado de cobro
  (`Pagada` | `Enviada` | `Vencida`), notas; líneas con descripción, producto (opcional), cantidad, unitario, subtotal.
- Deduplicación por `holding + invoice_number` y por id del ERP; marca `origen: externa` donde se muestren.
- **Se retiran del flujo nuevo**: `invoice_items_legacy_match`, `reconciliation_status` con cinco valores (queda `pending` |
  `mrr_legacy` | `linked`), el bloqueo `has_legacy_invoices` de la activación y las 15 RPC `*_legacy*` (DROP tras la migración
  de lo pendiente, con la ventana de observación de `saneamiento-contratos.md`).

### 3.3 Arranque rápido (contrato desde la última factura)

Por cliente (razón social) con facturas previas, a una fecha `as_of` (mes):

1. Se toma la última factura del cliente hasta `as_of`; sus líneas definen los ítems (producto del catálogo elegido en la
   vista previa, cantidad, unitario, moneda); frecuencia por defecto mensual anticipada (editable).
2. Se crean las filas de MRR histórico del mes de esa factura (y, si la usuaria lo pide, de los N meses anteriores que estén
   en la planilla), con origen `facturas_previas`.
3. Se crea el contrato **En revisión** con el generador común de Contratos (`ContractDraftsService.create`), inicio = **mes
   siguiente** al de la última factura, y la línea queda empalmada (`migrated_to_contract_id`); las facturas quedan vinculadas
   (`invoices_legacy.contract_id`). Se activa después desde Contratos (en lote).
4. Caso especial, "la última factura cubre varios meses" (anual anticipada): inicio = primer día del período de esa factura y
   la factura se migra a `invoices` como externa cubriendo ese período (`is_legacy`, `legacy_invoice_id`,
   `contract_invoices.satisfied_by_legacy_id`), que es el mecanismo que ya usaron TiMining y uPlanner. **Entrega 2.**

### 3.4 Configuración por holding

- `holding_settings.metrics_history_start` (A7, opción a): primer mes que muestran Métricas (SimpliRoute: 2025-01; hoy arranca
  en 2024-01 por el mínimo de la tabla). Editable en Administración › Holding › Preferencias.

### 3.5 Esquema (una migración, aplicar con OK de Domi: QA → prod)

| Cambio | Para qué |
|---|---|
| `holding_settings.metrics_history_start date NULL` | §3.4 |
| `invoices_legacy.import_batch_id uuid NULL` + índice | lote reversible de facturas previas |
| `mrr_legacy.skip_reason_code text NULL` (`churn` \| `duplicate` \| `error`) | motivo normalizado; el texto libre queda en `skip_reason` |
| tabla `onboarding_events` (`id, holding_id, type, line_key, entity_type, entity_id, payload jsonb, actor_id, created_at`) | registro de cambios (editar, empalmar, cerrar, quitar, importar, revertir, arranque rápido) |

## 4. Pantallas (`/lab/onboarding`; destino Administración › Datos históricos)

### 4.1 Resumen

Indicadores del empalme (líneas pendientes, pendientes que ya terminaron, huecos, solapes cortados, contratos sin MRR en el
devengo, clientes con histórico y sin contrato, facturas previas pendientes) y el inicio de la historia. Entrega 3 agrega el
checklist de onboarding del holding (compañías → usuarios → productos → conexiones → contratos → histórico → facturas previas →
empalme).

### 4.2 MRR histórico (bandeja)

Lista por línea: cliente, razón social, producto, moneda, primer y último mes, MRR del último mes (moneda de contrato y de
sistema), estado, contrato, lotes, facturas de respaldo. Filtros: estado (con "terminó sin resolver"), cliente, producto, lote,
búsqueda. Vista rápida con la grilla de meses editable. Acciones en la barra de selección:

| Acción | Qué hace |
|---|---|
| Relacionar con contrato | Contrato del mismo cliente (sugiere por producto y moneda); muestra hueco o solape antes de confirmar. |
| Crear contrato desde el histórico | Alta En revisión prellenada (inicio = mes siguiente al último, cantidad y precio del último mes). Vista previa del backend. |
| Cerrar (fue baja) | `skip_reason_code = churn`; cuenta hasta su último mes. Reversible. |
| Quitar (duplicado o error) | `skip_reason_code = duplicate` \| `error`; deja de contar. Reversible. |
| Desvincular | Quita el empalme (vuelve a pendiente). |

### 4.3 Facturas previas

Lista con estado de cobro, cliente, contrato vinculado y lote; vista rápida con líneas. **Importar** (plantilla de dos hojas,
mapeo de columnas recordado por holding, vista previa con `new | duplicate | error | needs_entity`, confirmación en bloque de
razones sociales y clientes comerciales faltantes con país y moneda, aplicar, revertir lote). **Arranque rápido** (§3.3) desde
la lista: elegir mes de corte y clientes, revisar la propuesta (producto, cantidad, unitario, frecuencia), aplicar.

### 4.4 Lo que cambia en otros módulos

- Cliente 360: el resumen suma el histórico con corte U14 y solo recurrentes (hoy no); pestaña "Histórico" con las líneas.
- Contrato 360: sección "MRR histórico empalmado".
- Métricas: etiquetas "MRR histórico" en API y front (hoy "Legacy"); inicio de la historia por holding.
- Administración › Holding › Preferencias: campo "Inicio de la historia en Métricas".
- Facturación: el ítem "Facturas (próximamente)" del menú Importar enlaza a Datos históricos › Facturas previas cuando se publique.

## 5. Contrato de la API (módulo `onboarding`, `HoldingScopeGuard`; lectura `VIEW_CONFIGURACION`, escritura `EDIT_CONFIGURACION`)

Paginación `{ data, total, currentPage, pages, limit }`; errores `{ message, errors?[{ field, message }] }`; 409 `{ code, blockers? }`.

| Método y ruta | Entrada | Salida |
|---|---|---|
| `GET /onboarding/summary` | — | `{ history: { lines, pending, pending_ended, linked, closed, removed, clients_without_contract }, splice: { gap, overlap_cut, contract_without_mrr }, previous_invoices: { total, pending, linked, by_status{Pagada,Enviada,Vencida} }, settings: { metrics_history_start, system_currency } }` |
| `GET /onboarding/history/lines` | `status`(`pending,pending_ended,linked,closed,removed`), `clientId`, `product`, `batchId`, `search`, `page`, `limit`, `sortBy`(`client,product,last_month,mrr,status`), `sortOrder` | paginado de `{ key, client{id,name}, product_name, product_id, currency, first_month, last_month, months_count, mrr_last, mrr_last_system, status, ended, contract{id,contract_number,status}\|null, batch_ids[], invoices_count, skip_reason_code, skip_reason }` |
| `GET /onboarding/history/lines/:key` | — | línea + `months[{ id, period_month, subtotal_contract_currency, mrr_legacy, mrr_legacy_system_currency, term, is_recurring, invoice_number, invoice_legacy_id, counted (U14) }]`, `invoices[]`, `splice{ gap_months, overlap_months, contract_first_month }`, `candidates[{ id, contract_number, status, products[], currency, start_date, end_date, score }]`, `events[]` |
| `PATCH /onboarding/history/lines/:key/months` | `{ months:[{ id, subtotal_contract_currency?, is_recurring? }] }` | línea actualizada; evento `history_months_edited` |
| `POST /onboarding/history/lines/:key/link` | `{ contract_id }` | `{ line, splice }`; 409 `contract_other_client` \| `line_not_pending` |
| `POST /onboarding/history/lines/:key/unlink` | — | línea |
| `POST /onboarding/history/lines/:key/close` | `{ reason?: string }` | línea (`closed`) |
| `POST /onboarding/history/lines/:key/remove` | `{ reason: 'duplicate' \| 'error', notes? }` | línea (`removed`) |
| `POST /onboarding/history/lines/:key/reopen` | — | línea (`pending`) |
| `GET /onboarding/history/lines/:key/contract/defaults` | — | `CreateContractDto` prellenado (`client_id`, `client_entity_id` sugerida, `company_id`, `contract_currency`, `items[{ product_id, quantity, unit_price, billing_frequency: 'Mensual', billing_method: 'Anticipado', term_months: 12, start_date: último mes + 1 }]`, `origin: { type: 'history', line_key }`) + `warnings[]` |
| `POST /onboarding/history/lines/:key/contract/preview` | `CreateContractDto` | vista previa de Contratos (`POST /contracts/preview`) + `splice` |
| `POST /onboarding/history/lines/:key/contract` | `CreateContractDto` | `{ contract{id, contract_number}, line }` (crea En revisión con `ContractDraftsService.create` y empalma) |
| `GET /onboarding/previous-invoices` | `status`, `linked`(`true/false`), `clientId`, `entityId`, `batchId`, `search`, `from`, `to`, `page`, `limit`, `sortBy` | paginado de `{ id, invoice_number, issue_date, due_date, entity{id,legal_name,tax_id}\|null, legal_client_name, client_tax_id, client{id,name}\|null, company{id,legal_name}, currency, amount, vat, total, status, source_type, source_system, contract{id,contract_number}\|null, batch_id, has_history }` |
| `GET /onboarding/previous-invoices/:id` | — | factura + `items[]` + `history_months[]` + `events[]` |
| `POST /onboarding/previous-invoices/import/preview` | `{ invoices:[{ row, invoice_number, issue_date, due_date?, legal_client_name, client_tax_id?, company_name, source_type?, source_system?, currency, amount, vat?, total, status?, notes?, items:[{ description?, product_external_code?, quantity?, unit_price?, discount_pct?, subtotal, tax_amount?, total? }] }], batch_label? }` (máx. 2.000) | `{ rows:[{ row, status: 'new' \| 'duplicate' \| 'error' \| 'needs_entity', errors[], entity{id,legal_name}\|null, entity_suggestion{ legal_name, tax_id, country?, client{id,name}\|null }, company{id}\|null }], summary{ new, duplicate, error, needs_entity, by_currency[] }, missing_entities[{ legal_name, tax_id, rows }], missing_companies[] }` |
| `POST /onboarding/previous-invoices/import` | `{ invoices, batch_label?, create_entities?: [{ legal_name, tax_id?, country, client: { id } \| { name } }] }` | `{ batch_id, inserted, skipped_duplicates, errors, entities_created, clients_created }`; 409 `nothing_to_import` |
| `POST /onboarding/previous-invoices/import/:batchId/revert` | — | `{ batch_id, removed }`; 409 `batch_has_history` \| `batch_linked` |
| `GET /onboarding/previous-invoices/batches` | — | `[{ id, label, created_at, created_by, count, reverted }]` |
| `POST /onboarding/quick-start/preview` | `{ as_of: 'YYYY-MM', entity_ids?: [], history_months?: 0..24 }` | `{ proposals:[{ entity{id,legal_name}, client{id,name}\|null, last_invoice{id,number,issue_date,total,currency}, items:[{ description, quantity, unit_price, product_id\|null, product_suggestion }], contract{ start_date, currency, billing_frequency, billing_method }, history_months_found, flags[] (`no_client`, `no_product`, `already_has_contract`, `multi_currency`) }], summary }` |
| `POST /onboarding/quick-start` | `{ as_of, proposals:[{ entity_id, product_id (por ítem), billing_frequency?, billing_method?, term_months?, history_months? }] }` | `{ created:[{ entity_id, contract{id,contract_number}, history_rows }], skipped:[{ entity_id, reason }] }` |
| `GET /onboarding/events` | `lineKey?`, `entityId?`, `page` | paginado de eventos |
| `PATCH /settings/holding/preferences` | `+ metrics_history_start` | (existente, un campo más) |

Reglas: toda escritura abre transacción con `setApiWriter`; ninguna escritura dispara notificaciones, correos ni
sincronizaciones; `link`/`contract` recalculan el devengo del contrato afectado (`revenue_schedule_rebuild`) y nada más.

## 6. Plantillas

- **Facturas previas**: la misma de dos hojas que ya usan los clientes (hoja Facturas: `invoice_number, issue_date, due_date,
  legal_client_name, client_tax_id, company_name, source_type, source_system, invoice_currency, amount_invoice_currency, vat,
  total_invoice_currency, status, pdf_url, notes`; hoja Items: `invoice_number, product_external_code, description, quantity,
  unit_price, discount_pct, tax_code, currency, subtotal, tax_amount, total, account_code`). Entrega 2: mapeo libre de columnas.
- **MRR histórico directo** (holdings con historia en planilla, entrega 2): `cliente_rut | cliente_nombre, razon_social_rut?,
  producto, moneda, monto_mensual, desde (YYYY-MM), hasta (YYYY-MM), recurrente, compania?, nota?`.
- **Contratos vigentes** (entrega 2): la plantilla de tres hojas actual más `facturar_desde`.

## 7. Qué no haremos

Facturas o devengo sintéticos ni saldos de apertura; dos fuentes en un mismo cliente × producto × mes; conciliación línea a
línea; recalcular impuestos o prorrateos de facturas previas; enviar facturas previas al ERP o al SII; crear clientes o
razones sociales sin confirmación; borrados físicos; catálogo de motivos visible (solo "fue baja" / "duplicado o error").

## 8. Entregas

1. **Lab, para SimpliRoute hoy (esta semana)**: módulo `onboarding` en la API (§5 completo salvo lo marcado entrega 2),
   `/lab/onboarding` con Resumen, bandeja de MRR histórico con sus acciones, Facturas previas con importación por plantilla,
   arranque rápido, inicio de la historia por holding, Cliente 360 con corte, etiquetas "MRR histórico". Con esto Domi
   resuelve desde la pantalla las 67 líneas pendientes, los 28 huecos, los 12 contratos sin MRR y carga Brasil (piloto).
2. **Importadores y casos especiales**: mapeo libre de columnas, planilla de MRR histórico directo, contratos vigentes con
   `facturar_desde`, última factura multi período (§3.3.4), facturas previas pendientes en Cobranza como externas.
3. **Setup y publicación**: alta de holding por firma de términos (S8-3), checklist guiado con agente (S8-4), migración
   rápida desde conexiones (S8-6), retiro de RPC y tablas viejas; publicación como Administración › Datos históricos (el
   sidebar de Administración se despliega en submódulos: Holding y compañías · Usuarios y permisos · Datos históricos).

## 9. Decisiones tomadas (13-10) y pendientes

Tomadas: D1 fuente = facturas cuando el cliente no conoce sus contratos, planilla de contratos cuando sí; la línea de MRR
histórico es la unidad de métricas · D2 corte U14 por línea + inicio de la historia por holding · D3 sin catálogo: cerrar =
baja, quitar = duplicado/error · D4 arranque rápido desde la última factura como camino principal; sin saldos de apertura; sin
conciliación línea a línea · D5 nace en el lab y se publica en Administración › Datos históricos · D6 piloto Brasil con la
planilla existente · D7 migración §3.5 con OK de Domi antes de aplicar.

Pendientes: producto del catálogo para las líneas de Brasil (las facturas no traen descripción: se elige en la vista previa, uno
por cliente o uno para todo el lote) · pedir a SimpliRoute la última factura por cliente activo en 2026 para Argentina (o la
planilla completa) · si Brasil se carga completo (1.921 facturas) o solo desde jul-2026.
