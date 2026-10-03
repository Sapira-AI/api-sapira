# Mapa v2 · Facturación (módulo `billing` + `/lab/facturacion`)

> 01-10-2026 · Domi + Claude. Lado API de [`spec-facturacion-v2.md`](./spec-facturacion-v2.md) (F1–F6), construido en `src/modules/billing`
> **sin commit, sin migraciones y sin tocar ninguna base**. Misma regla que Contratos ([`mapa-v2-contratos.md`](./mapa-v2-contratos.md) §1):
> la v2 vive al lado de lo viejo, sobre las mismas tablas, con la lógica en la API.

## 1. Reglas del módulo

- **Single path**: `billing` solo lee, hace fan-out y opera pagos y correos. Toda operación sobre una factura (enviar, emitir, reprogramar,
  FX, editar, NC, consolidar) vive en `contracts`; las rutas `POST /billing/to-issue/*` agrupan por `contract_id` y llaman en serie a
  `ContractInvoicesService` (`send-now` por factura, `reschedule-bulk`, `fx-bulk`, `erp-reset` masivo) con el mismo cuerpo. Los bloqueos
  de la cola salen de `planSendNow` (que ya trae `commonBlockers`), `erpDraftBlocker` y `periodClosedBlocker` del 360, sin copiar lógica.
- **Holding**: `SupabaseAuthGuard` + `HoldingScopeGuard` + `@HoldingId()`; toda consulta filtra `invoices.holding_id` y cada join por holding.
- **Escrituras**: transacción con `setApiWriter` como primera sentencia (`withApiWriter`), facturas `FOR UPDATE`, evento en
  `contract_lifecycle_events` cuando la factura tiene contrato (`INVOICE_PAYMENT_REGISTERED`, `INVOICE_PAYMENT_VOIDED`, `INVOICE_COLLECTION_SENT`).
- **Errores**: 400 `{ message, errors[{ field, message }] }`; bloqueos 409 `{ code: 'blocked', message, blockers[{ code, message, next_step, action? }], preview? }`.
- **Paginado**: `{ data, total, items, currentPage, pages, limit }` (`items` = `total`, compatibilidad con el contrato de la casa).
- **Fechas**: `todayFor` (America/Santiago), meses `YYYY-MM`, nunca `toISOString()` para fechas de negocio.

## 2. Estados derivados (sin columnas nuevas; `billing-states.ts` y su gemelo SQL en `billing-sql.ts`)

| Campo | Valores | Regla |
|---|---|---|
| `document_kind` | `invoice` · `credit_note` · `debit_note` | `isCreditNote` / `ND` |
| `payment_state` | `paid` > `partial` > `overdue` > `unpaid` · `not_applicable` | Pagos `confirmed = true` **en la moneda de la factura**; `not_applicable` para Por Emitir, Cancelada, NC/ND, inactivas y anuladas. Una parcial vencida sigue `partial` (`is_overdue` y `days_overdue` lo muestran) |
| `balance` | número · null | total − pagos (≥ 0); `Pagada` ⇒ 0 aunque los pagos no cubran el total (aviso `paid_without_full_payments` en `summary`/`aging`); null si no aplica o si la PE spot aún no se valoriza. Regla única `balanceSql` (SQL) / `balanceOf` (TS) |
| `erp_state` | `none` · `draft` · `sent` · `not_applicable` | `erp_sync_state` del 360; `not_applicable` para NC/ND, compañía sin integración o razón social sin partner |
| `electronic_state` | `pending_emission` · `issued_erp` · `issued_external` · `not_issued` · `voided` | NC sin folio ni vínculo → pendiente; PE automática con fecha pasada sin enviar → pendiente; evento `INVOICE_ISSUED_EXTERNALLY` → externa; vínculo Odoo → ERP; anulada con NC o Cancelada (salvo sin cobro) → voided |
| `issue_path` (cola) | `erp` · `external` | `auto_send_to_odoo` del contrato y compañía integrada → `erp`; si no, `external` (`mark-issued`) y se quitan los bloqueos propios del envío |
| `group` (cola) | `erp_draft` > `blocked` > `late` > `ready` | vínculo con el ERP; con bloqueo; emisión < hoy; resto |

**Estado por pagos** (`statusAfterPayments`): nunca toca Por Emitir, Cancelada, Consolidada ni Dividida; Σ ≥ total → `Pagada`; si no (también
al anular un pago de una Pagada): vencida → `Vencida`; si no, el emitido anterior (`Enviada` si está en el ERP, `Emitida` si no).

## 3. Endpoints (forma exacta de respuesta)

Fila de factura (`/invoices`, `/to-issue`, `/credit-notes`): `{ id, contract_id, contract_number, client_id, client_name, client_entity_id,
client_entity_name, company_id, company_name, invoice_number, document_type, document_kind, export_type, credit_type, credit_reason,
nc_revenue_treatment, invoice_type, invoice_series, status, issue_date, scheduled_at, due_date, contract_currency, invoice_currency,
fx_contract_to_invoice, amount_contract_currency, amount_invoice_currency, vat, total_invoice_currency, total_system_currency, paid_amount,
balance, payment_state, is_overdue, days_overdue, erp_state, electronic_state, plan_deviation, voided, issued_externally, related_invoice_id,
related_invoice_number, consolidated_into_invoice_id, is_active, is_legacy, auto_invoice, odoo_invoice_id, has_contract }`.
`plan_deviation` = `{ has_reason, type, amount_diff, reason, adjusted_at, adjusted_by_name } | null` (último `invoice_adjustments`, como el 360).

