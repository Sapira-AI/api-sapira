# Spec · Conciliación bancaria v2 (pestaña de Facturación · `/lab/facturacion?tab=conciliacion`)

> 02-10-2026 · Domi + Claude. Estado: **decidida (§9) y en construcción en el laboratorio** (C1 + C2 + C3). La versión anterior de este
> documento era el borrador con las preguntas P1–P5; las respuestas de Domi (02-10, finales) están en §9 y reescriben §2–§6.
> **Revierte** [`spec-facturacion-v2.md`](./spec-facturacion-v2.md) §2/§3 (filas "Conciliación bancaria … Fuera (Q4)") y la pregunta 4 de su §12:
> la conciliación entra en Facturación v2 como pestaña propia.
> Fuentes: front viejo `sapira-ai/src/components/facturacion/conciliacion/**` (+ `services/{bankMovementService,bankUploadService,
> reconciliationEngine}.ts`, `types/reconciliationTypes.ts`, `hooks/{useBankMovements,useBankUpload,useReconciliationSuggestions}.ts`,
> `pages/Facturacion.tsx:172-193`, migraciones `20260403150000…150300`); API `src/modules/billing/**`; entities `entities/conciliacion/*`,
> `facturacion/invoice-payment.entity.ts`, `clientes/{company-bank-account,client-entity}.entity.ts`; [`mapa-v2-facturacion.md`](./mapa-v2-facturacion.md);
> [`spec-tablas-por-modulo.md`](./spec-tablas-por-modulo.md) §9. Conteos de prod: los del espejo de entities (22-08 / 01-10), no se consultó la base.

## 0. Resumen

- El front viejo **sí tiene** conciliación (cartola CSV/XLSX con mapeo, lotes con hash de archivo, score de 4 criterios **en el navegador** y
  "Conciliar auto"). No hay IA ni banco integrado. v2 mueve todo a la API: importación con deduplicación por línea, motor de sugerencias
  determinista + difuso con explicación, y toda escritura con vista previa.
- Las **3 tablas ya existen** (`bank_movements` 158 filas, `bank_upload_batches` 10, `bank_column_mappings` 0) y `invoice_payments.bank_movement_id`
  (FK + índice) ya está.
- Todo pago creado por conciliación pasa por **`BillingPaymentsService.register`** (mismo plan, mismos bloqueos, mismo evento) y se deshace con
  **`void`** (`confirmed = false`, nunca DELETE). Cero caminos paralelos.
- **Una migración** (`1790740000000-BankReconciliationV2`, **sin aplicar**): estado `Ignorado` + motivo, índice único de huella por línea y tres
  columnas en `invoice_payments` para moneda distinta (decisión 2) y diferencias con motivo (decisión 3). Efecto exacto en §2.1.

## 1. Inventario del front viejo

| Pantalla / pieza | Qué hace | Datos · tablas · RPC | Problemas |
|---|---|---|---|
| Pestaña "Conciliación Bancaria" (`pages/Facturacion.tsx:172`, `conciliacion/ConciliacionBancaria.tsx`) | Encabezado con período (solo etiqueta), Actualizar, Importar Cartola, "Conciliar Auto (N)"; chips pendientes/conciliados; sub-pestañas Por conciliar · Conciliados · Historial cargas | `bank_movements` `.from()` directo (9 lecturas), sin RPC | El período **no filtra**; resumen suma **todas las monedas**; sin paginar; egresos en "pendientes" |
| `MovimientosTable.tsx` | Movimientos con mejor sugerencia, chip de confianza, selección, Conciliar / Deshacer | `bank_movements` + sugerencias en memoria | Sin búsqueda ni filtros; sin teclado; sin ver la factura |
| `ReconcileConfirmModal.tsx` | Elige 1 factura y confirma | — | **Solo 1-a-1**; sin monto editable, parciales ni 1-a-muchos |
| `BulkReconcilePanel.tsx` | Concilia en lote con la mejor | bucle de `reconcileMovement` | Sin vista previa; fallas parciales sin rollback; errores crudos |
| `CartolaUploadModal.tsx` + `ColumnMapperStep.tsx` | Archivo → columnas → mapeo → vista previa → cargar; presets por banco | `bank_upload_batches`, `bank_column_mappings` (0 filas), `xlsx` | Duplicado solo por **hash de archivo**; cuenta no obligatoria; insert y "rollback" desde el navegador |
| Historial de cargas / `revertBatch` | Revierte un lote si no tiene conciliados | DELETE de `bank_movements` + `status='Revertido'` | Borrado desde el navegador |
| `services/reconciliationEngine.ts` | Score 0-100: monto (40) + nombre en la glosa (30) + moneda (15) + vencimiento (15); alta ≥75, media ≥50, baja ≥30 | Facturas `Emitida/Enviada/Vencida` | Compara contra el **total**, no el **saldo**; no usa folio, RUT ni referencia; corre en el navegador |
| `bankMovementService.reconcileMovement` | UPDATE movimiento → INSERT pago → "rollback" manual | `bank_movements`, `invoice_payments` | Pago en la **moneda del movimiento**; sobrepago posible; sin período cerrado; no transaccional; sin evento |
| `undoReconciliation` | **DELETE** del pago + movimiento a `Pendiente` | — | Borrado físico sin motivo ni rastro |

