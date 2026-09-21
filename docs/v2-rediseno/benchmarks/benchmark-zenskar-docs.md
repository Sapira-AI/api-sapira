# 📘 Benchmark — Zenskar (docs de producto + API), 2026-08-21

> Recorrido de docs.zenskar.com: ~25 páginas clave de /docs y /reference (sitemap: 168 páginas de guías + 186 de API). Base API `https://api.zenskar.com`, auth headers `x-api-key` + `organisation`.
> Zenskar se autodefine "revenue automation platform" entre CRM y ERP; 3 principios: AI-native, **modelo de datos grafo**, **módulos desacoplados** (metering, billing y rev rec independientes).

## 1. Entidades núcleo y relaciones

```
Organisation
├── BusinessEntity (entidades emisoras/subsidiarias; 1 default)
├── Customer ──┬── children (parent-child), Contacts, Addresses, Wallet (1 por moneda), Entitlements
│              └── tax_info[], custom_data, business_entity_id
├── Product ── ProductPricing[] (catálogo; default_pricing_id)
├── Plan (template customer-agnostic, versionado) ── PlanPhase[] ── PlanPhasePricing[]
├── Contract (contract_v2) ── ContractPhase[] ── ContractPhasePricing[] ── (product_id, pricing_id)
│              └── amendments (audit), current_phase
├── RawMetric (stream de eventos, dataschema) ── UsageEvent[] ── Aggregate (billable metric)
├── Invoice ── InvoiceLineItem[] ── CreditNote[] ── Payment (payment_parts[] N:M invoice)
└── RevRec: Rule → POB → RevenueSchedule → JournalEntry → Account (CoA) → AccountingPeriod
```

**Cardinalidades clave**: Customer 1:N Contract · Contract 1:N Phase (≥1 obligatoria) · Phase 1:N Pricing (cada pricing = un producto con SU modelo, fechas y anchor propios) · Product 1:N ProductPricing (el precio es entidad separada del producto) · Payment N:M Invoice vía `payment_parts[{invoice_id, amount}]` · CreditNote N:1 Invoice (o standalone con `customer_id`).

**Customer**: `customer_name` (único requerido), `external_id`, direcciones bill/ship, `tax_info[]` ({country_code, tax_code, tax_id}), `custom_data` JSON consultable por métricas, `connector` ({name, reference_id} — vínculo CRM/ERP), `auto_charge_enabled`, `business_entity_id`. Jerarquía padre-hijo con facturación al padre (`bill_parent_customer`) o a un tercero (`invoice_payer_customer_id`).

**Product**: name, `sku`, `tax_codes`, `type` (standalone|bundle), `default_pricing_id`. **El producto NO tiene precio; el precio es ProductPricing.**

**Insight**: distinción **Plan (template versionado, sin cliente)** vs **Contract (instancia)** — al importar un plan al contrato se **copia** la jerarquía y se especializa sin tocar el plan. Versionado de planes con diff explícito (`old_plan_id/new_plan_id/version_number/diff`).

## 2. Modelado de pricing

**Dónde vive**: pricing = objeto propio (`POST /products/{id}/pricing`), en catálogo o creado inline en la línea del contrato. **Override por contrato = pricing ad-hoc copiado a la línea**, no un campo override sobre el catálogo.

**15 `pricing_type`** (unión discriminada en `pricing_data`): `flat_fee`, `per_unit`, `percent`, `tiered` (graduated), `volume`, `step`, `package`, `matrix`, `custom_tiered`, `two_dimensional_tiered`, `tiered_with_flat_fee`, `volume_with_flat_fee`, `features`, `custom_pricing` (fórmula/script), `bundle`. Tiers como **arrays paralelos**:

```json
{"pricing_type":"tiered","currency":"USD","unit":"unit","pricing_period":{"cadence":"monthly"},
 "unit_amount":[5.00,4.00,3.00],"up_to":[100,500,null],"flat_fee":[0,0,0]}

{"pricing_type":"package","unit_amount":500.00,"package_size":100,"proration_type":"day_based"}

{"pricing_type":"matrix","dimensions":[{"name":"users"},{"name":"storage"}],
 "prices":[[10,20,30],[15,25,35]],"display_alias":["Small","Medium","Large"]}

{"pricing_type":"custom_tiered","unit_amount":[5,4,3],"up_to":[100,500,1000],
 "tier_type":["per_unit","package"],"flat_fee":[0,50,100],"package_sizes":[1,10,50]}
```

**Sub-objetos componibles del pricing** (todos con `id`, `priority`, `label`):