Filtros comunes (query, listas separadas por coma): `from`, `to` (`YYYY-MM`), `date_field=issue|due`, `status`, `document_kind`, `erp_state`,
`electronic_state`, `payment_state`, `company_id`, `client_id`, `client_entity_id`, `contract_id`, `invoice_currency`, `blocked`,
`deviation_unexplained`, `include_cancelled`, `include_inactive`, `q`. Sin `status`, la lista excluye Canceladas.

| Ruta | Respuesta |
|---|---|
| `GET /billing/invoices` (+ `sortBy` ∈ issue_date, due_date, invoice_number, client_name, contract_number, company_name, status, total_invoice_currency, balance, created_at · `sortOrder` · `page` · `limit ≤ 200`) | paginado de fila + `blocked_reasons[]`, `to_issue_group`, `issue_path` (solo PE), `related_documents[]`, `legacy_unified`, `contributions[]` |
| `GET /billing/invoices/summary` (período default: mes en curso) | `{ currency, period{ from, to }, by_currency[{ currency, billed, credited, net, pending_issue, pending_issue_unvalued, receivable, overdue, collected, non_cash_adjustments, unconverted_invoices }], system{ currency, billed, credited, net, pending_issue, receivable, overdue, collected, non_cash_adjustments }, counts{ pending_issue, blocked, overdue, overdue_avg_days, nc_pending_emission }, warnings[{ code: 'paid_without_full_payments', count, message }], unconverted{ invoices, reason } }`. `receivable`/`overdue` son saldo a hoy (no del período). Facturado/NC/por emitir solo cuentan activas; la NC de una factura ya Cancelada (anulada) u origen consolidado no resta (regla `countedInvoices` del 360). **Cobrado** (`collected`) solo cuenta pagos monetarios (`settlement_reason IS NULL`); los ajustes no monetarios de la conciliación van en `non_cash_adjustments` (misma regla de período por `payment_date` y de conversión) |
| `GET /billing/to-issue` (`until` default fin de mes, `group`, `blocker_code`, filtros, `page`, `limit`) | paginado de fila + `group`, `issue_path`, `blocked_reasons[]`, `warnings[]` · más `until`, `groups{ ready, blocked{ count, by_code{} }, late, erp_draft, amount_invoice_currency_by_currency{ ready\|blocked\|late\|erp_draft: [{ currency, amount, invoices, unvalued }] } }` (monto por grupo y moneda de factura, nunca sumado entre monedas; `unvalued` = PE spot sin total), `truncated` (> 5.000 PE) |
| `GET /billing/credit-notes` (+ `credit_type`) | paginado de fila + `credited_invoice{ id, invoice_number, status, issue_date } \| null` · más `counts{ pending_emission }` |
| `GET /billing/receivables/aging` (`as_of`, `company_id`, `client_id`, `currency`) | `{ as_of, currency, buckets \| null, by_currency[{ currency, buckets, total, invoices }], clients[{ client_id, name, currency, buckets, bucket_counts, total, invoices }], bucket_counts \| null, warnings[] }` (`by_currency[]` también trae `bucket_counts`); `buckets` = montos (número, compatibilidad), `bucket_counts` = n° de facturas por tramo; `buckets = { not_due, d1_30, d31_60, d61_90, d90_plus, no_due_date }`. Saldo con la misma regla que la lista y el resumen (`balanceSql`) |
| `GET /billing/receivables/aging` · reporte Cuentas por cobrar (02-10) | Además, por cliente y por moneda: `total_system`, `unconverted`, `last_payment_date` (último pago confirmado ≤ `as_of`), `max_days_overdue`, `avg_days_overdue` (ponderado por saldo vencido); `system_currency` y `system{ currency, buckets, total, unconverted }` (saldo en moneda de sistema, sin las no convertidas). Con `detail=invoices`: `invoices[{ id, invoice_number, client_*, company_*, contract_*, status, currency, issue_date, due_date, days_overdue, bucket, balance, balance_system, last_payment_date }]` (`buildAging`) |
| `GET /billing/receivables/aging` · revisión 02-10 | `group=company` agrega `by_company[{ company_id, name, currency, buckets, bucket_counts, total, invoices, total_system, unconverted, review_invoices }]` (una entrada por compañía y moneda de factura); siempre `review{ invoices, by_company[{ company_id, name, invoices, currencies }] }`: las facturas con `invoice_currency` **CLF/UF** no son moneda de facturación (datos por revisar) y **no entran** a tramos, monedas, clientes ni sistema (`NON_INVOICING_CURRENCIES`, `buildAging`); `q` busca folio, cliente, razón social o contrato |
| `GET /billing/receivables/forecast` (filtros de la antigüedad + `granularity=month\|week\|day`, `from`/`to` YYYY-MM-DD; default 12 meses, 12 semanas o 21 días desde `as_of`) | Proyección de cobros por **vencimiento** (`billing-forecast.ts:buildForecast`): `{ as_of, granularity, start, end, currency, periods[], columns{ <key>: { system, by_currency[], invoices, unconverted } }, overdue (Vencido por cobrar), no_due_date, later (Posteriores), total, clients[{ client_id, name, overdue, no_due_date, later, cells{ <key>: sistema }, total, unconverted, avg_days_to_pay, avg_days_late, paid_invoices }], payment_behaviour{ avg_days_to_pay, avg_days_late, clients }, review_invoices }`. Comportamiento de pago = facturas `Pagada` con pagos (12 meses): días emisión → último pago y vencimiento → último pago; **no ajusta** la proyección (va a Insights) |
| `GET /billing/receivables/goal` (`year`, `company_id`, `source`) · `PUT /billing/receivables/goal` (`{ year, amount \| null, monthly?: [12], companies?: [{ company_id, amount }] }`, permiso de edición) | **Presupuesto de ingresos a caja** (02-10, reemplaza la "meta" y su jsonb, nunca aplicado): presupuesto `cash_in` activo (escenario base) del año en `budgets` (`BudgetsService.activeFor`; mensual = la línea del mes, anual = ÷ 12 con residuo al último mes) vs **cobrado** (pagos monetarios del año, `settlement_reason IS NULL`) vs **proyectado** (cobrado + saldo que vence en el año; lo vencido cuenta en el mes del corte): `{ as_of, year, currency, goal, collected, open_due, overdue, no_due_date, projected, pct_collected, pct_projected, budget_ytd, pct_ytd, months[{ month, collected, expected, budget, pct }], unconverted_payments, scope (holding\|companies\|unavailable\|none), budget{ id, name, currency, period_granularity, total, monthly[], companies[], updated_at } \| null }`. Con `company_id`: suma del reparto por compañía (`unavailable` si no está repartido). El PUT arma las líneas (`goalBudgetLines`: una línea anual o 12 mensuales; el reparto por compañía, con distribución mensual, se reparte cada mes en la proporción de su anual) y llama `BudgetsService.upsert`; 400 `errors[]` si la distribución o el reparto no suman el anual; `amount: null` archiva. Sin la tabla (migración sin aplicar): GET sin presupuesto (`scope: none`) y PUT 409 `budget_storage_missing` |
| `GET /billing/receivables/forecast` · presupuesto (02-10) | Además `companies[{ company_id, name, country, overdue, no_due_date, later, cells, total, unconverted }]` (misma partición que `clients`) y `budget{ scope, currency, budget_ids, missing_years, periods{ <key>: { budget, collected, projected, pct } }, total, by_company[{ company_id, budget{ <key> }, total }], reason }` (`BillingCollectionsService.forecast`): presupuesto `cash_in` de los años del rango alineado al período (`budgets-rules.ts:alignToPeriods`: mes = el del mes; semana/día = prorrateo por días de cada mes), cobrado del período hasta el corte (pagos monetarios por día) y proyectado (vence en el período; el del corte suma Vencido por cobrar); `pct` = (cobrado + proyectado) ÷ presupuesto. Solo comparable sin filtros de cliente, moneda, segmento, mercado o búsqueda (`unavailable` con `reason`) |
| DSO y chequeos de datos (02-10; `billing-receivables.ts`) | `aging` agrega `dso{ as_of, days, receivable_system, billed_system, window_days: 90, unconverted }` y `data_checks[{ code: 'system_amount_inconsistent', count, balance_system, message, invoices_sample[≤20] }]`; `summary` agrega `dso{ …, previous }` (a hoy y al cierre del mes anterior) y `data_checks`. **DSO** = round(Por cobrar ÷ Facturado de los últimos 90 días × 90) en moneda de sistema (fórmula de `ARAgingReport`): Por cobrar al corte = total − pagos confirmados en la moneda de la factura con fecha ≤ corte (Pagada sin pagos que la cubran = 0); Facturado = `total_system_currency` de las facturas Emitida/Enviada/Vencida/Pagada con `issue_date` en [corte − 90, corte]; sin CLF/UF ni facturas sin conversión. **Monto en sistema inconsistente** = factura con saldo cuya razón `total_system_currency ÷ total` está a más de 10× de la mediana de su moneda y mes de emisión: se informa, no se corrige ni se excluye |
| `GET /billing/receivables/dso-trend` (filtros de la antigüedad + `as_of`, `months` 1–24, default 12) | `{ as_of, currency, window_days, method: 'cut_by_dates', points[{ month, as_of, days, receivable_system, billed_system, window_days, unconverted }] }`: un punto por cierre de mes (el último, al corte), reconstruido con fechas de emisión y de pago (`dsoSql`, una consulta con `unnest` de cortes) |
| `segment` · `market` (02-10; `BillingFiltersDto`, `receivables/aging`, `forecast`, `dso-trend`) | Segmento y mercado del cliente (`clients.segment` / `clients.market`, texto libre; hasta 20 valores separados por coma, igualdad exacta sin espacios). `GET /billing/filters` agrega `segments[]`, `markets[]` (de los clientes con facturas) y `country` por compañía; `aging.by_company[]` e `invoices[]` traen el país de la compañía (`company_country`) |
| `GET /billing/subscription-invoices` (filtros comunes + `sortBy`/`sortOrder`/`page`/`limit` + `charge_state=paid\|open\|failed\|refunded\|void`) | Solo lectura (02-10): facturas con `subscription_id` (Stripe). Filas de la lista + `subscription_id`, `subscription_external_id`, `subscription_status`, `stripe_id`, `stripe_status`, `document_url` (`hosted_invoice_url` o `invoice_pdf` de `stripe_invoices_stg.raw_data`), `plan` (productos de las líneas), `period_start`/`period_end`, `charge_state`, `charge_attempts`; `counts{ paid, open, failed, refunded, void }` del filtro. Desde el 02-10 (pestaña **Invoices**): `source_provider` (`subscriptions.source`, default `stripe`), `source_account` (`stripe_connections.name` por `COALESCE(sb.connection_id, st.connection_id)`, o `raw_data->>'account_name'`), `source_connection_id`, `source_livemode`. Estado del cobro: `refunded` (`post_payment_credit_notes_amount > 0` o NC activa) → `void` → `paid` → `failed` (`uncollectible` o `attempt_count > 0`) → `open` |
| `source` en las lecturas (`BillingFiltersDto`, también `receivables/aging`) | `contract\|subscription\|other` separados por coma (sin él: todos): suscripción = `subscription_id IS NOT NULL`; contrato = sin suscripción y con `contract_id`; otra = el resto. El resumen agrega `subscriptions{ net, collected }` (moneda de sistema): Facturado y Cobrado incluyen suscripciones |
| `GET /billing/calendar` (filtros comunes sin `from`/`to` + `granularity=month\|week\|day`, `start`, `end`, `scope=invoices\|to_issue`, `group_by=client\|contract`) | `{ granularity, scope, group_by, start, end, today, currency, date_field, periods[{ key, start, end, kind? }], rows[{ key, client_id, client_name, contract_id, contract_number, cells{ <key>: { invoices, by_currency[{ currency, amount, invoices }], system, unconverted, by_state, items[≤20] } }, totals }], totals{ <key> }, grand_total, truncated }`. Rango máx. 24 meses, 26 semanas o 62 días (400 si no). `scope=invoices`: estado `to_issue\|issued\|overdue\|paid\|credit_note\|cancelled`, por emisión o vencimiento (`date_field`), sin Canceladas por defecto, hasta 20.000 facturas. `scope=to_issue`: la cola (estado = grupo de `queueEntries`), atrasadas anteriores al rango en `before`, hasta 5.000. Puro en `billing-calendar.ts` |
| `GET /billing/invoices/:invoiceId` | la misma fila decorada que `/invoices` (incluye Canceladas e inactivas) + `payments_summary{ currency, total, paid, balance, payment_state, payments_count, voided_count, other_currency_count, last_payment_date }` (`payments_count` = confirmados en la moneda de la factura); 404 `Factura no encontrada` si no es del holding. Lo usa el enlace profundo `/lab/facturacion?invoice=<id>` |
| `GET /billing/invoices/:invoiceId/payments` | `{ invoice{ id, invoice_number, status, currency, total, paid, balance, payment_state, due_date }, payments[{ id, amount, currency, payment_date, method, reference, notes, confirmed, counts, created_by{ id, name }, created_at, bank_movement_id, settlement_reason, original_amount, original_currency, fx_rate, voided_at, void_reason }] }` (`original_currency` = `bank_movements.currency` cuando hay `original_amount`) |
| `GET /billing/invoices/:invoiceId/emails` | `[{ id, kind: proforma\|invoice\|reminder\|collection, recipients[], subject, sent_by{ id, name }, sent_at, status: queued\|sent\|delivered\|failed\|bounced\|skipped }]` (`normalizeEmailStatus`: `invoice_emails` no tiene columna de estado → `sent`; `invoice_collection_logs.status` texto libre → conjunto cerrado, desconocido → `sent`) |
| `GET /billing/collection-settings` | `{ dunning_enabled, email_from, bcc, reminder_days_before[], reminder_days_after[], email_subject_template, email_body_template, exists, updated_at }` (sin fila: defaults con `dunning_enabled: false`) |
| `GET /billing/filters` | `{ companies[{ id, name }], clients[{ id, name }], client_entities[{ id, name }], currencies[], contracts[{ id, contract_number, client_id }], statuses[], document_kinds[], erp_states[], electronic_states[], payment_states[], credit_types[] }` |
| `GET /billing/invoices/export` (filtros + `detail=header\|lines`, `sortBy`, `sortOrder`) | XLSX en stream (`facturacion-facturas-YYYY-MM-DD.xlsx`), hojas *Facturas* (+ *Líneas*), sin corte (lotes de 1.000) |
| `POST /billing/payments/preview` · `POST /billing/payments` · body `{ allocations[{ invoice_id, amount }] (1–100), currency, payment_date, method?, reference?, notes? }` | `{ allocations[{ invoice_id, invoice_number, contract_id, amount, before, after, blockers[] }], blockers[], total_amount, currency, can_apply }` (`before`/`after` = `{ status, paid, balance, payment_state }`); el POST agrega `applied, payment_group_id, payment_ids[], event_ids[]`. Todo o nada |
| `POST /billing/payments/*` · plan | además `warnings[]` (siempre presente; `multiple_clients` solo en el camino manual de conciliación) |
| `POST /billing/payments/:paymentId/void` · `{ reason }` | `{ payment_id, invoice_id, voided: true, before{ status, paid }, after{ status, paid }, event_id }` |
| `POST /billing/invoices/:invoiceId/proforma` · `{ recipients[] (1–10), subject?, message?, pdf_base64?, filename? }` | `{ invoice_id, sent, recipients[], subject, attachment, email_ids[], warnings[] }` |
| `POST /billing/collections/preview` · `{ invoice_ids[] (≤200), recipients_mode: entity_contacts\|custom, recipients?[], subject?, message? }` | `{ emails[{ client_id, client_name, recipients[], bcc[], subject, body_html, invoices[{ id, invoice_number, currency, balance, due_date, days_overdue }] }], skipped[{ invoice_id, invoice_number, reason, message }], blockers[], warnings[], sender{ from, name }, totals_by_currency[{ currency, amount, invoices }], can_apply }` (`totals_by_currency` = saldo de lo que saldría, por moneda) |
| `POST /billing/collections` | `{ bulk_id, sent[{ client_id, invoice_ids[], recipients[] }], failed[{ client_id, invoice_ids[], message }], skipped[], warnings[] }` |
| `PUT /billing/collection-settings` · `{ dunning_enabled, reminder_days_before[], reminder_days_after[], email_from?, bcc?, email_subject_template, email_body_template }` | igual que el GET |
| `POST /billing/to-issue/{send-now,reschedule,fx}[/preview]` · `POST /billing/to-issue/erp-reset` · `{ invoice_ids[] (≤200), …cuerpo del endpoint del contrato }` | `{ bulk_id, operation, preview, contracts, results[{ invoice_id, invoice_number, contract_id, ok, blockers[], warnings[], message? }], summary{ ok, failed } }` |