> No confundir con la "conciliación" de `components/contratos/legacy/**` (factura legacy ↔ contrato): queda fuera.

## 2. Modelo de datos

**Se reutiliza** (entities `entities/conciliacion/*`, `facturacion/invoice-payment.entity.ts`):

| Tabla | Columnas que usa v2 | Uso v2 |
|---|---|---|
| `bank_movements` | `id, holding_id, company_id, bank_name, bank_account, movement_date, description, amount, currency, status, batch_id, reconciled_invoice_id, reconciled_at, reconciled_by, match_confidence, match_score, suggested_invoice_id, original_row_data` + **`ignore_reason`** (M1) | Una línea de cartola. `amount` con signo (abono > 0, cargo ≤ 0). `original_row_data = { raw{ encabezado: celda }, row, fingerprint, reference, counterparty_tax_id, counterparty_name, balance }`. `suggested_invoice_id/match_*` = mejor sugerencia persistida (filtro por confianza y KPI "Sin identificar"); `match_confidence` sigue con su CHECK (`high`/`medium`): **Exacta = `high` con `match_score = 100`**, Alta = `high` < 100, Probable = `medium`. `reconciled_invoice_id` = primera factura aplicada (compatibilidad); la verdad son los pagos |
| `bank_upload_batches` | `holding_id, company_id, bank_account_id, file_name, file_hash, row_count, column_mapping, status ('Procesado'\|'Revertido'), uploaded_by` | Una importación. `column_mapping` = mapeo usado + `{ format, source: 'file', skipped_duplicates, errors }`; al revertir, `column_mapping.revert = { reason, by, at }` (no hay columna de motivo; es metadato del lote, no un dato financiero) |
| `bank_column_mappings` | `holding_id, bank_name, mapping_name, column_mapping, is_default` | Plantillas por banco |
| `invoice_payments` | `bank_movement_id`, `confirmed`, `method`, `reference`, `notes` + **`original_amount`, `fx_rate`, `settlement_reason`** (M1) | Un pago por factura aplicada; N pagos por movimiento (1-a-muchos), N movimientos por factura (muchos-a-1) |
| `company_bank_accounts` | `id, company_id, bank_name, account_number, currency, holding_id` | Cuenta obligatoria al importar: fija compañía y moneda por defecto |
| `client_entities.tax_id`, `clients.name_commercial/legal_name`, `invoices.invoice_number/client_entity_id` | — | Reglas por RUT, nombre y folio |

**Monto aplicado de un movimiento** (en **su** moneda) = Σ `COALESCE(original_amount, amount)` de los pagos `confirmed` con su `bank_movement_id`
y `settlement_reason IS NULL`. Los ajustes no monetarios también llevan `bank_movement_id` (para deshacer todo junto) pero **no consumen** el
movimiento.

**Estado derivado del movimiento** (sin columna nueva salvo `Ignorado`): `pending` Por conciliar (`Pendiente`, aplicado 0) · `partial` Parcial
(`Pendiente`, 0 < aplicado < monto) · `reconciled` Conciliado (`status='Conciliado'`, aplicado ≥ monto − 0,005) · `ignored` Ignorado
(`status='Ignorado'`) · `debit` Egreso (`amount ≤ 0`, fuera de la cola salvo con "Mostrar cargos").

**Alias pagador aprendido sin tabla**: se deriva del historial (glosa normalizada y RUT de movimientos con pagos monetarios confirmados →
`invoice.client_id`); un alias que apunta a dos clientes no se usa.

