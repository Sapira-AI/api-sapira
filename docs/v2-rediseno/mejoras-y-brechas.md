# 🧭 Síntesis: mejoras, brechas y decisiones para el modelo v2

> **Borrador para revisión de Domi** (2026-08-21). Cruza los 5 benchmarks + censo prod + ROADMAP + memorias de proyecto. Cada punto indica de qué benchmark viene la idea y qué dolor actual mata.
> ⚠️ **Actualización 21-08**: la estrategia definitiva acordada con Leon es **incremental sobre la DB viva** (ver `00-plan-y-metodo.md`). Las decisiones A1–A12 siguen vigentes pero se aplican por etapas (paso 2 = entidades nuevas, paso 4 = limpieza de funciones/triggers). Las menciones a "proyecto Supabase nuevo", "ETL v1→v2" y "cutover por holding" en las secciones D/E quedan **obsoletas** — no hay proyecto nuevo ni cutover de datos; hay evolución del schema actual + switch de front.

## ⭐ Principio transversal (Domi, 21-08): IA como capa de usabilidad

El sistema puede ser complejo por dentro (funciones, casuísticas), pero debe ser **muy sencillo de usar**. Hoy los usuarios se quejan de la complejidad, se equivocan al registrar datos y perciben esos errores como fallas del sistema — y terminan dependiendo de soporte. Por eso, TODO diseño de v2 (modelo, API y front) cumple:

1. **Guiar antes que bloquear**: previews antes de persistir, bloqueos explicativos con el paso siguiente (regla ya vigente de la casa), asistentes paso a paso en los flujos complejos.
2. **IA operativa dentro del flujo**: ejecutar solicitudes en lenguaje natural y sugerir la corrección cuando un dato es inconsistente — base ya existente: copilot RAG + agentes con aprobación humana + patrón "Action Agent" visto en Zenskar/Relvo.
3. **Avisos proactivos**: alertas, avisos, pendientes y resúmenes nacen del **event log tipado** (una sola fuente de "qué pasó / qué falta") que alimenta notificaciones, agentes y copilot.
4. **Autoatención del error de usuario**: el sistema identifica el error (dato mal registrado, paso omitido, orden incorrecto), lo explica en simple y ofrece la reparación en un clic — el usuario se auto-atiende sin escalar a soporte.

Este principio pesa igual que cualquier decisión estructural: **cada sección de la spec debe decir cómo lo cumple**. La capa que lo materializa (agentes de alerta/guía, catálogo de acciones, agente conversacional, agentes configurables por el usuario) está diseñada en `04-spec-modelo-dominio-v2/agentes-ia-funcionalidad-agentica.md`.

## ⭐ Principio transversal 2 (Domi, 22-08): flexibilidad con trazabilidad

Sapira nació muy estricto y eso quitó adopción. El usuario puede hacer lo que el negocio necesita (facturar distinto a lo planificado, mezclar monedas y métodos de FX por línea, repartir la facturación entre razones sociales, modificar contratos de forma simple) y el sistema registra qué/quién/por qué y recalcula lo derivado; solo bloquean los invariantes fiscales y contables. Detalle, casos HOY → DELTA e invariantes en `05-flexibilidad-con-trazabilidad.md`. Las decisiones A.3, A.4, A.5, A.6 y A.9 de abajo son su implementación.

## A. Decisiones estructurales propuestas para el modelo v2

> **Método (corrección Domi 21-08)**: cada decisión se presenta como **HOY** (diseño actual verificado en repo + prod) → **DELTA** (la mejora que sale del benchmark). Nada se propone "de cero" si ya existe. A.1 está reescrita en este formato; las demás se llevarán a este formato al abrir su sección de spec.

