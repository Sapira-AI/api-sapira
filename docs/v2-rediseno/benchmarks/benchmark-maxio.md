# 📙 Benchmark — Maxio (Advanced Billing ex-Chargify + Core ex-SaaSOptics), 2026-08-21

> Fuentes: SDK oficial TypeScript (636 modelos, clonado y leído — el portal es SPA no fetcheable), ~35 artículos del help center vía API Zendesk, JSON schemas del tap Singer de SaaSOptics. Nombres de campos exactos (snake_case de la API).
> **Contexto clave**: el schema actual de Sapira nació inspirado en el USO de Maxio — este informe muestra qué se replicó, qué faltó y qué no imitar.

## 0. El hallazgo que explica nuestro schema: Maxio son DOS sistemas

1. **Advanced Billing (AB, ex Chargify)** — motor de suscripciones. Subscription-céntrico: Site → Product Family → Product/Component/Coupon + Price Points → Customer → Subscription → Invoice/CN/Payment/Usage.
2. **Maxio Core (ex SaaSOptics)** — financial ops y rev-rec. Contract-céntrico: Customer → **Contract** → **Transaction** (línea) → **Revenue Entry** (fila de devengo) + Register (libro por moneda) + Item (catálogo financiero con cuentas GL).

Integración por **sincronización de facturas** (AB→Core crea contracts/transactions desde invoice lines; Term Subscriptions crean draft invoices futuras en Core). **Sapira = la fusión de ambos lados en un solo modelo** — lo que Maxio hace con dos productos cosidos (su mayor fuente de complejidad: out-of-balance, conceptos duplicados). Nuestra decisión de modelo único es correcta; lo que faltó fue copiar las mejores piezas del lado AB.

## 1. Lo que Sapira replicó del lado Core (y está bien)

- `contracts → contract_items` ≈ Contract → **Transactions** (con `local_amount/home_amount` + `local_rate/home_rate` = nuestra dualidad contract_ccy/system_ccy).
- RSM ≈ **revenue_entries** `{transaction, start_date, end_date, local_amount, home_amount}`.
- Cierre de períodos ≈ **Close/Lock Dates** (bloquean revenue e invoicing en cerrados).
- **Regla de balance triple** (invariante de sistema): `Σ Transactions = Σ Invoice Lines = Σ Revenue Entries` por transaction/contract/customer; si no cuadra → flag **`unbalanced_revenue_exception`** + cola de revisión. 💡 Nuestros barridos manuales qty×unit×desc=subtotal, formalizados como constraint/estado — adoptar en v2.
- **17 métodos de reconocimiento** como catálogo (Daily, Evenly±prorrateo parcial al primero/último, All on Start/End/Order Date, XX days, Daily with catch-up…).
- Transaction trae además: renewal*\* completo (probabilidad, factor, perfil auto-renewal), sf_opportunity_line_item_id (trazabilidad CRM a nivel línea), tombstones `deleted*\*` para sync incremental.

## 2. Lo que FALTÓ copiar del lado AB (directamente aprovechable en v2)