### 3.1 Conciliación bancaria (`/billing/reconciliation/*`, spec [`spec-conciliacion-v2.md`](./spec-conciliacion-v2.md) §4)

`BillingReconciliationController` + `BillingReconciliationService` (mismos guards; lecturas `VIEW_FACTURACION`, escrituras `EDIT_FACTURACION`);
puros `billing-reconciliation-statement.ts` (cartola → líneas normalizadas, huella por línea) y `billing-reconciliation-match.ts` (motor D1–D4 +
F1, formas, diferencia con motivo, `planMatch`). Tablas: `bank_movements`, `bank_upload_batches`, `bank_column_mappings`, `company_bank_accounts`,
`invoice_payments` (+ `original_amount`, `fx_rate`, `settlement_reason`, migración `1790740000000`, aplicada en QA y producción el 02-10).

| Ruta | Respuesta |
|---|---|
| `GET /billing/reconciliation/summary` (`from?`, `to?` YYYY-MM-DD, `bank_account_id?`) | `{ period{ from, to }, pending, reconciled_period, differences, unidentified` (cada uno `{ count, by_currency[{ currency, amount }] }`), `ignored{ count }, by_confidence{ exact, high, medium, none }, accounts[{ id, company_id, company_name, bank_name, account_number, currency, movements, last_movement_date }], has_source, last_batch{ id, file_name, created_at, status, row_count } \| null }` |
| `GET /billing/reconciliation/movements` (`from, to, bank_account_id, state, confidence, kpi, include_debits, q, page, limit ≤ 200, sortBy date\|amount, sortOrder, fee_threshold_pct`) | Paginado `{ data[fila], total, items, currentPage, pages, limit }`; fila `{ id, date, description, reference, counterparty_name, counterparty_tax_id, amount, currency, bank_account_id, bank_name, account_number, batch_id, state, applied, remaining, adjustments, ignore_reason, reconciled_at, reconciled_by, best, payments[] }` (`best` en vivo para la página; nunca moneda distinta ni varios clientes) |
| `GET /billing/reconciliation/movements/:id/suggestions` | `{ movement, suggestions[≤ 5]{ key, shape, confidence, score, reasons[], allocations[{ invoice_id, invoice_number, client_id, client_name, contract_id, currency, balance, amount }], movement_ids[], total, difference }, related_movements[] }` |
| `GET /billing/reconciliation/candidates` (`q, client_id, currency, limit ≤ 50`, default 20) | `{ data[{ invoice_id, invoice_number, client_id, client_name, client_entity_name, tax_id, contract_id, read_only, currency, total, balance, due_date, issue_date, status, payment_state }] }` (saldo = `balanceSql` vía `invoicesCte`) |
| `POST /billing/reconciliation/statements/preview` · `POST /billing/reconciliation/statements` · `GET` (paginado) · `POST statements/:batchId/revert` | vista previa `{ account, lines[], summary, warnings[] }`; importar `{ batch_id, inserted, skipped_duplicates, errors, template_id, warnings, suggestions{ exact, high, medium, none } }` (409 `nothing_to_import`); lotes `{ id, file_name, created_at, uploaded_by, bank_account, row_count, status, movements, reconciled, can_revert, revert_blocker }`; revertir `{ batch_id, removed }` (409 `batch_has_payments`, `already_reverted`) |
| `GET/POST /billing/reconciliation/templates` · `PUT/DELETE /templates/:id` | `{ id, bank_name, mapping_name, column_mapping, is_default, created_at }` |
| `POST /billing/reconciliation/matches/preview` · `POST /matches` | `{ items[{ key, ok, movement_ids, currency, invoice_currency, fx_rate, movements[], invoices[], blockers[], warnings[] }], summary{ ok, blocked, by_currency[{ currency, cash, adjustments, items }] } }`; el POST suma por ítem `{ applied, payment_ids, event_ids, error }` (todo o nada por ítem) |
| `POST /billing/reconciliation/movements/:id/undo` · `/ignore` · `/reopen` · `POST /suggestions/refresh` | `{ movement_id, voided_payment_ids, state }` · `{ movement_id, state }` · `{ updated, by_confidence }` |

