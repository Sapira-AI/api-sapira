# 📗 Benchmark — Alguna (docs + OpenAPI 2026-04-01), 2026-08-21

> Fuente: 34 páginas markdown de alguna.com/docs + spec OpenAPI completa (80 endpoints, 245 schemas). API `api.alguna.io`, Bearer, versionado por header, webhooks HMAC, SDK TS **y servidor MCP propio**.
> Posicionamiento: "pricing, quoting and billing operations" B2B (AI/infra, fintech, SaaS).

## 1. Entidades núcleo

- **Customer**: `currency` ÚNICA, `aliases[]`, tax completo (`tax_reason: standard_rated|reverse_charge|customer_exempt|zero_rated`, `tax_type: vat|sales_tax|gst`), `parentCustomerId` — **Customer Family de UN nivel** (prerrequisito del roll-up billing al padre).
- **Product**: `fee_type fixed|metered`, `billing_frequency`, `payment_terms advance|arrears`, **`revenue_allocation_method (straight_line|usage_based|contract_level_straight_line)` EN el producto**, `metric_ids[]`. Catálogo sin precio.
- **Billable Metric**: `event_name` + `aggregation {method: count|count_unique|sum|average|min|max, field}` + `filter_groups` (and/or).
- **Plan** (template) vs **Subscription** (instancia): ⚠️ **el "contrato" NO es entidad — es un value-object dentro de la suscripción** (`contract {start_date, duration_months, period_type fixed|monthly_rolling, end_date}`); `renewal {...}`, `minimum/maximum_spend`, `price_escalation`, `pending_changes[]`.
- **Subscription Version**: la historia del contrato — `status: draft → pending approval → published → active → superseded`, items con precio completo, fechas, nota de auditoría. **Ramps/fases = versiones programadas a futuro.**
- **Quote**: ciclo Draft→Sent→Accepted con e-firma nativa — **solo dashboard, NO existe en la API**.
- **Credit Grant / Wallet**: créditos `monetary|units` con expiración y prioridad; wallet por moneda con restricción por producto; **`/credits/check` (reserva con hold) + `/credits/track` (consumo/settlement)** en tiempo real — patrón de gating para productos AI.
- **Legal Entity** (emisor): existe (`credit_note.legal_entity_id`, revenue por entidad) pero **sin CRUD público** — multi-entidad de segunda clase.

## 2. Pricing (10 tipos)

`unit, fixed, tiered, graduated_tiered, tiered_percentage, graduated_percentage, volume_percentage, prepaid_tiered, prepaid_fixed_tiered, expression`

- Tiers: `{min_units, max_units, price_per_unit, fixed_fee, unit_price}`; prepago con `prepaid_units` + `overages_charge_interval`.
- **Expression pricing** (diferenciador): `quantity_expression` + `unit_price_expression` + `metric_bindings[{alias, metric_id}]` — fórmulas arbitrarias sobre métricas.
- Mínimos/caps (`minimum/maximum_spend {amount, period}`) y descuentos con duración limitada, **en 3 niveles: price, plan y subscription**.
- `price_escalation {percentage, interval_months, escalate_metered_unit_rates}` (escalador automático).
- **Instalments**: divide un cargo anual anticipado en cuotas mensuales dentro del ciclo (`recurring_instalment_interval_*`) — devengo anual, cobro mensual.
- Price books por moneda o conversión automática desde base.

## 3. Amendments (el mejor patrón de los benchmarks)

- Todo cambio = **nueva versión inmutable** (full-state) o **Changes API delta** (`add[]/update[]/remove[]` + `adjust` merge) con **`POST /changes/preview` ANTES de aplicar**. `effective: immediate | next_billing_period | next_term_renewal | fecha`.
- Approval workflow integrado en versiones (pending approval → aprobadores → activa) + auditoría (quién/cuándo/qué/notas).
- **Prorrateo por comportamiento elegible por cambio**: `Full Proration / No Proration / Credit Only / Charge Only` + "Always Invoice"; crédito de downgrade se aplica a la siguiente factura; preview obligatorio en UX.
- Cancelación: `immediate|end_of_period` + `reason` enum + acreditar tiempo no usado + reactivación antes de aplicar.
- La factura `upcoming` del período se **recalcula en vivo** con líneas crédito/cargo con rango de fechas.

## 4. Usage y facturación

- `POST /events` batch ≤100, `unique_id` idempotente, `properties` ≤50; CSV y data sources (BigQuery).
- Estados de factura: `draft, upcoming (viva), pending_approval, scheduled, issuing, issued, paid, overdue, void, canceled`. Aprobación manual/automática, individual y bulk. Numeración por secuencia global o por cliente + prefijo. **Emisor delegable: Alguna, Stripe Invoicing, Xero, QuickBooks** (sin facturación electrónica propia).
- **Roll-up billing**: hijos facturan al padre en una factura agrupada cliente→bundle→producto; el revenue reporting sigue atribuido al hijo.

## 5. Revenue recognition (de primera clase — valida nuestro RSM)

- `RevenueScheduleEntry`: `new/total_deferred_revenue`, `recognized`, **`contract_asset` (unbilled)**, desglose fixed/metered/one-off, intervalo daily/monthly, método por producto; consultas por org / customer / **legal entity** / subscription.
- FX a moneda funcional con **tasa bloqueada a fecha de factura** + reporte de FX gain/loss.
- **Revenue Assurance**: detección de fugas (usage huérfano, cobertura expirada, adopción fuera de plan) — venden que recupera "3–8% del ARR". 💡 Idea potente para Sapira (nuestras validaciones holding-wide, productizadas).

## 6. API y webhooks

Recursos: customers, products, bundles, plans, metrics, events, subscriptions (+versions +changes +preview), invoices (+line-items CRUD, mark-as-paid, void, pdf), payments (RO), credit-notes (+apply), refunds, wallets, credits (check/track), revenue-schedules, **insights** (AR aging, MRR/ARR/ACV por suscripción), checkout-sessions, customer-portal-sessions, tax/calculations. Webhooks: subscription._, approval_request._, invoice.issued/paid, payment._, account.credits._.

## 7. Debilidades / ausencias

Sin CPQ en API (quotes solo dashboard) · multi-entidad legal sin CRUD, jerarquía clientes de 1 nivel, sin multi-holding · **cero LATAM** (sin DTE/folio/boleta/ND, OC = texto libre `purchase_order_number`, emisión delegada a Stripe/Xero/QBO) · **sin cobranza** (ni dunning ni conciliación; solo AR aging report) · multi-moneda fuerte en config pero API expone poco (una moneda por customer, sin override FX por documento, sin UF/indexación) · payments solo lectura.

## 💎 Para Sapira v2

(a) **Versionado inmutable + Changes API con preview + proration behaviors seleccionables** = EL patrón para P1 #5 Modificaciones (y la "iteración 2 preview-antes-de-persistir"). (b) Revenue schedule con contract_asset/deferred por entidad legal valida el RSM como diferenciador (Relvo no lo tiene en absoluto). (c) Mínimos/caps/escaladores estructurados en 3 niveles. (d) Instalments (devengo anual, cobro mensual). (e) Revenue Assurance como producto. (f) Créditos con check/track en tiempo real para pricing AI.