### 2.1 Migración `1790740000000-BankReconciliationV2` (escrita, **NO aplicada**)

| # | Sentencia | Efecto exacto | Por qué (decisión) |
|---|---|---|---|
| 1 | `ALTER TABLE bank_movements DROP CONSTRAINT bank_movements_status_check; ADD CONSTRAINT bank_movements_status_check CHECK (status = ANY (ARRAY['Pendiente','Conciliado','Ignorado']))` | Admite `Ignorado`; filas existentes intactas (158, todas `Pendiente`/`Conciliado`) | "Ignorar / No es una factura" |
| 2 | `ALTER TABLE bank_movements ADD COLUMN ignore_reason text NULL` | Motivo de Ignorar (quién/cuándo en `reconciled_by/reconciled_at`); `NULL` en las 158 filas | Ídem; no se esconde en `original_row_data` |
| 3 | `CREATE UNIQUE INDEX uq_bank_movements_fingerprint ON public.bank_movements USING btree (holding_id, ((original_row_data ->> 'fingerprint'))) WHERE ((original_row_data ->> 'fingerprint') IS NOT NULL)` | Idempotencia de línea en la base; las 158 filas viejas no tienen `fingerprint` → quedan fuera del índice parcial. Asset `special-index/uq_bank_movements_fingerprint.sql` + `@Index(…, { synchronize: false })` (expresión: TypeORM no lo declara) | Dedupe por línea (C1). La API ya deduplica con `pg_advisory_xact_lock` + `INSERT … ON CONFLICT DO NOTHING`; el índice lo garantiza |
| 4 | `ALTER TABLE invoice_payments ADD COLUMN original_amount numeric NULL, ADD COLUMN fx_rate numeric NULL` + `CHECK invoice_payments_original_check ((original_amount IS NULL) = (fx_rate IS NULL) AND (original_amount IS NULL OR bank_movement_id IS NOT NULL))` | Pago en moneda distinta: `amount`/`currency` = moneda de la factura (lo que cuenta para el saldo); `original_amount` = monto en la moneda del movimiento; `fx_rate` = unidades de moneda de factura por 1 de la del movimiento (`amount = round2(original_amount × fx_rate)`). La moneda original **no se duplica**: es `bank_movements.currency` vía `bank_movement_id` (el CHECK lo obliga). 243 filas existentes: `NULL` | Decisión 2 (no hay columnas que lo guarden) |
| 5 | `ALTER TABLE invoice_payments ADD COLUMN settlement_reason text NULL` + `CHECK invoice_payments_settlement_reason_check (settlement_reason IS NULL OR settlement_reason = ANY (ARRAY['bank_fee','withholding','fx_difference','rounding','other']))` | Ajuste no monetario: fila de `invoice_payments` confirmada en la moneda de la factura con `method = 'adjustment'`, motivo en `settlement_reason` y texto libre en `notes`. `NULL` = pago monetario (las 243 filas existentes) | Decisión 3: cierra la diferencia **sin** NC y **sin** tocar `balanceSql` (la regla de saldo sigue siendo una: total − pagos confirmados en la moneda de la factura) |

`down`: `Ignorado → Pendiente` (con `ignore_reason` anulado), restituye el CHECK viejo y suelta índice, CHECKs y columnas.
**Orden de despliegue**: aplicar la migración **antes** de desplegar este build de la API — `/billing/invoices/summary` (Cobrado sin ajustes),
`/billing/invoices/:id/payments` y toda `/billing/reconciliation/*` leen las columnas nuevas.
**Specs de deriva que fallan hasta aplicar** (esperado): `entities/conciliacion/conciliacion.entities.spec.ts` (`bank_movements`: columna
`ignore_reason`) y `entities/facturacion/facturacion.entities.spec.ts` (`invoice_payments`: 3 columnas y 2 CHECK). Tras aplicar: `yarn schema:snapshot`.

Alternativas descartadas: `invoice_adjustments` para las diferencias (su CHECK es de desvíos contra el plan de una Por Emitir y obligaría a
`balanceSql` a restar una segunda fuente); método especial en `method` sin columna (el motivo quedaría mezclado con el texto libre del método).

## 3. Flujo