**Single path**: `matches` llama a `BillingPaymentsService.register(holdingId, dto, authId, now, { runner, bankMovementId, originalAmounts,
originalCurrency, fxRate, settlementReason, allowMultipleClients })` dentro de una transacción `withApiWriter` por ítem; `undo` llama a
`void(…, { runner })`. `planPayments(…, { allowMultipleClients })` deja `client_mismatch` como aviso `multiple_clients`. Las columnas nuevas solo
entran al INSERT si vienen en las opciones (el `POST /billing/payments` público no cambia).

**Revisión del dueño 02-10 (otros cambios de forma)**: `GET /billing/to-issue` acepta `sortBy`/`sortOrder` (lista blanca de la lista; ordena
la página, sin ellos emisión ascendente). Las filas (`mapInvoiceRow`) suman `tax_document_name`/`tax_document_kind` (documento tributario del
contrato, `LEFT JOIN tax_document_types tdt ON tdt.id = c.tax_document_type_id`) y `vat_contract_currency`/`total_contract_currency` (IVA ÷
`fx_contract_to_invoice`; misma moneda = el IVA; spot = `null`); el XLSX de la vista agrega Moneda contrato, Neto/IVA/Total (contrato).
`GET /billing/calendar`: una Por Emitir **sin valorizar** (`total_due` nulo, spot) ya no suma "0" en la moneda de la factura: va en
`unvalued[{ currency (del contrato), amount (neto en contrato), invoices }]` de celdas, filas y totales, y en `items[].unvalued/contract_currency/
amount_contract`; `unconverted` cuenta solo valorizadas sin conversión; `system` nunca incluye las sin valorizar.