- **Discount**: `type: fixed|percent|quantity`.
- **Commitment** (mínimos y caps): `type: minimum_spend|maximum_spend`, `charge_full_amount`, `skip_zero_amount` — el mínimo/true-up y el techo son features componibles, NO modelos aparte.
- **FreeUnit** (incluidas por período) · **Grant** (créditos prepagados con `trigger_event: payment_success|invoice_creation|invoice_approval` y expiración configurable) · **Consumption**.
- **Taxes**: `manual|avalara`, `is_compound`.
- **PaymentTerms**: `on_approval|on_creation`, `due_days`, `relative|absolute`, `last_day_of_month` — **el término de pago vive en el pricing/contrato y deriva el due_date** (= nuestro pendiente término→días).
- **Quantity**: `type: metered|fixed`, `aggregate_id` (métrica), **`quantity_entries[] {value, effective_from}`** — historial de cantidades con vigencia (= nuestros overrides por período, resuelto como lista temporal).
- `billing_period {cadence: monthly|quarterly|yearly, offset: prepaid|postpaid}` **POR LÍNEA** (un contrato mezcla flat prepaid + usage postpaid).
- `overage_pricing` = un pricing completo anidado para excedentes.
- Cualquier `unit_amount` acepta número o `EdgeInput {step_name, output_field}` — referencia a un paso previo del grafo de cálculo (`execution_logic`).

**Patrón documentado "prepaid commitment + postpaid overage"**: 3 líneas — flat_fee prepaid (commitment) + per_unit postpaid con free_units = commitment + fee anual. Unidades no usadas: crédito futuro, sin refund, expiran.

## 3. Contratos y modificaciones (CRÍTICO para nosotros)

**Contract** (`POST /contract_v2`): `status: draft|active|paused|expired|disputed`, `currency` (UNA por contrato), `start/end_date` (null = indefinido), `anchor_date` (referencia del ciclo), `is_last_day_of_month`, `plan_id`, `phases[]` (≥1), `renewal_policy`, `contract_link`, `bill_parent_customer`, `invoice_payer_customer_id`.

- **Fases = mecanismo universal de cambio temporal**: trials, ramps, **amendments mid-term y PAUSA se modelan como fases** (`phase_type: active|trial|pause`). Cada línea tiene `start/end/anchor` propios + **`is_enabled: [{value, effective_from}]`** — activación/desactivación de una línea como lista de vigencias, no booleano (= nuestro problema is_active, resuelto).
- **Amendment**: no hay objeto de escritura; se edita el contrato (PUT full-replace) o se agregan fases/pricings. `GET /amendments` = audit trail de solo lectura. ⚠️ Sin preview del impacto antes de persistir.
- **Pausa**: `POST /pause {start_date, end_date?, unpause_extension_policy}` → fase `pause` + política de extensión del fin de contrato al reanudar (= caso BAM-01/Carelis, modelado limpio).
- **Renovación**: 3 políticas (no renovar / mismos términos / reset a plan padre); jerarquía contrato → organización. Job cada 25 h.
- **Prorrateo**: en el pricing (`proration_type: day_based`, `charge_full_amount`), cada línea decide.
- **Impacto en facturas**: regla dura — **Draft editable/regenerable ilimitado ("REGENERATE INVOICE"); Approved/Paid NUNCA se editan: toda corrección vía credit note**. El amendment afecta futuras + dispara redistribución de revenue; lo aprobado se corrige con NC. (= nuestra "ancla de emitidas", elevada a principio.)

## 4. Usage / metering

3 capas: **RawMetric** (stream con `dataschema` flexible y `api_slug`) → **UsageEvent** (`POST /usage/{slug}` {customer_id, timestamp, data{...}}; acepta granular o pre-agregado) → **Aggregate** (billable metric: SQL o visual builder; SUM/COUNT/MAX/MIN/UNIQUE COUNT; `cust_agg_query` por cliente).

- **Idempotencia**: header `Idempotency-Key` (UUID v4, TTL 24 h, solo usage APIs).
- **Ingesta**: "aggregator, not source" — conectores en 2 modos: query-in-place (>30 GB) o sync a Zenskar (<30 GB); CSV, S3, manual.
- **Corrección de historia**: sin borrado — eventos negativos, flags de deducción, o re-envío del mismo `data.Id` con dedup por ROW_NUMBER en el SQL. ⚠️ No prometen recálculo automático de facturas ya generadas.

## 5. Motor de facturación

