# 📕 Benchmark — API pública de Relvo (OpenAPI completa), 2026-08-21

> Fuente: `https://app.relvoerp.com/public-openapi.json` ("Relvo App" v0.1.0 — **67 paths, 289 schemas**), descargada y analizada campo por campo.
> ⚠️ **Hallazgo mayor**: la API revela un modelo MUCHO más profundo que sus docs de producto — actualiza parcialmente el análisis competitivo del 21-08 (pipeline fiscal SII modelado, CLF/UF en el enum de monedas, FX por línea, cobranza con promesas de pago). Lo que sigue sin existir: cotizaciones, revenue recognition, reportes MRR, multi-holding, NC complejas.

**Convenciones de API a imitar**: montos SIEMPRE string decimal en `MoneyPayload {amount, currency}` (nunca float) · `Idempotency-Key` en TODOS los writes · token scoped a organización con permisos por endpoint · rate limits documentados.

## 1. Cliente = Party / BillingProfile / PartyBillingLink (el hallazgo estructural nº 1)

- **`Party`**: code, display_name, `type customer|vendor|employee`, `external_references[]`, `default_party_billing_link_id`.
- **`BillingProfile`** (razón social): legal_name, tax_id (+país/tipo/display), default_currency, timezone, `business_activity` (giro).
- **`PartyBillingLink`** (el vínculo operativo, donde vive TODO): `contacts[]` con **roles** (`billing|collections|commercial_reference|xml_email`), `fiscal_classification {default_document_family: invoice|receipt|export_invoice}` (→ 33/39/exportación), `tax_status (taxed|tax_exempt|reverse_charged)`, **`payment_provider (relvo|toku|manual|wire_transfer)`**, **`payment_terms_type (due_on_receipt|net) + payment_terms_days`**, status, direcciones con `comuna`.
- 💡 Resuelve de raíz nuestros dolores de razones sociales/tax/términos: el cliente comercial, la razón social y el vínculo operativo (contactos por rol + clasificación fiscal + términos + medio de cobro) son TRES entidades.

## 2. Catálogo y precios

- `Item` sin precio. `BillableMetric` con `definition_mode guided|sql` (métrica como SQL arbitrario) + filtros dimensionales + `usage_entry_schema` (formulario tipado para carga MANUAL de uso — `manual_usage_supported`). `SeatMetric` **por contrato**.
- **`Price`** reusable: `type fixed|usage|seat` × `price_model standard|graduated|package|percentage|volume|graduated_percentage` × `interval one_time|weekly|monthly|quarterly|semiannual|yearly` × `status draft|active|archived`.
    - Graduated/Volume: `ranges[{from_value, to_value|null, per_unit_amount, flat_amount}]` + `free_units` + **`pricing_group_keys[]`** (precio por grupo de dimensiones).
    - Package: `{package_size, amount, free_units, overage_unit_amount}`.
    - **Percentage (take-rate)**: `{rate, fixed_amount, free_units, per_transaction_min/max_amount}` — piso y techo POR TRANSACCIÓN.
    - Seat: `{amount, quantity_metric_id, quantity_strategy: snapshot_end, minimum_quantity, prorated, pay_in_advance}`.

## 3. Contrato "phase-first" con invoice_route (hallazgo estructural nº 2)

- **`Contract`**: `customer_id` + **`issuer_billing_profile_id`** (la razón social EMISORA es campo del contrato → multi-emisor nativo), `default_billing_schedule {day, month?, year?}` (ancla; day=31 ⇒ fin de mes), `status DRAFT|ACTIVE|PAUSED|UPCOMING|COMPLETED|AMENDED|CANCELLED`, `phases[]`, `revision_number`, `amended_from_contract_id`, `churn_at/churn_reason`, `commercial_reference_policy_summary`.
- **`Phase`**: `name` = **identidad estable a través de amendments**; **`activation_kind time_window|milestone`** (fases por HITO, no solo fechas); `prices[]` (referencias a precios pre-creados) + `price_filters` (el scope de uso pertenece al binding contrato-precio); `discounts[]` (usage|amount|percentage, con `restrict_to_prices[]` y `separate_invoice_line`); **`commitments[]` (mínimo con true-up) y `caps[]` (máximo con clawback)**; `amount_selectors[] (min|max entre precios candidatos` — "el mayor de A o B").
- **`invoice_route.invoices[]`**: el árbol de facturas SE DECLARA EN EL CONTRATO — `{name (identidad de merge), party_billing_link_id (receptor), invoice_currency, lines[{prices[], name_on_invoice}], split_group/split_weight (repartir montos entre N facturas por peso), commercial_references[] (la OC que ESA factura debe citar para ser pagable)}`. 💡 Es la generalización declarativa de nuestra facturación unificada/dividida — pero definida ANTES de facturar, no post-hoc.
- **Amendment**: `PUT /contracts/{id}` = contrato SUCESOR completo (`amended_from_contract_id`, revision). Cancel con `expected_contract_revision` (**locking optimista explícito**) + `issue_final_bill`. **Pause con `billing_behavior bill_through_pause|hold_unbilled`**.

## 4. Metering