**3.1 Fuentes.** Cartola CSV/XLSX: el navegador lee el archivo (`xlsx`, ya en `front-sapira`) y manda encabezados + filas crudas + mapeo; la
**API normaliza** (fecha, separadores, signo, moneda, RUT de la glosa) y es la única que decide. Plantillas por banco (`bank_column_mappings`) con
auto-detección por encabezados (semillas Banco de Chile, Santander, BCI, Itaú, Scotiabank, BICE, Security, Estado en el front). OFX y banco
integrado (Fintoc) quedan para C4 con el mismo pipeline desde "normalizar".
**3.2 Cola.** Abonos (`amount > 0`) del holding, filtrables por cuenta, período (fecha del movimiento), estado derivado, confianza y búsqueda;
los cargos se ocultan (interruptor "Mostrar cargos").
**3.3 Motor de sugerencias** (API, puro, `billing-reconciliation-match.ts`; candidatos = facturas cobrables con **saldo** > 0 según
`balanceSql`, `voided = false`). **Tres niveles, todos se muestran como sugerencia: Exacta · Alta · Probable.**

| Paso | Regla | Nivel |
|---|---|---|
| D1 | Folio de la factura en la glosa/referencia **y** monto = saldo **y** misma moneda (o varios folios cuyos saldos suman el monto: 1-a-muchos) | **Exacta** (100) |
| D2 | RUT/tax id del pagador = `client_entities.tax_id` **y** monto = saldo, o = Σ saldos de un subconjunto ≤ 6 facturas del cliente (1-a-muchos; único) | **Alta** (95) |
| D3 | Alias aprendido → cliente **y** monto = saldo / Σ saldos | **Alta** (92) |
| D4 | Monto = saldo de una sola factura del holding, misma moneda, sin identidad | **Probable** (70) |
| F1 difusa | 0-99: monto vs saldo (35 exacto · 30 ≤ 0,5 % · 20 ≤ 2 % · 8 parcial), identidad (35 RUT · 30 alias · 25/15 nombre normalizado sin S.A./SpA/Ltda por tokens y Jaro-Winkler), folio parcial (15), vencimiento cercano (10/5), pagos recurrentes del cliente por el canal (5) | **Alta ≥ 85 · Probable ≥ 60**; bajo 60 no se sugiere ("Sin identificar") |
| Formas | 1-a-1 · 1-a-muchos (subset-sum acotado, mismo cliente y moneda) · muchos-a-1 (movimientos del mismo pagador que suman el saldo en ±10 días; solo en el detalle) · parcial (monto < saldo fuera del umbral) | La forma va en la sugerencia |
| Diferencia | Monto < saldo dentro del umbral (`fee_threshold_pct`, default 1 %, configurable por usuario) → la sugerencia trae `difference{ amount, suggested_reason }`: `rounding` (≤ 1 unidad), `withholding` (≈ 10/15/20/25/35 % del saldo), `bank_fee` (≤ umbral) | Solo **sugerencia** de motivo: nunca se aplica sin que el usuario lo elija |

Cada sugerencia trae `reasons[{ code, points, detail }]` legibles ("Folio 1234 en la glosa · RUT coincide · monto exacto").
**Moneda distinta nunca se sugiere** (se hace a mano, §3.4). **Facturas de distintos clientes** nunca se sugieren juntas (a mano, con aviso).

**3.4 Acciones** (todas con vista previa y resultado por ítem; evento por factura con contrato):

- **Conciliar** una sugerencia o una asignación armada a mano (buscador de candidatas, montos editables). Muchos-a-1: un `register` por
  movimiento con su parte.
- **Conciliar en lote**: preselecciona **Exacta + Alta**; "Incluir probables" suma el tercer nivel; deseleccionables; tabla de decisiones con
  totales por moneda → resultado por ítem (todo o nada por ítem, ítems independientes). En lote solo se aplica el efectivo (las diferencias
  quedan como saldo; el motivo se elige uno a uno).
- **Dividir**: un movimiento a varias facturas con montos editables; el resto del movimiento queda Parcial.
- **Diferencia con motivo** (decisión 3): si lo recibido no cubre el saldo, el usuario cierra la diferencia con `bank_fee` (comisión bancaria),
  `withholding` (retención, típica en pagos del exterior), `fx_difference`, `rounding` u `other` (texto obligatorio). Se registra como **ajuste
  no monetario** (fila de `invoice_payments` con `settlement_reason`) por el mismo `register`, en la misma transacción: salda la factura sin NC,
  no cuenta como "Cobrado" y se muestra aparte en Cobranza (**Ajustes no monetarios**). Si el motivo es un **descuento o rebaja comercial**, la
  UI avisa que corresponde una **NC ligada a esa factura** y abre su vista rápida (single path) en vez de cerrarla aquí; la API no acepta ese motivo.