1. **Clientes: enriquecer el modelo de 3 niveles que YA tenemos.**
   **HOY** (prod + `docs/clientes/implementacion_junction_table_clientes.md`): `clients` (cliente comercial: segmentación, custom fields, SF/Stripe ids) ←→ `client_entity_clients` (junction M:N con `is_primary`, ene-2026) ←→ `client_entities` (razón social: RUT, giro `economic_activity`, posición fiscal Odoo); `client_contacts` cuelga del CLIENTE con un `contact_type` único; `companies` (emisoras) es una segunda forma de razón social aparte, con `tax_rate` plano único y prefijos. **La estructura de 3 niveles es correcta y SE MANTIENE** — es esencialmente el Party/BillingProfile/Link de Relvo, o sea el benchmark valida nuestro diseño.
   **DELTA** (lo que Relvo tiene sobre esa misma estructura y nosotros no): (a) nuestro vínculo M:N es un junction VACÍO → se enriquece con el payload operativo: términos de pago, clasificación fiscal (document family 33/34/39/exportación), tax_status, medio de cobro, moneda default; (b) contactos con `roles[]` (billing/cobranza/OC/xml) en vez de tipo único, y asociables al vínculo — hoy los agentes filtran por tipo pero no distinguen razón social; (c) unificar la FORMA de razón social entre `client_entities` y `companies` (emisora = misma forma + campos propios de emisor: prefijos, cuentas bancarias, logo); (d) eliminar la columna legacy `client_entities.client_id` y su trigger de sincronización; (e) jerarquía padre-hijo con roll-up billing _(Maxio/Alguna — hoy no existe)_.
   **Mata**: tax_rate plano/corrupto, detección de exportación, términos de pago por razón social (P2 #12), contactos de proforma/cobranza sin gobernanza.

2. **Catálogo sin precio + Precios versionados**: Product (sin precio) → Price con `status draft|active|archived` y `type default|catalog|custom` _(Maxio price points + Relvo + Zenskar)_; el precio negociado referencia el de lista (`list_price_id`) para descuento efectivo explícito _(feedback "precio y descuento explícitos")_. **Mata**: discount_pct hardcodeado, precio efectivo colapsado, productos sin gestión.

3. **Motor de pricing como unión de los benchmarks** (entidad `pricing` discriminada + features componibles):
    - Modelos: `standard | graduated | volume | package | percentage (con min/max por transacción) | graduated_percentage | matrix | seat` — vocabulario común Relvo/Zenskar/Maxio. Tramos como `ranges[{from, to|null, per_unit_amount, flat_amount}]`.
    - **Cantidad del precio: `fixed | metered`** — un precio variable declara a qué **billable metric** apunta (Zenskar: `quantity {type: metered|fixed, aggregate_id}`; Relvo: `Price.type fixed|usage|seat` con métrica ligada, `price_filters` en el vínculo contrato-precio y `SeatMetric` por contrato con `quantity_strategy`). El **consumo** es el valor de esa métrica resuelto por período. Por eso billable metric y consumo se diseñan DENTRO de esta sección Pricing, no como módulo aparte (ver glosario).
    - Features componibles por precio: `discounts` (usage/amount/%), **`commitments` (mínimo con true-up)**, **`caps` (máximo/clawback)**, `free_units`, `payment_terms` (deriva due_date), `amount_selectors (min|max entre precios)` _(Relvo)_.
    - `billing {cadence, offset anticipado|vencido}` **POR LÍNEA**, no por contrato _(Zenskar)_; componente con ciclo propio _(Maxio multifrequency)_.
    - **UF/CLF nativa** + FX con **escalera de precedencia persistida** (`same_currency → contract_rate → manual_override → official → derived…`) _(Relvo — y nosotros ya operamos así implícitamente)_.
    - **Mata**: workaround N-ítems-por-tramo (ValdiShopper/Turboboy), ajuste manual mensual, y da la tabla SimpliRoute en UF de una vez. Es el P1 nuevo de pricing y la sección 1 de la spec.

4. **Contrato phase-first con cambios versionados y PREVIEW**: fases como primitiva única de cambio temporal (trial/ramp/amendment/**pausa** `phase_type`) _(Zenskar)_ + `activation_kind time_window|milestone` _(Relvo — fases por hito)_ + líneas con vigencias `is_enabled [{value, effective_from}]` en vez de booleanos + **Changes API delta con `preview` antes de aplicar y prorrateo por comportamiento elegible (full|none|credit_only|charge_only)** _(Alguna — el mejor patrón de amendments)_ + `revision_number` con locking optimista y `amended_from` _(Relvo)_. **Mata**: TODO el grupo P1 #5 (modificaciones), los bugs de amendments/períodos solapados, "editar ítems" vs "modificar" (la política TiMining queda modelada), la pausa/reactivación (P1 #7) y la preview-antes-de-persistir.

5. **`invoice_route` declarado EN el contrato** _(Relvo — hallazgo estructural nº 2)_: qué precios van a qué factura, receptor (link), moneda del documento, agrupación de líneas visibles, **split por pesos entre N facturas**, y la OC/HES que cada factura exige para ser pagable. **Mata**: unificada/consolidada/dividida como cirugías post-hoc, billing_splits sin uso, y el caso "cliente exige otro detalle en la OC" (Alicorp) se vuelve configuración.

6. **Factura con ejes de estado INDEPENDIENTES** _(Relvo)_: `lifecycle (upcoming→draft→open→void)` ⊥ `payment` ⊥ `fiscal (SII)` ⊥ `delivery` ⊥ `totals` — en vez de nuestros 8 estados mezclados. + `role` (por qué existe: renewal/proration/migration/adhoc/backport) _(Maxio)_ + `amount_basis unit_rate|exact_total` por línea _(Relvo — el input financiero irreducible)_ + **snapshots de versión inmutables + event log tipado por documento** _(Relvo/Maxio)_ + frontera dura **draft-editable / emitida-intocable con "regenerate"** _(Zenskar — nuestra "ancla de emitidas" elevada a principio)_. **Mata**: estados ambiguos, standardize trigger, edit_invoice_safe rota, auditoría dispersa en N tablas de log.

7. **NC/ND de primera clase**: `void_scope full|partial` _(Relvo)_ + **`repayment_method` enum (credits|invoice_adjusted|external|original_payment)** _(Zenskar)_ + líneas espejo `li_/cnli_` _(Maxio)_ + nuestro devengo de NC (`impact_month|defer_forward`) que NADIE tiene — se conserva y se formaliza.

8. **Pagos con `payment_parts[]` N:M** _(Zenskar/Alguna)_ + registro manual/masivo + conciliación con matching (lo nuestro) — deja lista la aplicación parcial multi-documento y la etapa Fintoc.

9. **Rev-rec: conservar el RSM y formalizarlo** _(validado: Alguna lo tiene, Relvo NO, Zenskar sí — es nuestra cancha)_: métodos de reconocimiento como CATÁLOGO (17 de Maxio / 7 de Zenskar como referencia), **redistribución solo sobre períodos abiertos con front/straight/back-load** _(Zenskar)_, **regla de balance triple como invariante con flag `unbalanced_revenue_exception`** _(Maxio — nuestros barridos manuales, automatizados)_, cierre de períodos como API de primera clase, asientos + mapeo de cuentas por razón social (ya lo tenemos). **Mata**: los rebuilds manuales como única herramienta, descuadres silenciosos, funciones RSM dev≠prod.

10. **Consumo (billable metric) en 3 capas** — nombre acordado por Domi (ver `04-spec-modelo-dominio-v2/glosario.md`): en UI "Consumo", técnico "billable metric"; reemplaza "cantidades variables / overrides por período o por cliente". Métrica de cobro como entidad (`guided | sql` _(Relvo)_, agregaciones sum/count/max/min/unique) + **cantidades con vigencias `quantity_entries [{value, effective_from}]`** _(Zenskar — nuestros overrides, bien modelados)_ + ingesta DWH-first (BigQuery ya operativo) con eventos inmutables + corrección `VOID|REPLACE` + estado de re-tarificación _(Relvo)_. **Mata**: overrides frágiles (cantidad 0, triggers), carga manual mensual, y empalma la reunión DWH David/Sabrina.

11. **OC/HES como entidad con reglas de bloqueo** _(Relvo — y nuestras tablas vacías ya existen)_: kinds del TpoDocRef SII + `requires_purchase_order/hes` por contrato/factura → `issuance_blocked_reason`. La extracción AI desde correos (Relvo la tiene) es fase 2 — nuestro agente de proformas ya trackea solicitada/recibida/rechazada.

12. **Convenciones de plataforma**: montos como string decimal en `Money {amount, currency}` (nunca float) + `Idempotency-Key` en todos los writes _(Relvo)_ · previews first-class en toda acción con efecto económico _(Maxio)_ · webhooks HMAC con id estable · tombstones `deleted_*` para sync incremental · acciones como sub-recursos POST · `external_id` + `source/connector` en todo (trazabilidad SF/Odoo/legacy).

## B. Fortalezas de Sapira que NINGÚN benchmark tiene (se conservan como base del modelo)

1. **Cotización→contrato integrado** (upsell/downsell/cross-sell/renegociación + Salesforce con motor de mapeo): ni Zenskar ni Maxio ni Alguna ni Relvo lo exponen — Alguna tiene quotes solo en dashboard.
2. **Multi-holding real** (RLS hoy; tenancy en API v2) — todos los demás: 1 token = 1 org.
3. **Legacy/onboarding con data sucia**: contratos/facturas/MRR legacy + reconciliación + forense. Maxio lo reconoce débil; Relvo lo subestima; Zenskar no lo resuelve. **En v2 es un módulo de primera clase (import + mirroring), no un apéndice.**
4. **NC con devengo y distribución** + fábrica de churn.
5. **Unificada multi-contrato** (solo Maxio tiene algo análogo parent/child) — en v2 nace declarativa vía invoice_route.
6. **UF + FX fijo/spot OPERANDO** con Banco Central integrado y reportes en moneda sistema.
7. **Cierre de períodos por (holding, compañía)** — Zenskar lo tiene global, Relvo no lo muestra.
8. **Emisión fiscal vía ERP funcionando** (Odoo action_post→DTE multi-país) + camino nativo sembrado (tablas SII).
9. Copilot RAG + agentes con aprobación humana (paridad conceptual con la narrativa Zenskar/Relvo; falta operarlos).

## C. Mapa dolor actual → solución v2 (verificación de cobertura)

| Dolor de hoy (fuente)                                                                     | Lo resuelve                                                                   |
| ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Modificaciones de contrato ↔ facturas (P1 #5, bugs Sinba/Vend, "siempre tengo problemas") | A4 (fases+versiones+preview+prorrateo elegible) + A6 (frontera draft/emitida) |
| Tramos/pricing SimpliRoute (ValdiShopper, Turboboy)                                       | A3                                                                            |
| is_active / ítems vencidos / renovación parcial                                           | A4 (vigencias por línea)                                                      |
| standardize_invoice_items pisa montos (17 funciones auditadas)                            | A6 + lógica en servicios (guardrail)                                          |
| Términos de pago por razón social (P2 #12)                                                | A1 + A3 (payment_terms)                                                       |
| Tipo de documento al crear contrato / matriz exportación (P2 #9)                          | A1 (fiscal_classification) + A12                                              |
| Gate OC/HES (Alicorp)                                                                     | A11 + A5                                                                      |
| Unificada con churn de por medio (limitación V1)                                          | A5 (route declarativo) + A4                                                   |
| Overrides cantidad 0 / descuadres silenciosos                                             | A10 (vigencias) + A9 (invariante balance triple)                              |
| Pausa/reactivación (P1 #7, BAM-01/Carelis)                                                | A4 (phase_type pause + billing_behavior)                                      |
| FX fijo→spot no limpia / FX por línea                                                     | A3/A6 (escalera FxRateSource persistida)                                      |
| Dev≠prod en funciones RSM                                                                 | Schema como código TypeORM + A9                                               |
| Notificaciones/avisos (P1 #6)                                                             | Event log tipado (A6) como fuente + agentes existentes                        |

## D. Roadmap absorbido por v2 (se diseñan de cero, no se portan)

**Nuevo (Domi 22-08)**: **Presupuesto vs proyección vs real** de ventas/facturación/caja — los ítems "Budget" y "Cashflow" de Labs en la web pasan a producto → `06-budgets-forecast-real.md`. Y los agentes como **add-on facturable por tipo** → doc de agentes §Modelo comercial.

P1 #5 modificaciones · P1 #6 (la parte guards/avisos estructurales) · P1 #7 pausa · P2 #9 tipo documento · P2 #12 términos de pago · Estratégico #20 pricing por tramos · #21 MCP (la API v2 ES la base del MCP) · #22 emisión nativa (modelo fiscal de A6/A12 + tablas SII) · P3 técnico (RSM, standardize, limpieza) queda obsoleto por construcción. **Siguen en v1 mientras tanto**: P0 (AR TiMining, cierre unificada), fixes críticos con bitácora.

## E. Cómo y cuándo se decide cada cosa (reescrito 21-08 bajo el plan incremental)

**Nada de esto bloquea el paso 1** (entities espejo tal cual). Las decisiones estructurales A1–A12 **no se toman todas hoy**: cada una se cierra al abrir su sección de spec (entre el paso 1 y el 2), partiendo siempre de HOY → DELTA. Lo único ya definido:

1. **Primera sección de spec: Pricing — modelos de precio + tramos + billable metric/consumo** (el consumo es parte del modelo de precio, ver A.3 y glosario) — entra como capa NUEVA compatible con `contract_items` actual (el ítem apunta a un precio con tramos; los ítems existentes no se migran, siguen siendo el caso "standard"). Es el feature más urgente comercialmente y no rompe nada.
2. **El patrón de modificaciones de contrato (A4) se decide en su propia sección**, con los tres modelos de referencia sobre la mesa (fases Zenskar / versiones+preview Alguna / sucesor Relvo) y el flujo actual como punto de partida.
3. Todo lo demás que estaba aquí (naming, schemas de Postgres, scope de cortes, multi-tenancy en API) **se descarta por ahora** — se resuelve con Leon cuando el paso correspondiente lo exija.