Ingesta batch ≤500 "Orb-compatible", **asíncrona con receipt** (`pending|processing|processed|failed|dead`) · eventos **inmutables** con corrección `VOID|REPLACE` + `reason_code` y **`UsageReratingStatus`** (re-tarificación trazada) · `/evaluations` evalúa una métrica para un receptor/período con desglose y **evidencia de eventos** · seat-events `{change_type added|removed, count, effective_date}`.

## 5. Factura como documento fiscal chileno de primera clase

- **Ejes de estado INDEPENDIENTES**: `lifecycle (upcoming→draft→open→partially_voided→void)` · `payment (unpaid|partially_paid|paid|overdue)` · **`fiscal (not_submitted→pending→accepted|rejected)`** (SII) · `delivery (not_sent→…→delivered|delivery_failed)` · `totals (draft_computed|deferred_fx|final)`.
- Fiscal: `invoice_type domestic|export|receipt`, `fiscal_document_type_code` (código DTE), **`fiscal_folio`**, `fiscal_uuid`, XML descargable, snapshot `issuance_*` congelado a la emisión, **`issued_from_relvo`** (nativa vs importada del SII), `/customer-binding` para facturas importadas.
- **FX**: `draft_totals_by_currency`, `fx_rates[]`, overrides por documento, **`fx_rate + fx_rate_source` POR LÍNEA**, `deferred_fx` (totales resueltos a la emisión), y **`FxRateSource` como escalera de precedencia persistida**: `same_currency → contract_rate → manual_override → official → derived → manual_draft → manual_official → inherited_from_source_document`. **`CLF` (UF) está en el enum de monedas.**
- **`DocumentLine` compartida** entre factura/NC/ND: `amount_basis unit_rate|exact_total` (el input financiero irreducible), `source billing_engine|manual`, `service_period_start/end`, taxes aplicados, item_id.
- Operativa: `draft_body_origin generated|operator_edited`, `recompute` con `confirm_discard_draft_edits`, **`/versions/{n}` snapshots inmutables**, `/activity` (log de hechos), `payment-link` hosted, `operational_batch` (contrato/período/posición del batch).

## 6. NC/ND

Credit Note: **`void_scope full`** (reversa exacta sin economics en el request) **| `partial`** (las líneas del cliente SON el documento, `amount_basis` obligatorio) → CodRef SII 1/3 · preview antes de crear · mismos campos fiscales · Debit Note simétrica + `/void`. Sin NC multi-factura, sin NC standalone, sin wallets.

## 7. Collections (mucho más profundo que sus docs de producto)

Workflow por factura `{status none|scheduled|active|paused|review_required|completed, current_node_key, next_wakeup_at}` · operaciones pause/resume/cancel/require_review/reschedule/restart/replace_policy · `pause_reason` incl. `dispute`, **`promise_to_pay`**, `payment_in_flight` · resume con **`follow_broken_promise_branch`** (promesas rotas) · review-queue asignable · log de `executions` por nodo · **dunning policies VERSIONADAS** (draft/publish/retire/assign con scope) · aging por `status × payment_provider × currency`. **No existe recurso Payment**: el pago es estado de la factura + providers (relvo|toku|manual|wire).

## 8. Referencias comerciales OC/HES (con AI)

`CommercialReferenceKind` = TpoDocRef SII completo + `purchase_order`, **`hes`**, `contract_reference`, `dispatch_guide`… Viven en 3 lugares: (1) en el contrato/routed invoice como **requisito de pagabilidad**; (2) en cada documento; (3) `commercial_reference_policy_summary {requires_purchase_order, requires_hes, blocking_rule_count}` → **`issuance_blocked_reason` en la factura** (el gate que nos falta, modelado). Pipeline AI: `GET /commercial-references/parsed` — OC/HES **extraídas de correos entrantes** (attachment, TIN, montos, `candidate_invoice_ids` para matching) vía módulo `messaging` con clasificación AI ("AI suggestion for human review, never financial truth").

## 9. Qué NO existe en su API

Cotizaciones/CPQ · plans públicos · payments/refunds como recurso · **revenue recognition (cero: sin schedules ni deferred)** · reportes MRR/ARR/waterfall · multi-holding (token = 1 org) ni parent-child · NC multi-factura/standalone · tax engine (IVA = string en header) · entitlements/portal/checkout · conciliación bancaria expuesta.

## 💎 Para Sapira v2 (síntesis del agente)

1. **Party/BillingProfile/PartyBillingLink** + emisor como campo del contrato = solución estructural a razones sociales/tax/términos.
2. **invoice_route declarado en el contrato** (receptor, moneda, líneas, splits por peso, OC requerida por factura) = nuestra unificada/dividida pero declarativa.
3. Ejes de estado independientes + `FxRateSource` escalera + `amount_basis` por línea + snapshots de versión + OC/HES con reglas de bloqueo.
4. Huecos comunes de Relvo Y Alguna = ventaja defendible de Sapira: **cotizaciones integradas, multi-holding real, NC complejas con devengo, RSM/MRR** — ninguno de los dos los expone.

Archivos crudos para re-consulta (scratchpad de la sesión): `alguna_openapi.json`, `relvo_openapi.json`, `alguna_docs/*.md`.