## 4. Códigos de bloqueo y motivos

- **Cola** (los del 360, con `action`): `not_pending`, `unified_invoice`, `legacy_invoice`, `credit_note_send_pending` (sin `period_closed` desde 03-10: el cierre no bloquea facturas)
  (`reschedule`), `sent_to_erp_draft` / `already_sent` (`erp_reset`), `erp_send_disabled` (`billing_conditions`), `no_erp_integration`
  (`integrations`), `no_erp_partner` (`client_entity`), `needs_reference` (`references`), `no_lines` (`edit`), `item_without_product`
  (`contract_items`), `fixed_fx_without_rate` (`fx`), `tax_rate_missing` (`company_settings`); avisos `past_issue_date`, `spot_fx`.
  Con `issue_path = external` no aplican `erp_send_disabled`, `no_erp_integration`, `no_erp_partner`, `already_sent`, `tax_rate_missing`.
- **Pagos, correo de cobro y proforma**: `no_contract` (factura sin contrato: solo lectura, spec §11.1; en cobranza bloquea la operación entera, 409), `not_issued`, `credit_note`, `cancelled`, `payment_currency_mismatch`, `overpayment`, `client_mismatch` (sin `period_closed` desde 03-10),
  `already_voided` (anular).
- **Conciliación**: los de `planPayments` + `movement_not_found`, `movement_is_debit`, `movement_not_pending`, `movement_overapplied`,
  `movement_currency_mixed`, `fx_required`, `fx_inconsistent`, `note_required`, `invoice_not_found`, `nothing_to_apply`; aviso `multiple_clients`;
  importar `nothing_to_import`, `invalid_mapping` (400), `no_bank_account` (404); revertir `batch_has_payments`, `already_reverted`; deshacer
  `movement_has_no_payments` (+ `already_voided` de `void`); ignorar/reabrir `movement_has_payments`, `movement_not_pending`,
  `movement_not_ignored`.
