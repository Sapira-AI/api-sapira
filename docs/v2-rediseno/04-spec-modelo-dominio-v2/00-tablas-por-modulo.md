# 🗄️ Spec v2 · Sección 0 — Revisión del esquema de datos, tabla por tabla

> **Para revisión de Domi** (2026-08-14). Las ~128 tablas de PROD organizadas por módulo, cada una con veredicto propuesto. Fuente: censo prod (filas vivas + columnas) + memorias de uso real + benchmarks (`03-mejoras-y-brechas.md`, decisiones A1–A12).
> Al revisar: confirma o discute el VEREDICTO de cada tabla; las notas explican el porqué.
> ⚠️ **Actualización 18-08 (plan con Leon — estrategia incremental, sin proyecto Supabase nuevo)**: este doc es la guía de los pasos 1, 2 y 4 del plan. Lectura de los veredictos bajo la nueva estrategia: **✅/🔧 → entity espejo en el paso 1** (la mejora 🔧 se aplica cuando toque su módulo) · **🔄/➕ → paso 2** (entidades nuevas/rediseñadas, cerradas por sección de spec) · **🗑️/🔀 → insumo de la sesión de limpieza del paso 4** (nada se borra de la DB viva sin esa sesión). Los módulos de este doc definen las **subcarpetas de `entities/`** en api-sapira.

## Leyenda de veredictos