- **Moneda distinta** (decisión 2): nunca sugerida; a mano el usuario ingresa **el tipo de cambio o el monto en la moneda de la factura** (el
  otro se calcula). El pago se registra en la moneda de la factura y guarda `original_amount` + `fx_rate` (moneda original = la del movimiento).
  La diferencia de cambio que quede puede cerrarse con `fx_difference`. Consistencia (`fx_inconsistent`): `|original × tasa − monto| ≤ max(0,01;
  0,005 × tasa)` (el front redondea el original a centavos; con tasas > 1 ese redondeo mueve el producto hasta tasa × 0,005). El consumo del
  movimiento se calcula con `original_amount`.
- **Varios clientes** (decisión 4): una transferencia puede pagar facturas de distintos clientes **solo a mano** (`allow_multiple_clients`):
  `client_mismatch` pasa a aviso `multiple_clients`; nunca en sugerencias ni en lote.
- **Ignorar / "No es una factura"** con motivo (préstamo, aporte, traspaso entre cuentas, devolución, otro) → `Ignorado`; **Reabrir** lo devuelve.
- **Deshacer** = `void` de todos los pagos y ajustes del movimiento (motivo obligatorio) + movimiento a `Pendiente`. Toast "Deshacer" 10 s y `U`.
- **Revertir importación**: solo si ningún movimiento del lote tiene pagos (confirmados o anulados): borra las líneas de ese lote (nunca
  tuvieron efecto financiero) y marca el lote `Revertido` con su motivo.

**3.5 Estados.** Movimiento: Por conciliar → Parcial → Conciliado; Por conciliar → Ignorado (→ Por conciliar al reabrir); Conciliado/Parcial →
Por conciliar al deshacer. Factura: la de `statusAfterPayments` (Pagada con Σ pagos + ajustes ≥ total en su moneda); la conciliación nunca
escribe `invoices.status` por su cuenta.

## 4. API (`src/modules/billing`, `BillingReconciliationController` + `BillingReconciliationService`, mismos guards + `@RequireBillingPermission`)

Tipos: `state` ∈ `pending|partial|reconciled|ignored|debit` · `confidence` ∈ `exact|high|medium` (+ `none` en filtros) · `shape` ∈
`one_to_one|one_to_many|many_to_one|partial` · `reason` ∈ `bank_fee|withholding|fx_difference|rounding|other`.