- **Fan-out**: `not_found`, `no_contract`, `not_applied`, `error` + los que devuelva el contrato.
- **Correos**: `skipped.reason` ∈ `no_contacts`, `paid`, `not_issued`, `credit_note`, `cancelled`, `not_found`; bloqueos `no_sender`,
  `nothing_to_send`, `credit_note`/`cancelled` (proforma).

## 5. Pagos, correos y recordatorios

- **Permiso** (Q6, códigos verificados en prod el 01-10): `BillingPermissionGuard` (después de `HoldingScopeGuard`) exige `VIEW_FACTURACION`
  en todo el controlador y `EDIT_FACTURACION` en cada POST/PUT (pagos y su vista previa, anular, proforma, cobranza, configuración de
  recordatorios y el fan-out `to-issue/*`); super admin pasa siempre. El código se busca en `role_permissions` del rol del usuario.
- **Correo**: `EmailsService.send` (SendGrid) ahora acepta varios `to`, `bcc` (sin repetir los de `to`) y adjuntos. Remitente:
  `invoice_collection_settings.email_from` o `SYSTEM_EMAIL_FROM` (aviso `system_sender`). Plantillas con variables del catálogo
  (`invoice_number, client_name, amount_due, due_date, issue_date, company_name, days_overdue, currency, contract_number`), todo escapado.
  Destinatarios: `client_contacts` del cliente (prefiere tipo facturación/cobranza; respeta `contact_preferences.allow_billing_emails`).