| | Significado |
|---|---|
| ✅ **Mantener** | Pasa a v2 casi igual (se re-crea como entidad TypeORM, mismo concepto) |
| 🔧 **Mejorar** | Mismo concepto, con ajustes puntuales (columnas, constraints, naming) |
| 🔄 **Rediseñar** | El concepto sobrevive pero con forma nueva (según decisión A# del doc 03) |
| 🔀 **Absorber → X** | Desaparece como tabla; su rol lo cumple otra entidad de v2 |
| 🗑️ **No migrar** | Obsoleta, debug o herramienta puntual — no existe en v2 |
| ➕ **Nueva** | No existe hoy; nace en v2 |

**Señal de bloat que justifica el rediseño** (columnas por tabla en prod): `invoices` **60**, `revenue_schedule_monthly` **57**, `contracts` **52**, `mrr_legacy` 45, `contract_items` **40**, `invoice_items` 35, `quote_items` 33 — las tablas núcleo mezclan identidad + estado + FX + fiscal + auditoría en una sola fila. v2 separa esos planos.

**Resumen**: 128 tablas hoy → ✅ 34 · 🔧 26 · 🔄 14 · 🔀 22 · 🗑️ 17 · vistas 2 (revisar) · ➕ ~25 nuevas. El detalle:

---

## 1 · Base / Tenancy (las que pediste conservar — se conservan)

| Tabla | Filas | Veredicto | Nota |
|---|---|---|---|
| `users` | 28 | 🔧 | Conservar. Limpiar la familia de funciones `_safe/_robust/_direct`; vínculo auth = Supabase Auth del proyecto nuevo (re-invitación de 28 usuarios es trivial) |
| `roles` / `permissions` / `role_permissions` | 70/22/638 | ✅ | Roles dinámicos + permisos por código funcionan bien. Solo naming consistente |
| `user_holdings` | 38 | 🔧 | → `tenant_members` (usuario×tenant×rol). Multi-tenancy se aplica en la API (header/claim) + RLS de respaldo |
| `company_holdings` | 7 | 🔧 | **El tenant raíz. Decisión de naming: ¿`holdings` o `tenants`?** (propongo `tenants`; "holding" queda como concepto de negocio en UI) |
| `companies` | 22 | 🔄 | Las emisoras. Propuesta (A1): emisor y receptor comparten forma → `billing_profiles` (RUT, razón social, giro, país, moneda, tratamiento fiscal) con flag/relación de "emisora del tenant". Cuentas bancarias y mapeo contable colgando del profile |
| `master_data` | 263 | 🔧 | Conservar el patrón genérico tipado (industrias, mercados, segmentos, tipos de contacto/ítem/negocio, términos de pago, unidades). ⚠️ Términos de pago DEJAN de ser solo texto: pasan a `payment_terms` estructurado (A3) |
| `currencies` | 10 | 🔧 | + flag `is_indexed_unit` (CLF/UF, UVA…) con moneda de liquidación — la indexación de primera clase |
| `financial_settings` / `holding_settings` | 4/4 | 🔧 | Fusionar en `tenant_settings` tipado (hoy son 2 bolsas) |
| `custom_field_definitions` | 16 | ✅ | Patrón probado (definiciones tipadas + valores JSON) |
| `user_view_preferences` | 8 | ✅ | Vistas guardadas — se conserva |
| `claude_skills` | 2 | 🗑️ | Experimento; no migra |

## 2 · FX y datos económicos

| Tabla | Filas | Veredicto | Nota |
|---|---|---|---|
| `exchange_rates` + `exchange_rates_monthly_avg` | 8.457/445 | ✅ | Fuente Banco Central/Perú API — se conserva (la alimenta api-sapira) |
| `holding_fx_period_rates` / `contract_fx_period_rates` | 71/1 | 🔄 | → `fx_rates` unificada con **`source` como escalera persistida** (A3/Relvo: `contract_rate → manual_override → official → derived…`) y scope (tenant/contrato/documento/línea) |
| `indicadores_economicos` / `fx_api_sync_log` | 42/3 | ✅ | Operativas |
| `generic_export_vats` | 8 | 🔀 | → matriz fiscal (`fiscal_document_types`, módulo 8) |

## 3 · Clientes

| Tabla | Filas | Veredicto | Nota |
|---|---|---|---|
| `clients` | 1.777 | 🔄 | → **`parties`** (A1): cliente comercial puro (nombre, dimensiones de segmentación, dueño) |
| `client_entities` | 1.508 | 🔄 | → **`billing_profiles`** (razón social: RUT normalizado, giro, país, moneda). Misma entidad que emisoras (módulo 1) |
| `client_entity_clients` | 1.524 | 🔄 | → **`party_billing_links`**: el vínculo operativo — contactos por ROL, clasificación fiscal (document family), tax_status, términos de pago, medio de cobro, estado. Aquí muere el problema términos/tax/export de raíz |
| `client_contacts` | 226 | 🔧 | → `contacts` con `roles[]` (billing, cobranza, OC, xml) — hoy el tipo vive en master_data y no gobierna nada |
| `contact_preferences` | 0 | 🔀 | → roles del contacto |
| `client_documents` / `company_legal_documents` | 8/1 | 🔧 | → `profile_documents` unificada (documentos legales de cualquier billing_profile) |
| `client_entity_tax_id_normalization_conflicts` | 65 | 🗑️ | Herramienta de migración SF/Odoo — se resuelve en el ETL, no existe en v2 |
| `company_bank_accounts` / `company_account_mappings` | 2/0 | 🔧 | Cuelgan del billing_profile emisor (cuentas bancarias + mapeo contable GL) |
| `sellers` | 37 | ✅ | Vendedores (entidad de negocio, no de acceso) |

## 4 · Cotizaciones y catálogo

| Tabla | Filas | Veredicto | Nota |
|---|---|---|---|
| `quotes` | 330 | 🔧 | Funciona bien (B1 — ventaja que nadie tiene). Ajustes: etapa/flags como hoy, `booking_date`, flag OC/HES conectado al gate real (A11) |
| `quote_items` | 387 (33 cols) | 🔧 | Fix estructural: el ítem referencia un **precio v2** (A2/A3) en vez de duplicar price/final_price calculados a mano (mata el bug "editar no recalcula") |
| `quote_stages` | 43 | ✅ | Etapas por tenant, sistema vs personalizadas |
| `quote_attachments` | 0 | ✅ | Barata y útil |
| `products` | 76 | 🔧 | → catálogo SIN precio (A2): + `sku`, `status`, `tax_code`; el precio vive en `prices` |

**➕ Nuevas (módulo pricing — la sección 1 de la spec)**: `prices` (type × model × interval × status, `list_price_id` para negociado-vs-lista), `price_tiers` (ranges from/to/unit/flat), `price_features` (discounts / **commitments-mínimos** / **caps** / free_units / payment_terms, con prioridad), `billing_metrics` (guided|sql + agregación), `quantity_entries` (cantidad con `effective_from` — reemplaza overrides frágiles).

## 5 · Contratos

| Tabla | Filas | Veredicto | Nota |
|---|---|---|---|
| `contracts` | 659 (52 cols) | 🔄 | → `contracts` v2 delgado (A4): identidad + estado + ancla de ciclo + emisor (billing_profile) + política FX/renovación + `revision`. Lo temporal se va a fases; lo negociado a versiones |
| `contract_items` | 1.067 (40 cols) | 🔄 | → **`contract_lines`** dentro de fase: referencia a price + vigencias `[{enabled, effective_from}]` + cantidad/metric. Muere el booleano is_active y la categoría trigger-calculada |
| — | — | ➕ | **`contract_versions`** (inmutables, draft→published→superseded, con nota y aprobación) + **`contract_phases`** (`type: active|trial|pause`, `activation: time_window|milestone`) + **`contract_changes`** (delta con preview aplicado) — el corazón de A4 |
| `contract_amendments` + `_items` | 53/32 | 🔀 | La historia migra como versiones; la RPC-familia upsell/downsell/churn se vuelve `changes` tipados |
| `contract_lifecycle_events` | 154 (24 cols) | 🔧 | → `events` unificado tipado (ver módulo 10) — se conserva el concepto, una sola tabla de eventos de dominio |
| `contract_change_log` / `contract_item_change_log` | 879/1.111 | 🔀 | → `events` (audit = eventos, no N tablas espejo) |
| `contract_workflow_history` / `workflow_steps` / `workflow_step_documents` | 1.001/17/0 | 🔄 | El workflow de aprobación se re-implementa como **aprobación de versiones** (patrón Alguna: pending_approval → aprobadores) — más simple y pegado al cambio real |
| `contract_clauses` / `contract_templates` / `contract_documents` | 18/0/2 | ✅ | Plantillas y documentos — igual |
| `contract_notifications` | 13 | 🔀 | → notificaciones unificadas (módulo 11) |
| `contract_billing_splits` | 0 | 🔀 | → **`invoice_routes`** (A5) |
| `contract_invoices` (junction) | 4.891 | 🗑️ | Redundante: la factura referencia contrato/route directamente |
| `churn_reasons` | 15 | ✅ | Catálogo por tenant |

**➕ Nuevas**: `invoice_routes` + `routed_invoices` (receptor, moneda, líneas visibles, split por peso, OC exigida — A5).

## 6 · Facturación

| Tabla | Filas | Veredicto | Nota |
|---|---|---|---|
| `invoices` | 8.631 (**60 cols**) | 🔄 | → `documents` con **ejes de estado independientes** (lifecycle ⊥ payment ⊥ fiscal ⊥ delivery ⊥ totals), `role` (por qué existe), snapshot de emisión congelado, `operational_batch`. Cubre factura, NC y ND con `document_type` |
| `invoice_items` | 10.211 (35 cols) | 🔄 | → **`document_lines`** compartidas (A6): `amount_basis unit_rate|exact_total`, `source billing_engine|manual`, período de servicio, FX por línea, contract_line_id |
| `invoice_payments` | 80 | 🔄 | → `payments` + **`payment_parts`** N:M (A8) — habilita aplicación parcial multi-documento |
| `invoice_references` | 187 | 🔧 | → `commercial_references` (A11): kinds TpoDocRef SII + OC/HES, en documento Y en contrato |
| `billing_references` / `reference_requests` / `invoice_reference_links` | 0/0/0 | 🔀 | Construidas sin conectar → las absorbe `commercial_references` + reglas de bloqueo (`requires_po/hes` → `issuance_blocked_reason`) |
| `quantities` | 191 | 🔄 | → `quantity_entries` con vigencia (módulo 4) — mata el CHECK>0 y los triggers de restore |
| `invoice_restructure_log` | 246 | 🔀 | → `events` |
| `invoice_reschedules` | 0 | 🗑️ | Nunca usada; la historia va a `events` |
| `invoice_adjustments` | 0 | 🔀 | El ajuste-a-lo-emitido queda como operación (evento + regenerar detalle) sobre `documents` |
| `invoice_emails` / `invoice_collection_settings` / `invoice_collection_logs` | 0/1/0 | 🔄 | → módulo comunicaciones/cobranza (11): mensajes por intención + workflow dunning |
| `invoice_trigger_debug_logs` / `overdue_check_log` / `period_guard_warnings` | 0/60/0 | 🗑️ | Debug/monitoreo de la arquitectura vieja |
| Vistas `invoices_with_net_amounts` / `invoice_items_consolidated` | — | 🗑️ | Reemplazadas por columnas/queries del modelo nuevo |

**➕ Nuevas**: `document_versions` (snapshots inmutables por emisión/edición), `document_events` (log tipado: issue, apply_cn, void, payment, chargeback… — fuente del sistema de notificaciones P1 #6), `fiscal_document_types` (matriz por país × emisor × tratamiento del receptor → 33/34/39/110/61/56 — resuelve P2 #9 y exportación de raíz).

## 7 · Revenue / períodos

| Tabla | Filas | Veredicto | Nota |
|---|---|---|---|
| `revenue_schedule_monthly` | 18.139 (57 cols) | 🔧 | El RSM se CONSERVA (es la joya) con mejoras A9: referencia a método de reconocimiento del catálogo, redistribución front/straight/back solo en períodos abiertos, **invariante de balance triple con flag `unbalanced`** (adiós barridos manuales). Evaluar partir las 57 columnas en (schedule) + (montos por moneda) |
| `revenue_rules` | 0 | 🔄 | Ahora de verdad: reglas con filtros (producto/modelo/entidad) → cuenta + método (Zenskar Revenue Rule Library) |
| `mrr_adjustments` | 1 | ✅ | |
| `accounting_period_cutoff` / `accounting_period_events` | 18/14 | 🔧 | Cierre por (tenant, emisora) como **API de primera clase** (close/validate/last-closed); el guard pasa de triggers a servicio + constraint |

**➕ Nuevas**: `recognition_methods` (catálogo referenciable — 7 de Zenskar/17 de Maxio como base), `journal_entries` (asientos materializados con push a ERP; hoy se generan al vuelo).

## 8 · Legacy / onboarding (módulo de PRIMERA clase en v2 — diferenciador B3)

| Tabla | Filas | Veredicto | Nota |
|---|---|---|---|
| `invoices_legacy` + `invoice_items_legacy` | 9.307/11.713 | 🔧 | Se conservan como `legacy_documents` con vínculo al modelo v2 + **saldos de apertura de deferred/unbilled** (lo que ni Maxio resuelve) |
| `invoice_items_legacy_match` | 78 | 🔧 | Matching legacy↔contrato con score (patrón conciliación) |
| `mrr_legacy` | 11.808 (45 cols) | 🔧 | Se conserva; simplificar columnas calculadas por trigger → servicio |

**➕ Nueva**: `import_batches` (todo import masivo — clientes/contratos/facturas/uso — con preview, validación y reversa; generaliza lo que hoy es ad-hoc + habilita el **mirroring** del cutover).

## 9 · Conciliación y pagos

| Tabla | Filas | Veredicto | Nota |
|---|---|---|---|
| `bank_movements` / `bank_upload_batches` / `bank_column_mappings` | 0/0/0 | ✅ | Diseño reciente y correcto — pasa a v2 tal cual (cartolas + matching por score); Fintoc se conecta aquí después |

## 10 · Integraciones (staging vive con api-sapira; en v2 → schema `integrations` separado del core)

| Grupo | Tablas (filas) | Veredicto | Nota |
|---|---|---|---|
| Salesforce | `connections`(3), `accounts/opportunities/line_items_stg`(38/47/52), `object_mappings`(1.502), `field_mappings`(42), `product_mappings`(109), `quote_type_mappings`(6), `sync_runs`(16)+`items`(85), `sync_logs`(0), `opportunities_cache`(0) | ✅/🔧 | El motor de mapeo configurable es un activo — se conserva. 🗑️ `sync_logs` y `opportunities_cache` (vacías/duplican Mongo) |
| Odoo | `connections`(3), `invoices_stg`(10.230), `invoice_lines_stg`(14.881), `partners_stg`(816), `product_mappings`(41), `object_mappings`(0) | ✅ | Igual (🗑️ object_mappings vacía) |
| Stripe | `connections`(1), `customers/invoices/subscriptions_stg`, `product_mappings`(75), `sync_jobs`(169) | ✅ | Igual |
| `stripe_customers_bigquery` | 26.351 | 🗑️/revisar | Parece dump DWH duplicado — confirmar con Leon antes de descartar |
| Otras | `bigquery_connections`(1), `field_mappings`(4), `integration_logs`(1.378), `integration_configs`(0) | 🔧 | `integration_configs` 🗑️; logs consolidar con Mongo de api-sapira |

## 11 · Automatizaciones, IA, notificaciones y correo

| Tabla | Filas | Veredicto | Nota |
|---|---|---|---|
| `ai_agents` / `ai_agent_configs` / `client_agent_configs` | 16/122/0 | 🔧 | Se conservan (proforma/cobranza/deal_validation). **Unificar con la familia paralela vacía** ↓ |
| `agents` / `agent_logs` / `ai_runs` / `ai_messages` | 0/0/0/0 | 🔀 | Dos familias de tablas de agentes conviven; v2 deja UNA: `agents` + `agent_runs` + `agent_messages` |
| `rag_documents` | 0 | ✅ | Copilot RAG (pendiente ingesta — no es problema de schema) |
| `app_notifications` + `recipients` + `notification_role_subscriptions` | 3/14/18 | 🔧 | Base del P1 #6; en v2 se alimentan de `document_events`/`events` (una sola fuente de verdad de "qué pasó") |
| `email_sender_addresses` / `holding_email_sender_settings` | 0/0 | 🔧 | Config Resend por tenant (dominios verificados) — conectar de verdad |

**➕ Nueva**: `messages` (correo saliente/entrante por intención — proforma, factura, recordatorio — con conversación por documento; hoy no se registra nada).

## 12 · Suscripciones (Stripe)

| Tabla | Filas | Veredicto | Nota |
|---|---|---|---|
| `subscriptions` + `subscription_items` | 433/455 | 🔄 **decisión E2** | Propuesta: en v2 son **contratos con `source: stripe`** (un solo modelo, como decidimos vs Maxio) — el RSM ya los trata igual. Alternativa: mantener tabla aparte. A discutir contigo |

## 13 · Emisión fiscal nativa (carril Leon)

| Tabla | Filas | Veredicto | Nota |
|---|---|---|---|
| `sii_configurations` / `sii_certificates` / `sii_cafs` | 0/0/0 | ✅ | El terreno sembrado pasa a v2 como módulo fiscal de primera clase, conectado a `documents.fiscal_status` (eje fiscal del A6) |

---

## Decisiones que esta sección deja abiertas para ti (revisarlas ENTRE el paso 1 y el paso 2 — nada de esto bloquea el espejo de entities)

> **Nota 18-08**: bajo el plan incremental, los puntos 1 y 4 (naming `tenants`, schemas de Postgres) son detalle innecesario por ahora — se descartan hasta que un paso los exija. Los relevantes para tu revisión: **2, 3, 5 y 6**.

1. **Naming del tenant**: `tenants` (propuesto) vs mantener `holdings`.
2. **Emisor y receptor comparten `billing_profiles`** (propuesto, estilo Relvo) vs mantener `companies` separada de razones sociales de clientes.
3. **Suscripciones Stripe = contratos con source** (propuesto) vs tabla aparte (módulo 12).
4. **Schemas de Postgres por módulo** (`core`, `billing`, `revenue`, `integrations`, `legacy`) vs todo en `public` (propuesto: schemas separados — orden y permisos más claros).
5. Confirmar los 🗑️ (17 tablas) — en especial `stripe_customers_bigquery` (validar con Leon) y `contract_invoices`.
6. El RSM de 57 columnas: ¿partirlo en schedule + montos-por-moneda, o conservar ancho por performance de reportes? (propongo medir en el corte 1).