| Método y ruta | Permiso | Body / query | Respuesta | Bloqueos |
|---|---|---|---|---|
| `GET /billing/reconciliation/summary` | VIEW | `from?, to?` (YYYY-MM-DD, fecha del movimiento), `bank_account_id?` | `{ period{ from, to }, pending{ count, by_currency[{ currency, amount }] }, reconciled_period{ … }, differences{ … }, unidentified{ … }, ignored{ count }, by_confidence{ exact, high, medium, none }, accounts[{ id, company_id, company_name, bank_name, account_number, currency, movements, last_movement_date }], has_source, last_batch{ id, file_name, created_at, status, row_count } \| null }`; `from`/`to` filtran por fecha del movimiento todo salvo `reconciled_period` (por `reconciled_at`); `differences.amount` = resto de los parciales + ajustes no monetarios (`reconciled_period` sin período = mes en curso; `pending` = Por conciliar + Parcial con su resto) | — |
| `GET /billing/reconciliation/movements` | VIEW | `from, to, bank_account_id, state (lista), confidence (lista), kpi (pending\|reconciled\|differences\|unidentified), include_debits, q, page, limit ≤ 200, sortBy (date\|amount), sortOrder, fee_threshold_pct` | Paginado `{ data[fila], total, items, currentPage, pages, limit }` (como el resto de `/billing`); fila `{ id, date, description, reference, counterparty_name, counterparty_tax_id, amount, currency, bank_account_id, bank_name, account_number, batch_id, state, applied, remaining, adjustments, ignore_reason, reconciled_at, reconciled_by{ id, name }, best{ key, confidence, score, shape, reasons[], allocations[{ invoice_id, invoice_number, client_id, client_name, contract_id, currency, balance, amount }], movement_ids[], total, difference } \| null (`amount` = efectivo a aplicar en moneda de factura; nunca moneda distinta, varios clientes ni muchos-a-1), payments[{ id, invoice_id, invoice_number, client_name, amount, currency, original_amount, fx_rate, settlement_reason, confirmed, payment_date }] }`. Sin `state`/`kpi`: `pending,partial` (+ `debit` con `include_debits=true`) | — |
| `GET /billing/reconciliation/movements/:id/suggestions` | VIEW | `fee_threshold_pct?` | `{ movement: fila, suggestions[{ key, shape, confidence, score, reasons[], allocations[], movement_ids[], total, difference{ amount, currency, suggested_reason, hint } \| null }] (≤ 5), related_movements[fila] }` | 404 fuera del holding |
| `GET /billing/reconciliation/candidates` | VIEW | `q?, client_id?, currency?, limit ≤ 50` (default 20) | `{ data[{ invoice_id, invoice_number, client_id, client_name, client_entity_name, tax_id, contract_id, read_only, currency, total, balance, due_date, issue_date, status, payment_state }] }` (cobrables con saldo > 0, vencimiento más antiguo primero) | — |
| `POST /billing/reconciliation/statements/preview` | EDIT | `{ bank_account_id, file_name, file_hash, format: csv\|xlsx, headers[], rows[][] (≤ 5.000), mapping }` | `{ account, lines[{ row, date, description, amount, currency, reference, counterparty_tax_id, counterparty_name, fingerprint, kind: credit\|debit, status: new\|duplicate\|error, duplicate_of, errors[] }], summary{ total, new, duplicates, errors, credits, debits, by_currency[{ currency, credits, debits, count }] }, warnings[{ code: file_already_imported, message, batch_id }] }` | 404 `no_bank_account`; 400 `invalid_mapping` (columna inexistente o sin monto); error por línea `account_currency_mismatch`, fecha o monto ilegibles |
| `POST /billing/reconciliation/statements` | EDIT | igual + `save_template?{ bank_name, mapping_name, is_default? }` | `{ batch_id, inserted, skipped_duplicates, errors, template_id, warnings[], suggestions{ exact, high, medium, none } }` | 409 `blocked` `nothing_to_import` |
| `GET /billing/reconciliation/statements` | VIEW | `page, limit` | Paginado de lotes `{ id, file_name, created_at, uploaded_by{ id, name }, bank_account{ id, bank_name, account_number, currency }, row_count, status, movements, reconciled, can_revert, revert_blocker }` | — |
| `POST /billing/reconciliation/statements/:batchId/revert` | EDIT | `{ reason }` | `{ batch_id, removed }` | `batch_has_payments`, `already_reverted` |
| `GET /billing/reconciliation/templates` · `POST` · `PUT /:id` · `DELETE /:id` | VIEW/EDIT | `{ bank_name, mapping_name, column_mapping, is_default }` | plantilla(s) | — |
| `POST /billing/reconciliation/matches/preview` | EDIT | `{ items[{ key?, movement_ids[] (1–20), allocations[{ invoice_id, amount, original_amount? }], fx?{ rate }, adjustments?[{ invoice_id, amount, reason, note? }], allow_multiple_clients?, source?: suggestion\|manual, confidence?, score? }] (≤ 200) }` | `{ items[{ key, ok, movement_ids, currency, invoice_currency, fx_rate, movements[{ id, amount, applied_before, applied_after, remaining_after, state_after }], invoices[{ invoice_id, invoice_number, client_name, contract_id, cash_amount, adjustment_amount, adjustment_reason, before, after }], blockers[], warnings[] }], summary{ ok, blocked, by_currency[{ currency, cash, adjustments, items }] } }` | los de `planPayments` + `movement_not_found`, `movement_is_debit`, `movement_not_pending`, `movement_overapplied`, `movement_currency_mixed`, `fx_required`, `fx_inconsistent`, `note_required`; aviso `multiple_clients` |
| `POST /billing/reconciliation/matches` | EDIT | igual | Por ítem lo mismo + `{ applied, payment_ids, event_ids, error? }`; **todo o nada por ítem**, ítems independientes | igual |
| `POST /billing/reconciliation/movements/:id/undo` | EDIT | `{ reason }` | `{ movement_id, voided_payment_ids, state }` | los de `void` (`already_voided`, `period_closed`), `movement_has_no_payments` |
| `POST /billing/reconciliation/movements/:id/ignore` · `/reopen` | EDIT | `{ reason }` · `{ reason? }` | `{ movement_id, state }` (reabrir guarda `{ reason, previous_reason, by, at }` en `original_row_data.reopened`) | `movement_has_payments`, `movement_not_pending`, `movement_not_ignored` |
| `POST /billing/reconciliation/suggestions/refresh` | EDIT | `{ fee_threshold_pct? }` | `{ updated, by_confidence }` | — |