- **Proforma**: el cuerpo usa los datos de `ContractsService.invoiceDetail` (los mismos de la Proforma del 360); el PDF lo dibuja el front
  (`facturacion/_lib/proforma-adjunto.ts` importa `buildProformaModel` + `drawProformaPdf` de Contratos) y viaja en `pdf_base64` + `filename`
  (nombre saneado al patrón del DTO); si no se puede dibujar, el correo sale con el resumen y el front lo avisa. Fila por destinatario en `invoice_emails` (`template = proforma`).
- **Job `billing-reminders`** (08:00 America/Santiago, `billing.scheduler.ts`): doble llave, `BILLING_REMINDERS_ENABLED=true` (global) y
  `dunning_enabled` por holding. Emitidas con saldo cuyo vencimiento cae en `reminder_days_before`/`after`; solo correo, nunca NC;
  idempotente por factura + día (`pg_try_advisory_xact_lock` + log `metadata{ kind: 'reminder', run_date, trigger, days }`).

## 6. Assets escritos (no aplicados)

| Asset | Cambio |
|---|---|
| `src/databases/postgresql/functions/after_invoice_payment_change.sql` | Guard de la costura como primera sentencia (`sapira.writer = 'api'` → `RETURN NULL`): los pagos de v2 no pasan por `recalc_invoice_status` (que marca Pagada sumando monedas distintas y pasa una Por Emitir a Enviada, B-F3/B-F14). Es la función de los tres triggers de `invoice_payments` (`trg_recalc_after_insert`, `trg_recalc_after_update`, `trg_recalc_after_delete`), así que los tres quedan no-op para la API. `trg_set_invoice_payment_defaults` no se toca (solo rellena NULL; la API escribe holding, moneda y autor). Cubierto por `costura-sapira-writer.spec.ts`. Aplicado en QA y producción el 02-10 (api v0.0.73/74) |

| `src/databases/postgresql/special-index/uq_bank_movements_fingerprint.sql` | Índice único parcial de huella por línea de cartola (`holding_id`, `original_row_data->>'fingerprint'`); también lo crea la migración `1790740000000-BankReconciliationV2` (`IF NOT EXISTS`) |

Migraciones **aplicadas en QA y producción el 02-10**: `1790730000000-CollectionDunningDefaultOff` y `1790740000000-BankReconciliationV2` (spec-conciliacion §2.1:
estado `Ignorado` + `ignore_reason`, índice de huella, `invoice_payments.original_amount`/`fx_rate`/`settlement_reason` con dos CHECK). Hasta
aplicarla fallan a propósito los specs de deriva `conciliacion.entities.spec.ts` y `facturacion.entities.spec.ts`, y `/billing/invoices/summary`,
`/billing/invoices/:id/payments` y `/billing/reconciliation/*` leen columnas que aún no existen: **aplicar antes de desplegar**. Cambios de código fuera del módulo: `ContractsModule` exporta `ContractInvoicesService`; `contract-invoices.service.ts`
exporta `CONTRACT_INVOICE_SELECT`, `CONTRACT_CONTEXT_SELECT`, `contractInvoiceRowOf`, `contractInvoiceContextOf` (refactor sin cambio de
comportamiento); `contracts.service.ts` exporta `DEVIATION_ADJUSTMENT_TYPES`; `EmailsService.send` (varios `to`, `bcc`, adjuntos).

Migración **aplicada en QA y producción el 02-10** (v0.0.75/76): `1790750000000-Budgets` (reemplaza a `CashInGoals`, que nunca se aplicó): tablas `budgets` y
`budget_lines` con RLS (8 policies como assets), triggers de `updated_at` y el índice de celda (asset en `special-index/`). Efecto exacto en
`budgets-forecast-real.md` → "Construido 02-10: esquema". Módulo `budgets` (`GET /budgets`, `GET /budgets/:id`, `PUT /budgets`,
`POST /budgets/:id/archive`; permisos de Facturación). Hasta aplicarla, los reportes muestran "sin presupuesto" y guardar responde 409
`budget_storage_missing`; no hay spec de deriva que falle (las entities nuevas no son espejos: el snapshot de prod no las tiene).