1. **Price Points versionados**: el precio NUNCA vive en el producto/componente — vive en el Price Point con `type: default | catalog | custom` (custom = negociado, ligado a UNA suscripción). Resuelve precio-lista vs precio-negociado sin ensuciar catálogo. `custom_price` con **`list_price_point_id`** para reportear descuento efectivo (= nuestro feedback "precio y descuento explícitos").
2. **5 tipos de componente**: `metered` (resetea/vencido) · `quantity_based` recurrente (persistente/anticipado) · `quantity one-time` · `on_off` · **`prepaid_usage`** (bloques con overage_prices, renovación, rollover con expiración, consumo FIFO) · event_based con segmentación (hasta 10 propiedades, precio por segmento).
3. **4 esquemas de precio** con semántica exacta: `per_unit`, `tiered` (graduado), `volume` (tramo alcanzado a todo), `stairstep` (precio fijo por rango). Brackets `{starting_quantity, ending_quantity|null, unit_price}` sin solapes ni huecos, 8 decimales.
4. **Prorrateo CONFIGURABLE en 3 niveles** (site → component → allocation): upgrade full|prorated|none, downgrade credit full|prorated|**none**, accrual inmediato|a-la-renovación — con **`/allocations/preview.json`**. Nada de lógica fija.
5. **Previews de primera clase en TODO lo que cobra**: subscriptions/migrations/allocations/renewals/proforma preview (= nuestra "iteración 2 preview-antes-de-persistir", como patrón de API).
6. **`invoice.role`**: cada factura declara POR QUÉ existe (`signup|renewal|usage|reactivation|proration|migration|adhoc|backport…`) + **event log tipado por documento** (`invoice_events`: issue, apply_credit_note, void, remove_payment, chargeback…).
7. **IDs espejo** `li_…`/`cnli_…` entre línea de factura y línea de NC — trazabilidad perfecta. 5 subtipos de CN documentados (migration, downgrade, void, refund, general).
8. **Calendar billing como atributo**: `snap_day 1..28|end` + reglas de primer cobro (prorated|immediate|delayed); **Multifrequency** (componente con ciclo propio distinto del plan). `collection_method: automatic|remittance|prepaid` + `net_terms`.
9. **Consolidación parent/child**: subscription groups → factura `parent` sin líneas propias que agrega `child` segments (≈ nuestra unificada, con la misma regla de header derivado).
10. Estados de suscripción ricos: `past_due`, `soft_failure`, `unpaid` (sigue devengando), **`on_hold`** (pausa nativa sin crédito), `expired` vs `canceled`; **Scheduled Renewals** (borrador de renovación editable con lock-in programado: Draft→Scheduled→Pending→activo).
11. Multi-moneda: `use_site_exchange_rate` (rate fijo custom o flotante cacheado) vs **Definitive Pricing** (`currency_prices[]` explícito por moneda); Term Subscriptions EXIGEN definitive (= el principio de nuestro FX fijo).
12. Dunning por site O por producto/familia, con delay nocturno, final action unpaid|canceled, "collections status" post-cancelación.

## 3. Qué NO imitar / debilidades de Maxio

1. **La costura de dos sistemas** sincronizados por facturas (out-of-balance, Customer/Invoice duplicados) — v2 mantiene modelo único.
2. **Site mono-emisor**: un seller fijo, una numeración, una moneda primaria por site; multi-razón-social = N sites aislados. Los Registers de Core son libros, no emisores fiscales. **Nuestro multi-holding/multi-emisor no existe allá.**
3. **Cero LATAM**: sin DTE/folios/SII/SUNAT, impuestos vía Avalara, sin exportación por receptor, sin retenciones. **Sin UF/indexación** (solo ISO 4217).
4. **Sin quote/CPQ** en ninguna de las dos plataformas (Offers = paquetes de signup; sales_orders de Core procesan oportunidades del CRM).
5. **Import legacy débil y reconocido**: CSV solo crea suscripciones (~100/lote, estado Active|Canceled), historial vía `/override.json` + flags; facturas retro una a una (`role: backport`). La migración financiera histórica es manual en Core. (= el mundo onboarding/legacy que Sapira SÍ resolvió es diferenciador real.)
6. "Piso fijo + tramos" no cabe en un componente — mismo workaround de 2+ componentes que nosotros.
7. No se puede cambiar la moneda de una suscripción viva; migraciones no aceptan custom price.
8. Idempotencia débil (sin `Idempotency-Key` estándar; uniqueness token configurable + dedupe de webhooks por id).

## 4. Diseño de API (notas útiles)

Basic auth (API key como username) · `.json` en todo · envelopes singulares · **acciones como sub-recursos POST** (`/hold`, `/resume`, `/void`, `/reopen`, `/retry`) · id numérico + **`handle`** (slug estable del merchant) aceptados indistintamente · `uid` prefijado por tipo (`inv_`, `cn_`, `li_`) · `include[]=` para embebidos · exports asíncronos por batch · webhooks con id estable para dedupe + replay · ~45 event keys.

## 💎 Síntesis para Sapira v2

Adoptar: price points default|catalog|custom + list_price reference · prorrateo configurable por nivel · invoice.role + event log tipado · IDs espejo factura↔NC · previews first-class · snap_day/calendar billing · balance triple como invariante con flag · catálogo de métodos de reconocimiento · tombstones para sync. Evitar: dos modelos cosidos, mono-emisor, idempotencia débil. Confirmado: quote-to-contract, multi-emisor LATAM, UF y legacy/onboarding son ventajas estructurales nuestras que NINGÚN benchmark cubre.

Material fuente completo en el scratchpad de la sesión (`ab-typescript-sdk/doc/models/` 636 modelos + `tap-saasoptics/schemas/`).