**Single path de pagos.** `matches` llama a `BillingPaymentsService.register(holdingId, dto, authId, now, options)` con
`options = { runner, bankMovementId, originalAmounts, fxRate, settlementReason, allowMultipleClients }` dentro de **una** transacción
`withApiWriter` por ítem (`setApiWriter` primera sentencia; movimientos `FOR UPDATE`): primero el efectivo (`method = 'transfer'`, `currency` = la
de la factura, `payment_date = movement_date`, `reference` = glosa ≤ 200, `notes` = "Conciliado desde cartola <banco> <cuenta>") y luego, si hay,
los ajustes (`method = 'adjustment'`, `settlement_reason`, `notes` = motivo). Las opciones **no** se exponen en el DTO público de
`POST /billing/payments` (que sigue igual). `undo` llama a `void(…, { runner })` por cada pago del movimiento en la misma transacción.
`planPayments(…, { allowMultipleClients })` convierte `client_mismatch` en aviso solo en ese camino. El evento `INVOICE_PAYMENT_REGISTERED` suma
`metadata.bank_movement_id`, `settlement_reason`, `original_amount`, `original_currency`, `fx_rate`.

**Cobranza / resumen**: `GET /billing/invoices/summary` → "Cobrado" (`collected`) excluye `settlement_reason IS NOT NULL` y agrega
`by_currency[].non_cash_adjustments` + `system.non_cash_adjustments` (por `payment_date` en el período). `GET /billing/invoices/:id/payments` →
cada pago suma `settlement_reason`, `original_amount`, `original_currency`, `fx_rate`.

BFF: `app/api/facturacion/conciliacion/*` con schemas Zod espejo (`lib/schemas/facturacion-schemas.ts`).

## 5. UI (pestaña **Conciliación** dentro de la tarjeta de Facturación)

- **Siempre visible** (decisión 1). Primer uso / sin movimientos: estado vacío con el asistente **"Sube tu cartola bancaria"** y una línea de
  valor ("Sapira cruza cada abono con tus facturas por folio, RUT y monto, y tú solo confirmas"). El botón **Importar** de la barra abre el mismo
  asistente ("Cartola bancaria").
- **KPI = filtro** (`KpiCard`, montos cortos en el tooltip por moneda, nunca sumadas): **Por conciliar** · **Conciliado del período** ·
  **Diferencias** (parciales y ajustes no monetarios) · **Sin identificar**.
- **Two-pane** dentro de `DataTableSection` (pestañas en la tarjeta + barra `ListToolbar`): izquierda la cola (fecha, glosa, monto, chip de
  confianza *Exacta · Alta · Probable · Sin sugerencia*, estado); derecha el panel del movimiento activo: sugerencias como tarjetas con "por qué",
  barra **asignado / restante**, candidatas con buscador y montos editables, **diferencia con motivo**, **moneda distinta** (tipo de cambio o
  monto), y el pie "Lo que vas a hacer" (vista previa de la API) antes de confirmar. La factura abre la **vista rápida del 360** (single path).
- **Teclado**: `↑/↓` (y `J/K`) mueve, `Enter` acepta la sugerencia elegida (con su vista previa), `1-5` elige sugerencia, `I` ignorar, `U` deshacer
  lo último, `/` buscar. Atajos en un `?`.
- **Lote**: barra `DataTableBulkBar` → diálogo con Exacta + Alta preseleccionadas, "Incluir probables", totales por moneda, vista previa →
  resultado por ítem.
- **Importaciones**: subvista con el historial de lotes y Revertir (motivo).
- **Cobranza**: tarjeta **Ajustes no monetarios** (no suma en Cobrado).

## 6. Reglas

1. **Holding**: todo `WHERE holding_id = $1` con `@HoldingId()`; `bank_movements.holding_id` nullable: filas sin holding no se leen.
2. **Permisos**: lecturas `VIEW_FACTURACION`; importar, conciliar, deshacer, ignorar, plantillas `EDIT_FACTURACION`.
3. **Período cerrado**: `payment_date = movement_date`; si ≤ `get_cutoff_date` → `period_closed` (del plan). Deshacer en período cerrado: bloqueado igual que `void`.
4. **Multimoneda**: el pago va en la moneda de la factura. Si el movimiento es de otra moneda, solo a mano con tipo de cambio explícito
   (`original_amount` + `fx_rate`); nunca se convierte en silencio. KPIs por moneda.