## 7. Pendientes y brechas

- **Invoices de Stripe con segunda cuenta** (p. ej. Stripe México con CFDI): ver spec §11 #7; hoy la Fuente muestra proveedor · cuenta y se
  verá cuando exista otra conexión. Sin cuenta conocida, solo el proveedor.

- `invoice_collection_settings.dunning_enabled`: el default pasa a **`false`** con la migración `1790730000000-CollectionDunningDefaultOff`
  (entity actualizada; **pendiente de aplicar**). Prod tiene 1 fila (verificado 01-10). El job sigue exigiendo además
  `BILLING_REMINDERS_ENABLED=true` (doble llave, sin cambios).
- Triggers de `invoices` bajo la costura: `invoices_fill_terms_from_contract_trigger`, `trg_assign_invoice_group_id`,
  `trigger_auto_populate_invoice_fx_to_system`, `trigger_auto_populate_invoice_tax_rate` (BEFORE) y `trg_rsm_on_invoice_change` (AFTER) ya
  son no-op para la API (bloque de Contratos). `trigger_sync_invoice_items_on_invoice_update` (`sync_invoice_items_on_invoice_update`) **no**
  tiene guard ni es invariante: copia `status`/`issue_date` de la factura a sus `invoice_items`; sigue corriendo para la API (también en
  `mark-issued` y en el cambio de estado por pagos) y es lo que mantiene ese espejo. Decisión de Domi 02-10: se deja como está: espejo de status e issue_date en las líneas, invariante simple hasta el switch; la API no escribe esos campos.
- `client_contacts` cuelga del cliente, no de la razón social (la spec decía "contactos de la razón social").
- `plan_deviation` es el último motivo registrado (`invoice_adjustments`), no el conciliador del 360 (correrlo por factura en la lista de
  holding es caro); `deviation_unexplained` = desvío registrado sin motivo.
- `open_consumption` no se evalúa en la cola (necesita el consumo por contrato).
- Proforma: la API no dibuja el PDF (no hay librería de PDF en la API); adjunta el del front, que lo manda siempre que puede (01-10).
- Si existe un guard de período sobre `invoices`, un pago sobre una factura de un período cerrado podría fallar al escribir el estado
  (sin verificar en base; desde 03-10 la fecha de pago no se compara con el cierre de períodos).
- Pagos legacy en otra moneda que la factura no cuentan en `paid` (`counts: false` en el detalle).

## 8. Cierre de brechas del 01-10 (sin commit)

- **API**: `GET /billing/invoices/:invoiceId` (`BillingReadService.invoice` = `rowsByIds` + `decorate` + `payments_summary`), declarada después
  de `invoices/summary` e `invoices/export` (si no, esas rutas caerían en `ParseUUIDPipe`). Test en `billing-sql.spec.ts`.
- **BFF/front**: `GET /api/facturacion/facturas/[invoiceId]`; `useFactura`; `FacturacionView` abre la vista rápida desde `?invoice=` (y `&tab=`),
  la mantiene en la URL al abrir/cerrar y la quita de las vistas guardadas; `facturaHref(id, tab)` para el índice del lab e Insights (el contexto
  de Insights indica el formato).
- **Cola**: chips de grupo y de motivo → `group` / `blocker_code` (URL `grupo`, `motivo`); clic en el bloqueo de una fila filtra por su motivo.
  Facturas: "Incluir Canceladas" → `include_cancelled=true` (URL `canceladas=1`; solo sin estados elegidos, no aplica a cola ni NC).
- **Calendario (F5)**: `?vista=calendario` en Por emitir; misma query de la cola (`limit` 200, aviso si la cola es mayor), grilla lunes-domingo
  del mes «Hasta», clic en un día lista sus facturas; sin API nueva (`_lib/calendario.ts`, test de agrupación por día).
- **"Ver en Facturación" del drawer**: `FacturaVistaRapidaDrawer` no tiene prop para ocultarlo; el cambio en Contratos queda propuesto en el
  README de `lab/facturacion` (no aplicado, espera OK de la dueña).
- **Timeouts de `Contrato360View` / `ContratosFiltrosDrawer` en la suite completa**: no vienen de Facturación (ningún test de Contratos importa
  Facturación ni comparte `QueryClient`: cada archivo monta el suyo y los hooks están mockeados). Son tests pesados (0,4–0,9 s aislados, ~3×
  bajo carga) que pasan el límite por defecto de 5 s cuando `yarn vitest run` corre los 226 archivos en paralelo; en la corrida del 01-10 pasaron
  y el que excedió fue otro (`lib/api/factura-proxy.test.ts`). Arreglo propuesto (fuera del alcance, sin aplicar): `testTimeout` mayor en
  `vitest.config` o `maxWorkers` acotado.