- Generación automática al cierre del ciclo **derivada por línea** (cadence+offset+anchor), no hay "billing run" configurable. Manual: `generate_invoice {customer_id, contract_id, from/to_date, check_duplicate_invoice}` (guard de duplicados por período explícito).
- Ciclo: `Draft → Approved → Partially Paid → Paid` + `Void`/`Deleted` (solo drafts). **Approval = frontera de inmutabilidad** y trigger de rev-rec/payment terms.
- Fecha de factura: config a nivel ORGANIZACIÓN (reference date + offset ± meses + day pinning) — ⚠️ rígido para enterprise por contrato.
- **Credit notes**: `amount, currency, customer_id, status (in_progress|issued|void|paid)`, **`repayment_method: credits|invoice_adjusted|external_payment|credits_against_payment|original_payment_method`** (enum de primera clase — diseño superior a "NC = factura negativa"), `refund_destination`, `refund_amount_split[]`. NC total → factura Void; parcial no cambia estado.
- **Payments**: `payment_method` (13 valores), `type: payment|refund|payment_reversal|authorization|tax_withheld`, `status` (12 valores), **`payment_parts[]` N:M pago↔facturas**, `connector_id`. Pagos manuales editables + refund.

## 6. Revenue recognition (ASC 606 / IFRS 15)

- **Reglas** con matching por atributos (Product, Pricing model, Contract item name, Business entity...) → **POB** (performance obligation; varios productos pueden agruparse).
- **Satisfaction**: Point in Time vs Over Time con **7 métodos**: equally by days · by month · configurable days · usage based · entitlement based · aggregate based · equally-by-months-with-estimated-price (+ true-up).
- **Políticas por POB**: `Immediate` / `Deferred` / `Unbilled` (= def/unb de nuestro RSM).
- **Redistribución** (por amendments, fechas, true-ups, FX, redondeo): SOLO sobre períodos abiertos, con `Straight line | Front-loaded | Back-loaded`; ajuste >5% del período → front-load obligatorio; períodos cerrados nunca se reabren (catch-up al primer abierto). Asientos definidos por caso.
- **Contabilidad**: Chart of Accounts con defaults (AR, Cash, **Unbilled Revenue**, **Deferred Revenue**, Customer Wallet, Sales Tax, Contra AR); reglas solo definen la cuenta Income (el débito lo infiere el contexto). API contable completa: journal entries CRUD, balance sheet, income statement, **accounting periods con close/validate-close/last-closed — cierre de períodos como API de primera clase**.

## 7. Diseño de API

REST plural (`/customers`, `/credit_notes`, `/aggregates`...) — excepción reveladora: **`/contract_v2`** (rediseñaron contratos en vivo; su v1 no aguantó). Multi-tenant explícito por header `organisation`. UUID + `external_id` en casi todo + `connector/source` para trazar origen. `custom_attributes` tipados + `custom_data` libre. **Jobs API** para operaciones largas (sub-jobs + outcomes auditables). Webhooks con HMAC SHA-256 (customer/invoice/contract/payment; sin eventos de NC ni rev-rec). Errores 422 estilo pydantic.

## 8. Debilidades / ventanas para Sapira

1. **Multi-entidad emisora superficial**: BusinessEntity existe pero sin numeración por entidad, plantillas por entidad ni consolidación inter-compañía; customer pertenece a UNA entidad.
2. **Multi-moneda débil, indexación inexistente**: moneda fija por contrato; cero doc de FX, tasas, reporting consolidado; **no existe UF/unidad indexada ni spot-vs-fijo**.
3. **LATAM/impuestos**: motor pensado para sales tax US + Avalara; **sin factura electrónica fiscal (SII/DTE/CFDI/folios), sin retenciones, sin exportación/boleta**.
4. **Dunning/cobranza**: sin páginas de dunning ni aging (solo auto-charge + gateways).
5. **Import legacy limitado**: no documenta importar facturas históricas ni saldos de apertura deferred/unbilled (= nuestro mundo MRR legacy/reconciliación no está resuelto ahí).
6. **Amendments full-replace sin preview** del impacto en facturas.
7. **Sin consolidación multi-contrato** (solo indirecto vía bill_parent/invoice_payer) — nuestra unificada no tiene equivalente.
8. Config de fecha de factura organización-wide (no por contrato).
9. API rezagada vs UI (renewal_policy incompleto, schemas vacíos, idempotencia solo usage).

## 💎 Ideas de mayor valor para Sapira v2

(a) **Fases como primitiva única** de cambio temporal (trial/ramp/amendment/pausa) + `is_enabled [{value, effective_from}]` por línea · (b) **pricing componible**: `pricing_data` discriminado + features (discounts/commitments/free_units/grants/payment_terms/taxes) con `priority`, tiers como arrays con `up_to [..., null]` · (c) `billing_period {cadence, offset}` por línea · (d) `repayment_method` de NC como enum de primera clase · (e) `payment_parts` N:M · (f) frontera dura draft/approved + regenerate · (g) redistribución front/straight/back-load solo sobre períodos abiertos + cierre contable como API · (h) catálogo versionado (plan+diff) vs instancia copiada en contrato.