5. **Idempotencia de línea**: `fingerprint = sha256(cuenta | fecha | monto | glosa normalizada | referencia o saldo | n.º de ocurrencia en el
   archivo)`; se omite si ya existe en el holding (`pg_advisory_xact_lock` + `ON CONFLICT DO NOTHING`; índice M1.3). El hash de archivo solo avisa.
6. **Duplicados de aplicación**: un movimiento no queda con Σ aplicado > monto (`movement_overapplied`); una factura no se sobrepaga (`overpayment`).
7. **Trazabilidad**: nada financiero se borra (pagos y ajustes anulados con motivo); evento por factura con contrato con `metadata.bank_movement_id`.
8. **Ajustes no monetarios**: nunca cuentan como Cobrado; descuentos comerciales van por NC (single path).
9. **Coexistencia**: hasta el switch, el front viejo sigue escribiendo directo; la API lee sus pagos como aplicados.

## 7. Qué se porta, mejora o elimina

| Pieza vieja | Destino |
|---|---|
| Tablas, wizard de mapeo, presets, lotes con hash | **Se porta** y mejora: cuenta obligatoria, auto-detección, dedupe por línea en la API |
| Score de 4 criterios en el navegador | **Se mejora**: reglas deterministas (folio, RUT, alias, monto = saldo) + difusa con razones, en la API, 3 niveles |
| Comparación contra total | **Se elimina**: siempre contra saldo (`balanceSql`) |
| 1-a-1 sin monto | **Se mejora**: 1-a-muchos, muchos-a-1, parciales, diferencias con motivo, moneda distinta a mano |
| INSERT de pago en moneda del movimiento, sin período | **Se elimina**: `register` del billing (single path) |
| DELETE en deshacer | **Se elimina**: `void` |
| "Conciliar Auto" sin vista previa | **Se mejora**: lote por confianza con vista previa y resultado por ítem |

## 8. Orden de construcción

| Etapa | Alcance | Estado |
|---|---|---|
| **C1** | Asistente de cartola (CSV/XLSX, mapeo, plantillas), lotes, dedupe por línea, cola de abonos (cargos ocultos), KPIs, revertir | En el lab (02-10) |
| **C2** | Motor D1–D4 + F1 con razones, alias aprendido, formas 1-1/1-N/N-1/parcial, sugerencias persistidas | En el lab (02-10) |
| **C3** | Conciliar, lote con vista previa, dividir, diferencias con motivo, moneda distinta, varios clientes a mano, ignorar/reabrir, deshacer | En el lab (02-10) — requiere **M1** aplicada |
| **C4** | OFX, banco integrado (Fintoc), Insights/Wizard con acciones | Pendiente (con Leon) |

## 9. Decisiones de Domi (02-10, finales)

| # | Pregunta | Decisión |
|---|---|---|
| P1 | ¿La pestaña se ve sin fuente? | **Siempre visible**. Primer uso = asistente "Sube tu cartola bancaria" con una línea de valor; **Importar › Cartola bancaria** abre el mismo asistente |
| P2 | Movimiento en una moneda que paga factura en otra | **Nunca sugerido; permitido a mano**: el usuario ingresa el tipo de cambio o el monto en la moneda de la factura (el otro se calcula); el pago queda en la moneda de la factura con el monto, la moneda y el tipo de cambio originales (M1.4) |
| P3 | Comisiones, retenciones, diferencias | Se **cierran con motivo** (`bank_fee`, `withholding`, `fx_difference`, `rounding`, `other` con texto) como ajuste no monetario (M1.5): salda sin NC, no cuenta como Cobrado, se ve aparte en Cobranza. Descuento/rebaja comercial → aviso + vista rápida de la factura para la NC. Motivo sugerido si la diferencia es chica (umbral configurable), solo como sugerencia |
| P4 | Una transferencia para facturas de distintos clientes | Sin sugerencia; **permitido a mano con aviso** (`client_mismatch` relajado solo en el camino manual) |
| P5 | Niveles y lote | **Exacta · Alta · Probable**, todos como sugerencia; el lote preselecciona Exacta + Alta e "Incluir probables" suma el tercero |
