# Auditoría del dominio Contratos (antes del módulo `contracts`)

> 23-09-2026 · Domi + Claude · **solo lectura**: corpus `src/databases/postgresql/`, front viejo `sapira-ai/src`
> y producción ("Sapira MVP", solo `SELECT`). Nada se modificó en la base.
> Insumos: [`inventario-rpc-front-viejo.md`](./inventario-rpc-front-viejo.md) §2 y
> [`matriz-scope-migracion-front.md`](./matriz-scope-migracion-front.md) fila 10. Como esos dos, es un análisis
> referencial: las decisiones se toman en sesión y se anotan en [Decisiones](#decisiones-pendientes).
>
> Orden acordado de módulos: **Contratos → Cotizaciones → Facturación** (Cotizaciones casi no tiene funciones
> propias: su lógica es la salida hacia contratos; y Pricing reformará sus ítems).

## Cómo se midió el uso

`track_functions = none` en producción: no hay conteo de llamadas. El uso se infiere de los **datos que cada
función deja** (tipos y fechas en `contract_amendments`, `contract_lifecycle_events`, `contract_workflow_history`,
`invoice_restructure_log`, `invoice_items.fx_rate_source`, etc.) y de si el componente del front viejo que la llama
está **montado** (importado desde una página). "Código muerto" = el llamador no se alcanza desde la UI.

---

## 🔴 1. Seguridad (para Leon, prioridad máxima)

Ya estaba registrado en el README del corpus (punto 1d) que todas las funciones de `public` tienen `EXECUTE` a
PUBLIC; `anon` y `authenticated` además lo tienen **explícito** (un `REVOKE … FROM PUBLIC` no se lo quita a `anon`).
Medido hoy: **las 214 funciones `SECURITY DEFINER` de `public` son ejecutables por `anon`**. Lo nuevo de esta
auditoría es cuáles de contratos son **explotables** y por quién:

| Riesgo | Funciones | Quién puede abusar | Arreglo |
|---|---|---|---|
| **Sin ningún chequeo de usuario** (ejecutable con la anon key del bundle) | `migrate_contracts_to_new_workflow` (hoy moviría 59 Cancelados al paso 1 y reescribiría `workflow_completed_at` de 615 Activos, **todos los holdings**), `generate_missing_invoices_for_contract` (genera facturas en cualquier contrato Activo sin facturas), `approve_contract_amendment` (no exige usuario; no es idempotente) | Cualquiera con la anon key | `REVOKE EXECUTE … FROM PUBLIC, anon, authenticated` (asset en `grants/`, como `010-cleanup-functions-execute.sql`). La 1ª: después `DROP`. Las otras dos las llaman triggers/funciones, no hace falta EXECUTE para roles |
| **Resuelven el holding desde el contrato y no lo comparan con el del usuario** (`get_contract_holding(p_contract_id)`) | `create_contract_upsell`, `create_contract_downsell`, `create_contract_cross_sell`, `create_contract_churn`, `apply_quote_downsell_to_contract` (además `UPDATE quotes` sin validar holding), `apply_contract_contraction`, `register_item_non_renewal` | Cualquier usuario **logueado** de otro holding que tenga el UUID de un contrato ajeno | Quitar `anon` no basta (el front viejo las llama como `authenticated`). Hay que **validar el holding del usuario dentro de la función** (asset en `functions/`), o retirarlas (4 son código muerto, ver §2) |
| Endpoint sin validar holding (API) | `POST /invoices/bulk-update-currency` (solo `SupabaseAuthGuard`) | Cualquier usuaria autenticada con IDs de facturas de otro holding | Validar el holding de las facturas (patrón `ClientsHoldingScopeGuard`) |
| Endpoint sin control de super admin (API) | `POST /holdings/assign-to-all-holdings/:userId` (solo autenticado) | Cualquier usuario autenticado puede asociar cualquier usuario a todos los holdings | Exigir super admin |
| Secretos sin cifrar | `stripe_connections.secret_key`, credenciales de BigQuery, tokens y `client_secret` de Salesforce | Quien lea esas tablas | Cifrar (como `password` de Salesforce) o Vault |
| Funciones legacy abiertas a `anon` | 15 funciones legacy (`delete_mrr_legacy_group`, `mark_mrr_legacy_skip_activation`, `update_legacy_reconciliation_pct`, `create_contract_from_mrr_legacy`, `create_legacy_contract_with_items` con `p_user_id` del cliente) | Sin sesión; varias sin control de holding ni `search_path` | Revocar `anon`, validar holding con la sesión |
| Resolución de holding frágil | `create_contract_renewal` v2: `SELECT holding_id FROM user_holdings WHERE user_id=…` sin filtro → con multi-holding toma uno cualquiera; `reset_invoice_odoo_draft`: acepta cualquier holding del usuario, no el activo | Usuarios multi-holding | En la API el holding sale del contexto de sesión (`ClientsHoldingScopeGuard` o equivalente) |

Propuesta: (1) ya: `REVOKE` de las 3 sin chequeo; (2) al tocar cada función viva: validar holding; (3) cuando el
front viejo deje de llamar una función (módulo migrado), revocar `authenticated` y dejarla solo para la API.
**Decisión de Leon**: si además se hace el endurecimiento en bloque (`REVOKE EXECUTE ON ALL FUNCTIONS … FROM
PUBLIC, anon`), que el README ya deja como "cambio aparte con su propia prueba".

---

## 2. Las 27 funciones rpc (28 firmas)

Recomendación: **DELEGA** = endpoint que llama la función tal cual (paridad segura) · **PORTAR** = lógica a
NestJS · **FUSIONAR** · **RETIRAR** (antes: grep en api-sapira, edge functions y `cron.job`; `REVOKE` como
ventana de observación, luego `DROP` por migración).

### 2a · Movimientos comerciales

| Función | Uso real en prod | Front viejo | Holding | Recomendación |
|---|---|---|---|---|
| `create_contract_renewal` **v1** `(…, p_items jsonb, p_reason, …)` | **Nunca funcionó**: castea `'renewal'` a un enum que solo tiene `RENEWAL` (el `EXCEPTION` lo oculta) | 0 llamadores | Sí | **RETIRAR** (overload muerto) |
| `create_contract_renewal` **v2** `(…, p_term_months, p_new_end_date, p_copy_items, …)` | 33 renovaciones, 4 holdings, última 14-09 | 3 modales de renovación (vivo) + auto-renovación | Frágil | **DELEGA** |
| `create_contract_upsell` | 2 filas del seed demo de Hanka; los 49 UPSELL reales entran por **inserts directos** del front (UpsellingModal, AssignToContract) | Muerto | **No** | **RETIRAR** (el upsell necesita un endpoint nuevo atómico, no esta función) |
| `create_contract_downsell` | 4, todas Hanka demo | Muerto (modal comentado desde 28-05); el SQL ya dice DEPRECATED | **No** | **RETIRAR** |
| `create_contract_cross_sell` | 6, 2 holdings, último 18-08 | `CrossSellingModal` (vivo) | **No** | **PORTAR** junto con su rama de aprobación |
| `create_contract_churn` | Sin rastro propio | Muerto (y manda parámetros que no existen) | **No** | **RETIRAR** (el "churn total" ya lo hace la contracción) |
| `apply_quote_downsell_to_contract` | 14, último 17-09 (11 desde cotización); rama renegociación 0 usos | ContractionModal + AssignToContractModal (vivos) | **No** | **DELEGA** (validar holding antes) |
| `apply_contract_contraction` | **La canónica**: 41 con la versión actual (3 holdings, última 22-09) + ~30 anteriores | ContractionModal (vivo) | **No** | **DELEGA**; absorbe churn total y no-renovación |
| `register_item_non_renewal` | Indistinguible de la contracción | Muerto | **No** | **RETIRAR** (llevar su regla —fecha efectiva = fin + 1; CHURN si son todos los recurrentes— al endpoint de contracción) |
| `approve_contract_amendment` | 96 amendments, **todos Approved, 0 Pending**: el flujo de aprobación nunca se usó | Modal de aprobaciones no montado; vive dentro de upsell/downsell/cross_sell | **No** (ni usuario) | **FUSIONAR**: solo sobrevive su rama CROSS_SELL, portada. Sus ramas RENEWAL/CHURN son versiones peores de renewal v2 y la contracción. Roadmap Complejos #1 ya pedía "retirar o blindar" |

### 2b · Estado, flujo, FX y cliente

| Función | Uso real en prod | Front viejo | Holding | Recomendación |
|---|---|---|---|---|
| `bulk_activate_contracts` | **572 contratos**, 3 holdings, último 21-09: es el camino real de activación | "Activar (n)" en la lista (vivo) | Sí | **DELEGA** como `POST /contracts/activate {ids[]}`; sumar la validación de `companies.tax_rate` que hoy solo hace el cliente |
| `mark_contract_signed_safe` | 27, último 26-01 | Diálogo de workflow (vivo) | Sí, pero **no valida status** (reactiva Cancelados) ni FX | **FUSIONAR** en la anterior y **RETIRAR** |
| `migrate_contracts_to_new_workflow` | One-shot ya cumplido (solo quedan Activo/Cancelado/En revisión) | Muerto | **No** | **RETIRAR ya** (ver §1) |
| `bulk_restructure_contract_start_dates` | ~171 contratos, 1 holding (atribución no concluyente) | "Reestructurar fechas" (vivo) | Sí | **DELEGA** (destructiva multi-tabla; la atomicidad importa) |
| `apply_fixed_fx_to_contract` | 37 contratos `fixed`, último 22-09 | Pestaña Facturas del contrato (vivo) | Sí | **DELEGA** + arreglar bug: fija la política **antes** de validar y devuelve el error como JSON (la transacción confirma igual) |
| `bulk_confirm_fx_policy` | 175 contratos en 38 lotes, último 13-07; el caso de 1 contrato lo hace un `.update()` directo del front | Modal de activación (vivo) | Sí | **DELEGA** con un solo endpoint `ids[]` que reemplace también el update directo |
| `change_contract_currency` | No medible (solo opera antes de la firma y la auditoría no registra esos estados) | Editor del contrato (vivo) | Sí | **DELEGA**; a mediano plazo, un solo endpoint "guardar ítems + moneda" (Complejos #1 etapa 2) |
| `change_contract_commercial_client` | No medible (misma razón) | Editor del contrato (vivo) | Sí; sin `search_path` | **DELEGA** y luego **FUSIONAR** con Medios #13 (cambiar razón social de un contrato activo) |

### 2c · Facturas derivadas del contrato y consultas

No son "tres caminos para generar facturas" sino **tres capas**: `regenerate_*` arma el cronograma
(`contract_invoices`), `generate_missing_invoices_for_contract` lo materializa en `invoices` al activar, y
`sync_invoices_for_contract_item` mantiene las Por Emitir después de la firma. Lo repetido es la **lógica**:
frecuencias (LIKE vs CASE vs `get_frequency_months`), formato de descripción, `due_date = +30` fijo y la
clonación de encabezado. Unificarla al portar (y el `+30` se reemplaza con condiciones de pago, Medios #11).

| Función | Uso real en prod | Front viejo | Holding | Recomendación | Módulo |
|---|---|---|---|---|---|
| `generate_missing_invoices_for_contract` | 5.091 líneas / 574 contratos, última 18-09 (casi todo vía triggers) | Botón muerto; modal legacy (flujo agotado: 101/101 legacy activados) | **No** | Motor interno: **DELEGA** desde la activación; `REVOKE` a roles (§1) | contracts |
| `regenerate_contract_invoices_from_items` | 41 filas legacy / 10 contratos, última 27-08 | Editor (solo legacy) | Sí; sin `search_path` | **FUSIONAR** con `regenerate_contract_invoices_for_restructure` (difieren solo en el filtro legacy) | contracts |
| `sync_invoices_for_contract_item` | 22 sincronizaciones, 25-08 → 22-09 | Editor de ítems post-firma (vivo) | Sí + permiso + lock | **DELEGA** (la más robusta del grupo) | contracts |
| `invoice_reschedule_items` | 74 reestructuraciones / 45 contratos, última 22-09 | Vista Reestructurar (vivo) | Sí + permiso + lock | **DELEGA** | contracts |
| `invoice_items_bulk_update_description` | **La más usada**: 227 / 121 contratos, 62 en 30 días | Pestaña Facturas + acciones masivas de Facturación | Sí + permiso | **DELEGA** | invoices |
| `invoice_bulk_update_terms` | 1 uso (07-05) | Pestaña Facturas | Sí + permiso | **DELEGA** provisional; lo absorbe Medios #11 | invoices |
| `invoice_reassign_entity` | 35 / 9 contratos, último 14-09 | Pestaña Facturas | Sí + permiso | **DELEGA**; se vuelve un paso de "Cambiar razón social" (Medios #13) | invoices → contracts |
| `reset_invoice_odoo_draft` | No medible (log en Mongo) | Pestaña Facturas | Parcial | **PORTAR** junto al scheduler de `invoices` (⚠️ tras el reset, el scheduler la reenvía sola y puede duplicar el borrador en Odoo) | invoices |
| `get_contract_reconciliation` | Solo lectura | Muerto | Sí | **RETIRAR** (además suma Canceladas y NC; el cuadre real es `check_contract_item_continuity`) | — |
| `recalc_revenue_for_contract` | Vive dentro de `approve_contract_amendment` | Muerto | Sí | **RETIRAR** el rpc; el nombre engaña: solo **borra** `contract_invoices` editables. Revisar en Complejos #1 si ese borrado es intencional | — |

**Resultado (28 firmas): 9 a retirar** (renewal v1, upsell, downsell, churn, non-renewal, mark_signed —tras
fusionarla en bulk_activate—, migrate_workflow, reconciliation, recalc_revenue) · **2 a fusionar**
(approve_amendment → cross-sell; regenerate_from_items → su gemela) · **15 que el endpoint delega** ·
**2 a portar** (cross_sell, reset_odoo_draft).

---

## 3. Lo que no pasa por rpc

### Tablas
Todas tienen entity en `entities/contratos/` (solo `contract.entity.ts` difiere de prod, documentado en su
README). Estados reales: `contracts.status` Activo 619 · Cancelado 59 · En revisión 16 (Firmado/Expirado/En
proceso: 0). `contract_amendments`: 96, todas Approved.

**Datos sucios que el DTO debe normalizar (o migrar antes):** `contracts.type` ("Nuevo Cliente"/"Nuevo
cliente"/"New Client"/"NewBusiness"/""…), `contract_items.item_type` (Licencia/Licencias…),
`contract_lifecycle_events.event_type` (CHURN/churn, CROSS_SELL_APPLIED/cross_sell) y `event_status`
(Completed/completed), `contract_invoices.status` (Programada/pending/Satisfecha/Facturada).

### Triggers con efectos ocultos
Un simple `UPDATE contracts SET status='Activo'` **genera facturas, reconstruye el RSM y fija `booking_date`**
por trigger. Hallazgos:
- `generate_invoices_on_contract_active` y `unified_generate_invoices_on_contract_signed` hacen lo mismo
  (el segundo en correr se salta). **Duplicado de código, pero no duplica facturas** (corren en la misma
  transacción; verificado en S2: 0 casos).
- 3 triggers `updated_at` idénticos en `contract_lifecycle_events`. **Duplicados.**
- `trigger_revenue_schedule_on_contract_activation` y `apply_pending_renewal_tail` **se tragan los errores**.
- `validate_fx_before_firmado` nunca se dispara (no existe el estado Firmado en la práctica).
- La activación deja **dos** filas de historial **solo cuando el contrato tenía un paso de workflow en curso**
  (53/53 de la masiva; 0 de 519 sin paso) — corregido en S2.

### Funciones internas
- **Auto-renovación inoperante**: 383 ítems con `auto_renew`, **0 renovados nunca**; el cron diario
  `auto-renew-contract-items` reporta "succeeded" (253 corridas). **Causa confirmada en S2** con los logs: renewal
  v2 exige usuario de sesión (`auth.uid()`), el cron no tiene → "Usuario no encontrado" en 11/11 ítems del
  23-09; `process_auto_renewals` atrapa el error por ítem y termina OK.
- `auto_expire_contracts` sin llamador: el estado Expirado tiene 0 filas (**el vencimiento nunca corre**).
- Overloads: `calculate_contract_fx_rate` ×3, `create_contract_renewal` ×2, `rsm_metrics`, `fx_rate`,
  `calculate_contract_fx_amounts`, `bulk_reconcile_legacy_invoices`, `confirm_legacy_invoice_reconciliation` ×2.
- Posibles huérfanas (sin llamador SQL, cron ni rpc del front; **falta** grep en api-sapira y edge functions):
  `auto_expire_contracts`, `activate_legacy_contract`, `execute_auto_renewal_for_item`,
  `generate_invoices_for_contract_item`, `get_items_pending_auto_renewal`, `create_legacy_contract_with_items`,
  `derive_contract_items_from_legacy`, `contract_fx_policy_upsert`, `mark_contracts_as_bulk_import`,
  `search_contracts_by_client_identity`, `suggest_contract_item_matches`, `get_invoice_items_with_credits`,
  `admin_populate_revenue_schedule`, `calculate_contract_fx_rate`.

### Lecturas y escrituras directas del front viejo
- **Lista**: `contracts.select('*', clients, client_entities, contract_items, companies, quotes)` **sin filtro ni
  paginación**; filtra y ordena en el navegador.
- **Escrituras sin transacción**: AssignToContract y el Upsell inline escriben en 6 tablas desde el cliente
  (amendments, items, lifecycle, invoices, invoice_items…). Wizard de creación, duplicar y borrar, igual.
- **Borrado físico** de contratos desde el navegador (individual y masivo), protegido solo por una lista de
  estados en el cliente.
- **Adjuntos**: `contract_documents` guarda `getPublicUrl` sobre buckets **privados** → esas URLs no deberían
  abrir (no probado en vivo). Pasa a URL firmada emitida por la API.

---

## 4. Propuesta del módulo `contracts` (v1)

Principios: el holding sale de la sesión (guard); cada escritura multi-tabla es **una transacción**; las
transiciones de estado son **explícitas** (la API no replica lo que ya hacen los triggers, pero lo documenta y
devuelve su efecto); los endpoints de acción **delegan** en la función SQL validada (paridad) y se portan a
NestJS caso a caso.

**Lectura** — `GET /contracts` (paginado, filtros y orden en servidor: estado, cliente, razón social,
compañía, producto, vencimiento por ítem, con factura en ERP) · `GET /contracts/kpis` · `GET /contracts/:id`
(por UUID o `contract_number`) · `/:id/items` · `/:id/alerts` · `/:id/invoice-schedule` · `/:id/invoices` ·
`/:id/history` (lifecycle + amendments normalizados) · `/:id/revenue-schedule` · `/:id/quantities` ·
`/:id/documents` · `/:id/workflow` · `/:id/fx-period-rates` · `/:id/billing-splits`. (`GET /clients/:id/contracts`
alimenta la pestaña Contratos del Cliente 360.)

**Escritura directa hoy → endpoint** — `POST /contracts` (wizard: contrato + ítems + cronograma, una
transacción) · `POST /:id/duplicate` · `PATCH /:id` · `PATCH /contracts/bulk-settings` · `DELETE` con guard de
estado en servidor (o soft-delete) · CRUD `/:id/items` · `PUT /:id/invoice-schedule` (redondeo en servidor) ·
`POST /:id/assign-quote` (reemplaza AssignToContract + Upsell inline, atómico) · CRUD `/:id/quantities` ·
documentos con URL firmada · workflow · billing-splits · fx-period-rates · configuración (workflow-steps,
churn-reasons, clauses, templates).

**Acciones (las funciones vivas)** — `POST /contracts/activate` (bulk_activate) · `/:id/renew` (renewal v2) ·
`/:id/contraction` (contracción: churn, downsell, no-renovación) · `/:id/quote-downsell` · `/:id/cross-sell`
(portado) · `/:id/restructure-dates` · `/:id/fx-invoice-policy` · `/contracts/fx-company-policy` ·
`/:id/currency` · `/:id/commercial-client` · `/:id/items/:itemId/sync-invoices` · `/:id/reschedule-invoices`.
Las de facturas (descripciones, términos, reasignar entidad, reset Odoo) van al módulo `invoices`.

**Orden sugerido**: lecturas primero (lista + 360 del contrato en `/lab`, y la pestaña Contratos del Cliente
360) → activación y contracción (las más usadas) → el resto de acciones → escrituras directas (assign-quote y
wizard son las más riesgosas).

---

## 5. Roadmap operativo que toca contratos

Tanda 3 #1 (churn usa booking en vez de fecha efectiva) · Tanda 3 #2 (la cuenta en la descripción: **en el
corpus ya parece aplicada** en `generate_missing…` y `sync_invoices…` — confirmar contra prod y cerrar) ·
Tanda 2 (próximos a vencer por ítem; redondeo de `contract_invoices.amount`) · Medios #5 (FX: las Por Emitir
`spot` con FX pegado **subieron a 79**, el roadmap decía ~61) · Medios #7 (correlativo CTR) · **Medios #11**
(condiciones de pago: reemplaza el `+30` fijo; se conecta con `client_entities.payment_terms`) · Medios #12
(renegociación: falta QA) · Medios #13 (cambiar razón social de contrato activo) · Complejos #1 (Modificaciones:
esta auditoría lo destraba) · #2 · #6 (RSM) · #7 (preview) · #8 (propagar `end_date`/`total_value` al
encabezado) · #9 (pausa por ítem) · Estratégico #25 (indefinidos).

---

## 6. Plan de ejecución (23-09) — urgentes + limpieza, sin romper lo que funciona

> Fuentes leídas completas para este plan: `sapira-ai/docs/ROADMAP-OPERATIVO.md` (rama `domi`, `8424738`: bloque
> "Evidencias 23-09", "Evidencias 22-09", ✅ Desplegados, ⚡ Tandas, Complejos #1 y #6, Decisiones registradas),
> `sapira-ai/docs/soporte/metodologia-soporte-agente-ia.md` (reglas duras 1–15, 4 patas, 5 categorías) y las
> memorias de la sesión de soporte (cierres 22-09 y 23-09, amendments/downsell, churn booking, RSM B/C,
> standardize, period guard, régimen de migraciones). A las usuarias se les dijo: **arreglos de fondo a fines de
> esta semana**.

### 6.1 Estado real verificado hoy (corrige lo que los docs dicen)

| Ítem | Los docs dicen | Verificado 23-09 | Acción |
|---|---|---|---|
| Descripciones pierden la cuenta (Tanda 3 #2, Nuevos 15-16 sep "generador debe incluir la cuenta", la sesión que quedó a medias) | Pendiente / "listo para migrar" | **Ya en prod** desde 22-09 23:32 (`sapira_sql_asset_history`) y en el corpus: `sync_invoices_for_contract_item` y `generate_missing_invoices_for_contract` concatenan `' Cuenta ' ‖ account` | Marcar ✅ en ROADMAP (sapira-ai). Sigue sin resolver lo que la misma sesión dejó como límite: preservar textos 100% manuales (necesita flag/columna: diseño, no fix) |
| Regresión de Reestructurar con overrides (#3 del bloque 23-09) | "Asset aplicado en prod y SIN commit: corregir antes de commitear" | El fix del 21-09 **ya está commiteado** (`a2647bc`, Domi) y está en `origin/qa` y `origin/main`. El asset vigente no lee `quantities` → la regresión está viva | Corrección = **asset correctivo nuevo** (editar el mismo archivo) → QA → prod |
| Copia del ROADMAP en api-sapira (`docs/ROADMAP-OPERATIVO.md`) | "Copia espejo, doble anotación" | 164 líneas vs 179 en sapira-ai: **no tiene** los bloques 22-09/23-09 | Re-sincronizar al cerrar esta etapa |

### 6.2 Por qué no se puede ir "fix por fix"

Las 8 evidencias no son independientes: 5 caen en el **mismo subflujo** (aplicar cotización a contrato), 2 en el
motor de Reestructurar, y todas desembocan en las mismas 4 piezas compartidas (generador de cuotas/períodos, trigger
`standardize_invoice_items`, RSM, convención FX). Por eso el método es **por subflujo**, y cada fix pasa por la misma
red de seguridad.

**Los 8 subflujos del dominio** (mapa que se completa en la Fase 0):

| # | Subflujo | Piezas hoy | Evidencias / roadmap que viven ahí |
|---|---|---|---|
| S1 | **Creación** (wizard manual; desde cotización firmada) | Inserts directos del front (contrato + ítems + cronograma), `generate_missing…` por trigger al activar | Tanda 2 redondeo cronograma, Medios #7 correlativo, #11 términos, one shot (#8 23-09) |
| S2 | **Activación / estado / vencimiento** | `bulk_activate` (+ `mark_signed`), triggers de activación (facturas, RSM, booking), `auto_expire_contracts` sin llamador | Historial duplicado, Expirado nunca corre, auto-renovación rota |
| S3 | **Modificaciones** — desde el contrato (Upselling/CrossSell/Contraction/Renewal/Renegociación) y **desde cotización** (AssignToContract) | Inline en el front (6 tablas), `apply_quote_downsell_to_contract`, `apply_contract_contraction`, `create_contract_renewal` v2, `create_contract_cross_sell`→`approve_contract_amendment` | **#1, #2 (23-09) y (a)–(d) del 22-09**, Tanda 3 #1 churn booking, revertir churn, Complejos #1 completo, S04191, Sinba |
| S4 | **Facturas del contrato** (generar, sincronizar, reestructurar, unificar/consolidar, descripciones, términos, reasignar entidad, reset Odoo) | `generate_missing…`, `sync_invoices_for_contract_item`, `invoice_reschedule_items` + `check_contract_item_continuity`, `unify_invoices_multi_contract` / `consolidate_invoices_simple`, bulk updates | **#3, #4, #5 (23-09)**, V1/V2/V4, Medios #2 (qty 0), Complejos #3 standardize, #7 preview |
| S5 | **RSM / devengo** | `revenue_schedule_rebuild*` (10 llamadores), triggers de ítems/quantities | **#2 −10,51 (Bosch)**, sub-bugs B/C, Complejos #6 |
| S6 | **Monedas y FX** (contrato · sistema · factura · compañía) | `apply_fixed_fx_to_contract`, `bulk_confirm_fx_policy`, `change_contract_currency`, triggers de FX, convención "PE con conversión nace NULL" | Bug de `apply_fixed_fx` (política antes de validar), 79 PE spot con FX pegado (Medios #5) |
| S7 | **Variables / cantidades** (hasta que llegue Pricing) | `quantities` + 5 triggers, overrides | Complejos #2, Medios #2, #3 (23-09: la qty del override) |
| S8 | **Legacy / onboarding** | 11 funciones legacy, `regenerate_*_from_items`, imports | V9, flujo de activación legacy agotado (101/101) |

### 6.3 Red de seguridad (se arma una vez y se usa en cada fix)

1. **Contrato de invariantes por subflujo** (Fase 0): qué debe cumplirse siempre, escrito desde las convenciones
   vigentes y no desde el código actual. Base: las 4 patas (TV = Σ ítems = Σ vigentes = calendario; RSM = TV o
   facturado real en variables), header = Σ líneas, línea = qty × PU × (1−dcto) sin `1 × total`, períodos
   `[inicio, fin]` sin solape y con `fin = siguiente − 1 día`, PE con conversión nace con fx NULL y nunca mixta,
   misma moneda ⇒ fx = 1, vencimiento MX = emisión + 1 mes, sin `—`/`–`, fecha efectiva (no booking) manda en
   churn/downsell, standardize solo se confía en la generación estándar.
2. **Sensor de producción** (solo lectura, un script SQL): cuenta por holding los contratos que violan cada
   invariante. Se corre **antes y después** de cada deploy: un fix no puede subir ningún contador (los descuadres
   heredados quedan como línea base explicada, no se "arreglan" de pasada).
3. **Casos de regresión reales** (ya reparados en data, sirven como esperado): Bosch CTR-2026-13 · LAND FAST S07244 ·
   Grupo Ibarra CTR-2026-204 · Stanhome CTR-2026-884106 · BAT CTR-2026-86 + Tercerizado · CTR-2026-Salvador ·
   Alicorp CTR-2026-55 · Check tu Recolector S08255 · + los del roadmap (STG-38, Eos-218, CEFA S08540, La Mascota
   CTR-2026-132, S04191, Sinba). Cada fix declara qué casos reproduce y qué casos no debe romper.
4. **Ciclo del régimen nuevo** (ya probado el 21-09): editar asset en api-sapira → guardas (`assets-runner.spec`) →
   apply **QA** → test con fixtures Hanka (usuario simulado) + réplica del caso real → **revisión de Leon** → apply
   prod → md5 → sensor → validación con la usuaria → commit/PR. Nada de hotfix de esquema por MCP.
5. **Mapa de dependencias** (de este documento, §2–§3): antes de tocar una función se listan quién la llama
   (triggers, otras funciones, front) y qué triggers dispara. Ej.: tocar el generador de períodos toca S1, S3 y S4.

### 6.4 Fases

**Fase 0 — Lectura completa y contrato de invariantes (sin código).** Por subflujo, en orden de urgencia S3 → S4 →
S5 → S1/S2 → S6/S7 → S8: leer el camino completo (componente del front viejo → función/inserts → triggers → RSM),
escribir sus invariantes, contrastarlos con las Decisiones registradas y listar los casos de regresión. Resultado en
este documento (§7, un apartado por subflujo) y **validación de Domi** antes de pasar a código. Para los urgentes
(S3, S4) es de 1 a 2 sesiones; el resto se completa en paralelo al rediseño.

**Fase 1 — Urgentes de esta semana** (orden por dolor + riesgo; cada uno con la red de §6.3):

| # | Fix | Subflujo / pieza | Por qué en este orden |
|---|---|---|---|
| U1 | Reestructurar usa la qty del override (`quantities`) o la de la línea, y recién si no hay, la del ítem | S4 · asset `invoice_reschedule_items` | Regresión **nuestra**, viva, chica y ya acotada (1 caso) |
| U2 | Validador de Reestructurar compara Δ antes/después (o lee líneas), no headers | S4 · `check_contract_item_continuity` | Bloquea a las usuarias (Alicorp); misma pieza que U1 → mismo ciclo QA |
| U3 | Guard de unificadas línea a línea (ninguna línea convertidora sin valorizar) | S4 · `unify_invoices_multi_contract` / `consolidate_invoices_simple` (confirmar cuál en Fase 0) | Evita el $0 en Odoo (BAT) |
| U4 | **Aplicar cotización a contrato (upsell/cross-sell)**: (a) fin de período `−1 día` en líneas y `end_date`; (b) hereda el ciclo del contrato con proporcional del 1er período; (c) acota al fin del contrato; (d) hereda Fijo/Variable del padre y usa CROSS-SELL si el producto no existía; (e) genera las facturas del ítem nuevo y agrupa **por período** (no por fecha de emisión); + método de facturación elegido (22-09 b) | S3 | Es el que más usuarias reportan. **Decisión D-A abajo**: dónde vive el arreglo |
| U5 | Churn usa la fecha efectiva (start del ítem CHURN), no el booking | S3 · `apply_contract_contraction` (Tanda 3 #1) | Cada churn nuevo lo reproduce |
| U6 | El generador no repite ítems `is_recurring=false` en cada período | S1/S3 (ubicar el generador exacto en Fase 0) | Alicorp; hoy la one shot "fantasma" solo se ve al cuadrar |
| U7 | Mostrar el tipo del ítem (Fijo/Variable/Digital) en el detalle del contrato | Front viejo (fila madre, `7d66edb`) | Cambio chico de UI; en el front nuevo va desde el inicio |
| U8 | RSM: el rebuild parcial carga el devengo acumulado previo (hoy lo reinicia en 0 → deferred inflado en 96 contratos) + rebuild | S5 · `revenue_schedule_rebuild_contract_ccy` | Reportes de deferred/unbilled equivocados (TiMining 3,4 M vs 1,26 M) |
| U9 | RSM: triggers de facturas, ítems y cantidades toman el holding del registro (no del usuario de sesión) + la API reconstruye tras el webhook de Odoo + rebuild de los afectados | S5 · triggers `trg_rsm_on_*` + API invoices | Lo facturado vía Odoo no llega al RSM (SimpliRoute agosto: 429 de 480 facturas) |
| U10 | Upsell/cross-sell/AssignToContract respetan la **moneda de facturación y la política FX** del contrato (no la moneda del ítem de cotización ni fx 1) | S6 · B1 · `UpsellingModal`, `AssignToContractModal` (Complejos #1) | Línea en UF enviada a Odoo como CLP |
| U11 | IVA del encabezado convertido a moneda de factura (× fx) + corregir las 12 PE | S6 · B2 · `sync_invoices_for_contract_item`, `invoice_reschedule_items` | 10 PE fijas con IVA en moneda de contrato |
| U12 | "Fijo" sin tasa **bloquea el envío y alerta** (no spot en silencio); el guard mira la política y tasa de la factura/líneas | S6 · B3 · `invoice-scheduler.service.ts:1201` | 11 PE |
| U13 | El sync de cantidades excluye NC (`document_type`) | S7 · B4 · `sync_invoice_items_amounts_from_quantities` | 19 NC Por Emitir expuestas a montos positivos |

Fuera de esta semana: RSM mitad de mes −10,51 y sub-bugs B/C → **Sesión RSM** (S5; toca la función núcleo con 10
llamadores y exige rebuild masivo: no se mezcla con urgentes). "Revertir churn" → etapa de Modificaciones (S3).
Estado de pago desde Odoo y unificadas con FX diferido → carril León / estratégico.

**Fase 2 — Módulo `contracts` en la API + limpieza**, subflujo por subflujo en el orden de §4 (lecturas → activación
y contracción → resto de acciones → escrituras riesgosas). Por cada subflujo: endpoints que **delegan** en las
funciones ya corregidas, retiro de lo muerto (REVOKE como ventana de observación → DROP por migración), fusión de
duplicados (activación, regeneración, triggers de generación, `updated_at`) y unificación del **generador de
períodos** (hoy frecuencias por LIKE/CASE/`get_frequency_months`, +30 fijo, clonación de encabezado duplicada) en
una sola pieza. El front nuevo (`/lab/contratos`) se construye sobre esos endpoints.

**Fase 3 — Complejos con diseño**: RSM (#6), preview antes de persistir (#7), headers (#8), pausa por ítem (#9),
indefinidos (#25) y, al final, **Pricing** reemplazando el modelo de variables (S7).

### 6.5 Método acordado (Domi 23-09)

Fase 0 **completa antes de cualquier fix**, en el orden S1 → S8 (aunque haya urgentes: a las usuarias se les
avisa que estamos corrigiendo y se les alinean los datos apenas reporten). Por cada subflujo se presenta a Domi:
**cómo funciona hoy** (pantalla del front viejo → función/inserts → triggers → RSM), **qué reglas debe cumplir**,
**qué problemas y consultas llegaron** (ROADMAP-OPERATIVO + metodología de soporte), y **qué mejoras rápidas se
suman de una** (como los términos de pago en Clientes). Domi comenta cómo debe funcionar y valida antes de codear.
Marco de diseño: principios de [`flexibilidad-con-trazabilidad.md`](./flexibilidad-con-trazabilidad.md) (editar lo no
emitido y regenerar; desvíos explícitos con motivo; guía antes de persistir; invariantes fiscales/contables) y las
decisiones A.1–A.12 de [`mejoras-y-brechas.md`](./mejoras-y-brechas.md).

### 6.6 Mejoras que Domi quiere sumar (23-09), por subflujo

| # | Mejora (palabras de Domi, resumidas) | Subflujo | Ya diseñado en |
|---|---|---|---|
| M1 | Moneda de facturación y FX/política definidos desde el inicio, al crear el contrato | S1 · S6 | A.3 |
| M2 | Modificaciones más sencillas, limpias y unificadas, sea el origen cotización o el contrato | S3 | A.4, flexibilidad caso 4 |
| M3 | Multimoneda real: ítems en distintas monedas dentro de un contrato (sin tener que unificar contratos), con todo lo necesario para confirmar su FX a la moneda de facturación | S6 · S4 | A.3, flexibilidad caso 2 |
| M4 | Selector de tipo de documento (factura electrónica, exportación, NC, ND) con referencias y códigos reales por país; mejoras menores en la integración Odoo | S4 (+ carril León) | A.1, A.12, Complejos #4 |
| M5 | Ítems de término indefinido: mes a mes hasta que se modifique (resolver el impacto en RSM) | S1 · S3 · S5 | A.4, Estratégico #25 |
| M6 | Políticas de devengo mensual / semanal / diario (hoy el prorrateo por días se resolvió con funciones y ajustes sueltos) | S5 | A.9 |
| M7 | RSM como pieza central: deferred, unbilled, EOM y del período, incluidos los variables | S5 · S7 | A.9 |
| M8 | RSM en moneda de consolidación: reportes que separen la variación que es solo tipo de cambio | S5 · S6 | — (nuevo) |
| M9 | RSM: facturas en moneda de compañía a FX de factura cuando se facturó en esa moneda (diferencias de cambio) | S5 · S6 | — (nuevo) |
| M10 | Contrato con una compañía y facturación con otra → asientos intercompañía | S5 · S4 | — (nuevo) |
| M11 | Compañías: tax rates, cuentas contables para asientos, etc. | S4 · S5 (+ Tanda 2 tax_rate) | A.1 (c) |
| M12 | Devengo de NO recurrentes: por % de avance, al facturar o en el término (hoy solo la última), con configuración inicial | S5 · S1 | A.9 (catálogo de métodos) |
| M13 | Budget de ingresos, facturas y caja con seguimiento | Reportes (fuera de S1–S8; usa S5) | `budgets-forecast-real.md` |
| M14 | Reporte de vendedores realmente útil | Reportes (Medios #9) | — |
| M15 | Onboarding y MRR legacy editable después, más intuitivo y con más IA (al final) | S8 | B.3 |
| M16 | Simplificar lo que nadie usa (workflow de aprobación al crear contrato, aprobación de modificaciones) o dejar versión sencilla; mejorar nombres de estados de cotizaciones | S2 · S3 (+ Cotizaciones) | — |
| M17 | Todo el detalle del ROADMAP-OPERATIVO | S1–S8 | — |

### 6.7 Decisiones que destraban la Fase 1

| # | Decisión | Opciones | Recomendación |
|---|---|---|---|
| D-A | ¿Dónde se arregla U4 (aplicar cotización a contrato)? | (1) Parchar el código inline del front viejo (`AssignToContractModal`/`UpsellingModal`, 6 tablas sin transacción); (2) **una función SQL atómica** `apply_quote_upsell_to_contract`, hermana de `apply_quote_downsell_to_contract`, que el front viejo llama en lugar de los inserts y que después el endpoint de la API delega | **(2)**: es el refactor que ya pedía Complejos #1, es testeable en QA con los casos reales, sirve a ambos fronts y no se tira después. Riesgo: más trabajo que un parche; se acota al alcance (a)–(e) + método |
| D-B | Plazo de un upsell/cross-sell que excede el contrato | Termina con el contrato (criterio usado en Bosch) · o extiende el contrato | Termina con el contrato (ya aplicado a mano); extender = renovación explícita |
| D-C | Primer período del upsell a mitad de ciclo | Proporcional por días exactos (Bosch 36,73) · convención de medio mes | Días exactos (regla del recetario #6) |
| D-D | Quién revisa cada asset antes de prod | Leon en cada uno · Leon solo en S3/S5 | Leon en cada uno durante esta etapa (acordado por Domi) |

## 7. Fase 0 por subflujo

> Cada subflujo: **cómo funciona hoy** (con cita `archivo:línea`; `SRC` = `sapira-ai/src/`, `DB` =
> `api-sapira/src/databases/postgresql/`) → **reglas implícitas** → **evidencia de prod** → **problemas vivos** →
> **brechas vs mejoras M#** → **preguntas para Domi**. Estado: 🟡 presentado, esperando comentarios · ✅ validado.

### S1 · Creación de contratos — ✅ decisiones tomadas 23-09 (quedan 3 temas por investigar: S1-6, S1-12, S1-16)

**Caminos.** (A) Asistente manual `ContratoForm` (botón "Nueva solicitud", `?action=new`); (B) el mismo asistente
precargado desde una cotización Firmada (`CotizacionesList.tsx:1153-1160` → `/contratos?cotizacionId=…`); (C)
duplicar contrato (`useContractLifecycle.ts:77-172`); (D) import CSV solo cabecera (`dataImportService.ts:177-205`);
(E) import legacy y (F) desde MRR legacy → subflujo S8. Salesforce crea **cotizaciones**, no contratos.
"Asociar a contrato existente" (`AssignToContractModal`) → S3.

**Uso real (prod, desde abril):** MRR legacy 186 · asistente desde cotización 21 · asistente manual 10 · import
legacy 13 · seeds Hanka 14. (El camino del asistente se infiere por la cercanía de tiempos contrato→cronograma: es
aproximado.)

**Cómo funciona el asistente** (`useContratoWizard.ts:11-44`): Fuente → Información → Ítems → Facturación →
¿documento? → Plantilla/cláusulas.
- **Validación**: solo compañía + razón social (paso 1), ≥1 ítem (paso 2) y cronograma que cuadra (paso 3). **El schema
  Zod nunca corre** (`ContratoForm.tsx:160` usa `getValues()`), así que término, inicio, producto y representante no se
  exigen. Hay validadores escritos que nadie llama (`contractValidation.ts`, `connectivityService.ts`).
- **No pide**: moneda de facturación, política FX de facturación, tipo de documento/`export_type` ni términos de pago.
  "Términos y condiciones de factura" es texto para el ERP, no plazo de pago.
- **Moneda por ítem**: la UI deja elegirla, pero la base exige que sea la del contrato
  (`validate_contract_item_currency_consistency.sql:11-13`) → el error aparece recién al guardar.
- **Cronograma** (`revenueScheduleUtils.ts`): omite en silencio ítems sin inicio/término/precio **y los descuenta del
  total a cuadrar** (`:26-31`); Bianual cae a Mensual (`:258-266`); cuota = `final/ceil(term/freq)` **sin redondeo**
  (`:188`); **ignora `is_recurring`** (un one shot se reparte en cuotas); modo anual con descuento arma cuotas sin el
  descuento (`:182-185`) y no cuadra; "juntas/por ítem" agrupa por mes calendario pero **la elección no se guarda**
  (`group_invoices_by_period` queda `true` siempre); prorrateo por día de facturación existe pero no se usa
  (`useRevenueSchedule.ts:60`).
- **Plantilla y cláusulas**: se eligen y **no se guardan** (no hay columnas; `contractCreationService.ts:110-138`).
- **Persistencia sin transacción** (`useProgressiveContractCreation.ts:30-83`): contrato → UPDATE FX a sistema (si
  falla, solo advierte) → ítems → cronograma → marca la cotización. Si algo falla, borra solo el contrato (cascada a
  ítems y cronograma) y **no revisa el error del DELETE** (`contractCleanupService.ts:4-11`).
- **Número**: manual libre, o `prefijo + año + 6 hex del UUID` (`client.ts:25-29`). **No hay UNIQUE** (verificado:
  solo PK) → 2 números duplicados en prod (`CTR-2026-200`, `CTR-2026-210`). El manejo de `23505` es código muerto.
- **Estado inicial**: "En revisión" + primer paso del workflow del holding. Al pasar a Activo, `generate_missing…`
  crea las facturas con `due_date = emisión + 30`, `FACTURA`, `export_type 0` fijos (frontera con S2).

**Triggers al crear** (DB): en `contracts`, solo `company_currency` hace algo (los de FX, facturas y booking esperan a
Activo; la auditoría no registra "En revisión"). En `contract_items`: categoría NEW/UPSELL/CROSS-SELL (solo con
`product_id`), precios mensual/período (modo anual con descuento **sin** descuento, `auto_calculate_pricing_fields.sql:62-72`),
`end_date = inicio + término − 1 día` (sobrescribe), `contracts.term = MAX(term)`, moneda = la del contrato (o
RAISE), **auto-renovación heredada de la cotización también cuando la usuaria la desmarcó** (verificado:
`inherit_auto_renew_from_quote_item.sql:17` trata `false` igual que null), y `apply_pending_renewal_tail` inserta RSM
sin mirar el estado.

**Desde cotización**: precarga cliente (razón social vacía, hay que elegirla), moneda, ítems con `quote_item_id`,
custom fields, oportunidad SF y booking por ítem. **No propaga términos de pago** (17 de 21 cotizaciones los traían:
100% perdidos) y la booking de cabecera coincide con la de la cotización en 4/21 (hoy la fija la activación). Hanka no
tiene el stage "Contrato creado" (sus 15 cotizaciones quedaron en "Firmada").

**Duplicar**: copia cabecera e ítems, **no** cronograma ni número; conserva `quote_id`. Sin uso desde marzo.

**Evidencia de prod adicional**: moneda de facturación ≠ contrato en 12/21 (desde cotización) — se define después en
la pestaña Facturas; 69 cuotas con decimales sucios en 60 días (y 2 en CLP/COP con decimales); 10/31 números hex;
3+2 contratos de distinto país con `export_type 0`; `243` con 4 PE en `export_type 1` siendo CL→CL; el workflow se
completa en mediana 4,4 min y solo 2 contratos pasaron más de un paso (ningún paso de SimpliRoute exige aprobación).

**Problemas vivos**: redondeo del cronograma (Tanda 2) · correlativo hex y sin unicidad (Medios #7) · términos de
pago perdidos y `+30` fijo (Medios #11) · sin tipo de documento al crear (Complejos #4) · one shot repartido
(evidencia #8) · modo anual con descuento · ítems sin `product_id` permitidos por el front · auto-renovación que no se
puede desactivar · agrupación que no se guarda · plantilla/cláusulas que no se guardan · doc
`GENERACION_FACTURAS_CASOS.md` desactualizado.

**Brechas vs mejoras**: M1 (moneda de facturación y FX al crear: no existe) · M4 (tipo de documento: no existe) · M5
(indefinido: todo depende de `term_months`) · M12 (devengo de no recurrentes: sin modelo) · M16 (workflow de
aprobación: existe pero no se usa como aprobación) · Medios #7 y #11.

**Decisiones de Domi (23-09) — reglas de S1:**

| # | Tema | Decisión |
|---|---|---|
| S1-1 | Número de contrato | Correlativo automático por **compañía y prefijo**; manual solo si no choca (UNIQUE). Resolver los 2 duplicados actuales |
| S1-2 | Moneda por ítem | Multimoneda real (M3) como etapa propia en S6; mientras tanto el ítem **hereda** la moneda del contrato (sin selector que la base rechaza) |
| S1-3 | Moneda de facturación y FX de facturación | **Se piden al crear**, con default = moneda del contrato + spot |
| S1-4 | Términos de pago | Default = el de la **razón social** (`client_entities.payment_terms`, ya diseñado); editable por contrato; se propaga desde la cotización y calcula el vencimiento |
| S1-5 | Auto-renovación desde cotización | Si la usuaria la desmarca, **se respeta** (corregir el trigger de herencia) |
| S1-6 | No recurrentes | La usuaria **elige** el devengo: al facturar · por % de avance · lineal en el término. Investigar benchmarks de rev rec antes de diseñar |
| S1-7 | Tipo de documento | **Selector desde ya** al crear, con valor sugerido; diseñado para crecer a la matriz fiscal completa (M4 / Complejos #4) |
| S1-8 | Plantilla y cláusulas | **Oculto** por ahora; se desarrolla al final (plantillas por compañía con campos variables del contrato) |
| S1-9 | Workflow de aprobación | Por ahora solo **Borrador → Activo**; el workflow configurable queda apagado (ver recomendación en sesión; investigar benchmarks) |
| S1-10 | Agrupación juntas / por ítem | Define si los ítems de un contrato se facturan juntos o separados según su frecuencia. El cronograma con ítems anidados (`contract_item_details`) **funciona** (verificado: 1 factura por cuota, 1 línea por ítem). Falta **guardar la elección en el contrato** para que la respeten las regeneraciones y modificaciones |
| S1-11 | Redondeo | 2 decimales; **la diferencia va en la última cuota** (sin lógica por moneda) |
| S1-12 | Validaciones | Se exige siempre: producto, tipo de ítem, frecuencia, inicio y término — o **término indefinido** (M5). Rediseñar la captura de precios (unitario mensual/anual, etc.) **sin eliminar campos de la base**, mostrando menos (como los mockups del front nuevo). Investigar benchmarks |
| S1-13 | Booking | Booking = fecha de **cierre del negocio** (métrica CMRR); inicio del servicio = cobro, devengo y MRR. Desde cotización: la booking de la cotización; manual: la fecha de activación; **siempre editable** |
| S1-14 | Duplicar contrato | **Se quita** |
| S1-15 | Flags multimoneda / multicompañía / requiere referencias | Se definen al crear y son parte del diseño de M3/M10 y OC/HES (A.11) |
| S1-16 | Moneda del contrato vs consolidación | Idea de Domi: con multimoneda real, en vez de "moneda del contrato" usar la **moneda de consolidación** para las métricas del contrato, con FX (p. ej. fijo) por ítem. **Por investigar** antes de decidir |
| S1-17 | Política FX de moneda de compañía (devengo RSM y asiento) | Se define **al crear** cuando la moneda del contrato ≠ la de la compañía; default **promedio mensual** (norma contable para resultados), con opción de FX fijo cargado en el mismo paso |

Desde cotización → contrato nuevo **funciona bien** (precarga correcta); solo se ajusta lo de arriba.

**Precisiones de Domi (23-09, segunda ronda):**
- **S1-18 · Condiciones futuras pactadas al crear**: ajustes de precio acordados desde el inicio (aumento o
  disminución en el año 2, ajuste anual de X %, renovación automática con % de ajuste). Afectan ítems (categoría y
  momentum) y facturas futuras. Conecta con Estratégico #25 y con las fases de A.4 (ramps). Se diseña con S3.
- **S1-6 / M6**: la granularidad del devengo (diario / mensual) es **por compañía**, no por ítem ("Configuración de
  Reglas de Reconocimiento").
- **S1-12**: confirmado: agregar la **frecuencia del precio unitario** (precio pactado anual, mensual…) separada de la
  frecuencia de facturación (ej. 20.000 USD anuales facturados mensual). Hoy existe a medias (`price_entry_mode`
  anual, casi solo en el front).
- **S1-16 (corregido)**: la moneda de consolidación **ya existe** (moneda del sistema en contratos, RSM y KPIs); no
  hace falta una "moneda de métricas" nueva. Multimoneda aplica **solo** cuando ítems en distintas monedas se
  facturan **juntos** en una misma moneda de facturación (ej. UF + USD). Si se facturan separados, lo normal son
  contratos separados (como hoy). Un contrato puede volverse multimoneda después (p. ej. un cross-sell en otra moneda
  que se factura junto). Reemplaza la unificación de contratos por moneda.
- **S1-17**: promedio mensual por defecto con opción de FX fijo, **sin** advertencia de volatilidad.
- **M9 (a S5)**: en el RSM, lo **facturado** debe registrarse en moneda de compañía al FX de la fecha de factura (o el
  monto en moneda de factura si coincide con la de compañía), y lo **devengado** al promedio mensual; la diferencia
  entre ambos, que deben cuadrar en moneda de contrato, es **diferencia de cambio**. No bloquea creación ni activación.
- **S1-7**: aceptado el matiz: tipo de documento **sugerido desde la razón social receptora**, editable en el contrato.

### S2 · Activación, estados y vencimiento — ✅ decisiones tomadas 23-09 (queda por investigar S2-12 pausa)

**Activación masiva** (el camino real, `BulkActivationModal` → `bulk_activate_contracts`): valida holding, estado y
FX de compañía confirmado; **no valida `tax_rate`**. El botón "Confirmar FX y continuar" llama
`bulk_confirm_fx_policy(ids,'monthly_avg')` fijo → **pisa un `fixed_period` ya elegido**. Una fila de historial por
contrato (dos si tenía paso de workflow).
**Activación individual** (`AdvancedWorkflowDialog` → `mark_contract_signed_safe`): el front valida FX y `tax_rate`;
la función **no valida estado** (puede reactivar un Cancelado); después, fuera de la transacción, el modo `auto`
**pisa la booking con hoy**.
**Lo que dispara `status='Activo'`** (orden verificado en prod): booking si es null → facturas
(`generate_missing…`, el segundo trigger se salta) → auditoría → FX a **sistema** → rebuild RSM. El FX a **compañía**
no se calcula al activar (la versión que lo hacía no tiene trigger; el RSM lee la política).
**Fallas silenciosas**: sin `tax_rate` o sin cronograma → **Activo sin facturas** y la masiva lo informa como éxito
(0 casos hoy, posible por código); RSM y FX de sistema fallan con solo un WARNING.

**Cancelación**: solo por churn total (`apply_contract_contraction`); cancela el cronograma desde la `churn_date`.
**No existe reactivar/revertir churn** (S08255 se revirtió hoy por SQL). **Borrado**: físico desde el navegador;
permite borrar **En revisión y Cancelado**; lo frenan las FK de facturas/RSM; los borrados En revisión no quedan
auditados (28 borrados auditados, todos por SQL).

**Vencimiento**: nada cambia el estado; `auto_expire_contracts` no tiene llamador (Expirado = 0). "Vencido" es solo
visual en el front. **15 contratos Activo con todos sus ítems recurrentes vencidos** (uPlanner 10, TiMining 3,
SimpliRoute 2) y 41 ítems vencidos sin renovar ni churn.

**Auto-renovación** (cron 02:00 → `process_auto_renewals(90)` → `create_contract_renewal` v2): **causa confirmada**:
v2 exige usuario de sesión y el cron no lo tiene → "Usuario no encontrado" en todos. Otros defectos: no filtra estado
(1 de 11 candidatos es de un Cancelado), pierde para siempre los ítems que vencen sin ser procesados, vencimiento +30
fijo, hereda `auto_renew` aunque se desmarque, y **no hay control en el contrato para verla o apagarla**.
⚠️ **Riesgo al arreglarla**: 290 ítems `auto_renew` (casi todos SimpliRoute) vencen dic-2026/ene-2027 y entran a la
ventana de 90 días desde ~**02-10**: se renovarían en masa justo antes del ajuste anual de precios. Hoy el cron falla,
así que **no hay riesgo mientras nadie lo arregle**.

**Pendiente de Renovar**: `apply_pending_renewal_tail` (trigger + cron 06:00) proyecta en el RSM un término más de
MRR sin devengo para ítems vencidos sin decisión; alimenta la tarjeta y el waterfall. No revisa el estado del contrato
(1 contrato En revisión con filas; la doc dice lo contrario).

**Workflow**: Hanka 5 pasos, SimpliRoute 3 (0 con aprobación), uPlanner 4; "Avanzar" no activa, solo "Firma";
la masiva lo ignora; al abrir el diálogo se asigna el primer paso a cualquier contrato sin workflow completo (4 Activo
con paso asignado).

**Otras evidencias**: 4 Cancelados con 6 Por Emitir vivas; 105 cuotas Programada vivas en 44 Cancelados; 55 Activo
con booking posterior al inicio del primer ítem; 48 Activo con moneda ≠ compañía y FX de compañía sin confirmar
(activados por caminos que no validan); 12 `fixed_period` sin tasas.

**Decisiones de Domi (23-09) — reglas de S2:**

| # | Tema | Decisión |
|---|---|---|
| S2-1 | Vencimiento | Ítem sin auto-renovación queda "Pendiente de renovar"; cuando vencen **todos** los ítems el contrato pasa a Expirado, **reversible y con avisos**; cancelar/expirar como definitivo pide confirmación (Expirado puede nacer como "por confirmar") |
| S2-2 | Auto-renovación | **Propone** la renovación N días antes y la usuaria confirma; con término indefinido (M5) muchos ítems dejan de necesitarla. **Nunca** sobre ítems ya renovados, cancelados, con churn o sin auto-renovación (clave para agentes y notificaciones) |
| S2-3 | Anticipación | Configurable por holding, **30 días** por defecto; revisar filtros y dashboard |
| S2-4/5 | Casos por holding (290 ítems SimpliRoute, 15 contratos vencidos) | **No se ejecuta nada por holding en esta sesión**: sirven de ejemplo; se resuelven con la regla general |
| S2-6 | Bloqueos al activar | Bloquean: compañía sin `tax_rate` y contrato sin cronograma (`contract_invoices`; no debería pasar nunca, pero queda como guarda) |
| S2-7 | Booking al activar | Nunca se toca si ya existe (coherente con S1-13, que además la guarda desde la cotización) |
| S2-8 | Revertir churn / cancelación | Acción **Reactivar** con motivo, que restaura ítems y Por Emitir; cuidando las fechas (inicio, cortes, pausas: con ellas se devenga y se planifican facturas) |
| S2-9 | Borrado | **Solo en Borrador** y lógico (queda registrado). Activo/Cancelado nunca se borran |
| S2-10 | Pendiente de renovar | Se excluyen contratos Cancelado y Borrador |
| S2-11 | Workflow configurable | **Ocultar** (se conservan datos); limpiar los 4 Activo con paso asignado |
| S2-12 | Pausar / reactivar | Acción propia (no una modificación), también masiva: pausa el reconocimiento y deja el MRR en un estado especial. **Investigar cómo lo hace la industria** (Complejos #9) |
| S2-13 | Fecha de vencimiento del contrato | Debe ser la **más próxima** de sus ítems (no la última), que es la que usan filtros y alertas ("próximos a vencer", Tanda 2) |
| S2-14 | Transición de estados | Duda de Domi: triggers y funciones usan estados como Firmado; cambiar sin romper el front actual → ver estrategia de transición en la sesión 23-09 |

### S3 · Modificaciones — ✅ decisiones tomadas 23-09

Benchmark: [`benchmarks/benchmark-modificaciones-pausa-escalamientos.md`](./benchmarks/benchmark-modificaciones-pausa-escalamientos.md).
**Manual de funcionamiento caso por caso** (segunda vuelta, fórmulas y ejemplos): [`manual-modificaciones-contratos.md`](./manual-modificaciones-contratos.md).

#### S3b · Desde el contrato (menú "Modificar contrato", solo en Activo)

| Acción | Cómo escribe | ¿Atómico? | Lo más relevante |
|---|---|---|---|
| Upsell (`UpsellingModal`) | Inserts directos en 5 tablas; `categoria='UPSELL'` fija | No | Merge por mes de **emisión**; `due = emisión`; moneda del ítem con fx=1 (ignora `invoice_currency`); **el evento de Historial falla siempre** (`created_by NOT NULL` no enviado, `:919-940`) y el amendment va sin `requested_by` → 8/8 sin rastro (causa del duplicado S04191); primera factura prorrateada con período mal calculado y cuotas truncadas; el modo "alineado al ítem base" lo pisa el trigger de `end_date` |
| Cross-sell | RPC → `approve_contract_amendment` rama CROSS_SELL | Sí | Ignora "Vencido"; merge por emisión **sin excluir unificadas**; `due = emisión`; plazo 12 por defecto sin acotar; manda el **booking** como fecha efectiva; `recalc_revenue_for_contract` borra el cronograma editable; `reconcile_contract_status` puede pasar el contrato a "Terminado" (1 expuesto) |
| Churn / downsell total | `apply_contract_contraction` | Sí | Cancela Por Emitir **enteras** (incluye líneas de otros ítems); prorratea por días; NC nace Emitida; rebuild RSM. **NC de churn con conversión en la moneda equivocada** (copia el subtotal en moneda contrato al campo de moneda factura, `:400, 430-431`) → **13 NC en prod** (p. ej. −21,78 "CLP" contra 889.600 CLP); ninguna enviada a Odoo |
| Downsell parcial / renegociación | `apply_quote_downsell_to_contract` | Sí | Sin prorrateo del período en curso; renegociación exige inicio de ciclo; **único** lugar que extiende `contract_end_date`; renegociación con 0 usos |
| Renovación (3 modales) | `create_contract_renewal` v2, **una llamada por ítem** | No entre ítems | **`export_type = 1` fijo** (`:445, 529`) con IVA de la compañía → **137 de 150 Por Emitir de renovación** en exportación, ≥ 53 domésticas (es la ruta que Complejos #4 buscaba); `+30` fijo; último período parcial cobrado completo; **no actualiza `contract_end_date` ni `total_value`** (27/33 ítems renovados terminan después del fin del contrato; la doc dice lo contrario) |
| Editar ítems (post-firma) | UPDATE directo + `sync_invoices_for_contract_item` | No (el ítem queda aunque la sync falle) | Solo corrección; sin evento; bloqueos explicativos |

**Tanda 3 #1 precisado**: no es "usa el booking": la función recibe una sola fecha; el ítem CHURN arranca el **día 1 del mes** de esa fecha, mientras `churn_date`, cortes y NC usan el día exacto → 20 de 51 contratos cancelados con `churn_date` ≠ inicio del ítem CHURN. En ciclos día 28/13/15 la fecha tipeada es correcta para facturar y lo que queda mal es el devengo.

**Piezas repetidas** (insumo para el flujo único M2/A.4): 6 generadores de períodos/facturas (2 front, 4 SQL) con frecuencias, vencido, vencimiento, `export_type` y residuo distintos; 3 criterios de prorrateo; merge por emisión vs reescritura por período; encabezado = Σ líneas con función vs a mano; categoría fija vs calculada; historial con función vs insert directo (tipos desordenados); `total_value` de 4 maneras. Pieza reutilizable: **cortar el ítem en la frontera de lo facturado** (renegociación y `sync`).

#### S3a · Desde cotización ("Asociar a contrato existente", `AssignToContractModal`)

**Cómo funciona**: lista contratos **Activo y En revisión**; la categoría sale del **tipo de cotización** (todo lo
que no sea down/cross/reactiv → UPSELL, incluido "NewBusiness"); fin = `quote_items.end_date` tal cual; método,
frecuencia, moneda y **tipo de ítem** de la cotización; "Revisar facturas" calcula con **IVA 0,19 fijo**
(`AssignToContractModal.tsx:575`). Tres ramas: downsell/renegociación por RPC (atómica, **ignora el preview**, no crea
amendment y pasa parámetros corridos a `log_lifecycle_event`); upsell/cross-sell (y downsell mezclado) **escrito desde
el navegador sin transacción** (ítem → UPDATE de `end_date` que evita el trigger → TV → **fusión con Por Emitir por
fecha de emisión exacta, sin filtrar unificadas** → factura nueva con `due = emisión`, moneda de la cotización, fx 1 →
líneas → UPDATE anti-standardize → amendment → evento opcional).

**Causas de las evidencias (corrige el roadmap en 2 casos):**

| Evidencia | Causa real |
|---|---|
| 23-09 #1 período "1 a 1" en líneas | `invoiceCalculator.ts:193, 210` no resta el día (la rama proporcional sí) |
| 23-09 #1 `end_date` al día 1 | Viene de la cotización: **la sincronización de Salesforce calcula `inicio + plazo` sin −1** (`salesforce-sync-complete.service.ts:1956-1963`, 165 de 260 ítems desde mayo); el modal lo fuerza con UPDATE. Vivos: 204 WSP STD, S02762, S07276, S07866 |
| 23-09 #2 Bosch anclado al booking | El modal sí heredó el ciclo; **el ancla 08→07 la introdujo "Editar ítems"** 2 minutos después (reenvía inicio y plazo, el trigger recalcula el fin). ⚠️ El arreglo de data del 23-09 **se deshizo**: el ítem hoy termina 07-01-2027 (trigger al cambiar el plazo) |
| 23-09 #2 plazo sin acotar | Sin ítem relacionado o en "Precio final" no se amarra el fin; con prorrateo, plazo = meses + 1 infla el total (Bosch 239,55 vs 180,46). 20 de 44 ítems terminan después del contrato |
| 23-09 #2 Fijo vs Variable · UPSELL vs CROSS-SELL | `item_type` de la cotización; categoría por tipo de cotización, sin validar UPSELL de producto inexistente → 7 ítems; **los 39 amendments desde cotización son UPSELL** |
| 23-09 #8 one shot | No nace aquí (genera 1 factura); riesgos propios: comparación `'anticipado'` en minúscula nunca calza; total × plazo 12 por defecto |
| 22-09 (a) merge | Por **fecha exacta** sin mirar período ni tipo de factura → CTR-2026-197 con 6 Por Emitir de dos meses mezclados |
| 22-09 (b) método ignorado | **No es el modal**: los ítems de BAT nacieron Vencido; un guardado de **"Editar ítems"** 12 minutos después los pasó a Anticipado |
| 22-09 (c) upsell sin facturas | **No es el return silencioso**: el contrato estaba **En revisión**, el modal le creó 12 Por Emitir solo del upsell, y al activar `generate_missing…` **se saltó el contrato porque ya tenía facturas** → el ítem base quedó sin facturas. 4 asignaciones sobre contratos sin facturas previas |
| 22-09 (d) agrupación | No existe el control |
| Complejos #1 moneda de facturación | Factura nueva en moneda de la cotización y fx 1 → 2 encabezados CLF en contratos que facturan CLP y **28 líneas CLF dentro de facturas CLP** |
| Complejos #1 vencimiento | `due = emisión` → 71 Por Emitir con vencimiento ≤ emisión |

**Hallazgos nuevos**: (1) **IVA fijo 19%** en las líneas (standardize respeta el IVA informado) → **129 líneas en MX (16%) y 37 en PE (18%)**, 154 aún Por Emitir, + 21 en facturas exentas; (2) el downsell **por precio** desde cotización se ejecuta como downsell por cantidad completa (la UI lo ofrece pero la RPC no recibe `new_monthly`); (3) el downsell permite quitar el 100% (debería ser churn); (4) renegociación copia el FX de la última factura (viola "PE con conversión nace NULL").

**Decisiones de Domi (23-09) — S3, primera ronda:**

| # | Tema | Decisión |
|---|---|---|
| S3-1 | Asociar cotización a contrato En revisión | **No**: solo contratos Activo |
| S3-2 | Método de facturación del upsell si la cotización dice otro | La usuaria elige; **default el del padre/contrato** |
| S3-3 | Cotización "Nuevo cliente" sobre contrato existente | **Se bloquea** y se pide contrato nuevo, con **validador** que detecta si el cliente ya tiene contratos/MRR activos (error de etiqueta en el CRM) y deja elegir |
| S3-4 | Fecha efectiva por defecto | **Inicio del ítem cotizado** (ya funciona así); la booking va aparte |
| S3-5 | Prorrateo a mitad de ciclo | El día exacto manda. Hay un desarrollo específico de prorrateo por días para inicios distintos al ciclo: aplica a **upsell y cross-sell**. **Downsell sin prorrateo** (hoy lo permite y genera NC por los días, y ha causado más errores que otra cosa) |
| S3-6 | Downsell / renegociación a mitad de período | Igual que S3-5 |
| S3-7 | Downsell del 100% | Se deriva a churn/contracción. **Hoy no funciona así** (la función acepta quitar todo: 2 casos) → corrección |
| S3-8 | Renovación de varios ítems | Una sola operación atómica |
| S3-9 | Reactivar | También ítems individuales con churn o contraídos |
| S3-10 | Aprobación de modificaciones | Eliminar; el diseño inicial quedó obsoleto y requiere **limpieza completa** |
| S3-11 | Fin del contrato | El **más próximo** de los ítems recurrentes no renovados ni cancelados (S1/S2-13) |
| S3-12 | 8 upsells sin evento | No se tocan aquí (otra sesión); foco de esta: auditoría y rediseño |

**Observaciones de Domi a las reglas propuestas**: (3) herencia del contrato = **defaults, no reglas duras** (p. ej. un
cross-sell en otra moneda que se factura junto: multimoneda); (4) agrupación/merge de facturas y (8) editar ítems
**tienen una base de referencia** que hay que describir bien, no solo sus bugs → **segunda vuelta de S3** antes de S4,
con el funcionamiento completo de cada caso (cantidad, precio unitario, renegociación, ítem madre, prorrateo).

#### S3 · Segunda vuelta (A) — Agrupación y fusión de facturas: la base de referencia

**Lo definido y desplegado**: (1) la unidad de agrupación es el **mes de emisión** (YYYY-MM); en el asistente "juntas"
comparten factura con la fecha más temprana y "por ítem" agrega el ítem a la clave (`revenueScheduleUtils.ts:43-72`);
`group_invoices_by_period` existe (691 true / 3 false) pero no se guarda la elección. (2) **Regla de fusión**
(UpsellingModal, `2f6ab4f`): se suma a una Por Emitir del mismo contrato y mismo mes; **se excluyen** emitidas, legacy,
inactivas (absorbidas por unificación) y Unificada/Consolidada — un documento unificado nunca se edita directo, primero
se desconsolida (`orden-operaciones-facturacion.md:34-43`). (3) **Una línea por ítem** mapeada con `source_key`;
excepción deliberada: el **modelo neteado** (downsell y renegociación modifican la línea del ítem base, el ítem delta
no factura). (4) Encabezado = Σ líneas (`_recalc_invoice_header_from_items`) con la convención fx NULL. (5)
`standardize` pisa toda línea insertada con `contract_item_id` → patrones A (insert+update) o B (FK diferida). (6)
**Vencido emite al inicio del período siguiente** → agrupando por mes de emisión, la factura del mes M junta anticipados
del período M con vencidos del M−1: consecuencia de diseño (HAP la aceptó; BAT la reclamó) → **decisión pendiente**.
(7) Moneda: nace en `contracts.invoice_currency` (fx 1 misma moneda / NULL con conversión). (8) Prorrateo "Opción B":
primera factura hasta el ciclo, luego alineadas; el diseño compara con el **ítem relacionado**, el código con el
`MIN(start_date)` del contrato (brecha).

**Quién respeta la base**: renegociación misma frecuencia y downsell clásico (netean en la línea base) ✅ ·
UpsellingModal (mes de emisión y exclusiones ✅; período de línea corrido en Vencido, encabezado incremental, `due =
emisión`, moneda del ítem ❌) · AssignToContract (**fecha exacta**, sin exclusiones, dos servicios nuevos nunca comparten
factura, IVA 0,19 ❌) · cross-sell SQL (mes ✅; sin exclusiones, ignora Vencido ❌) · renovación SQL (**nunca fusiona**:
N facturas en la misma fecha ❌) · renegociación con cambio de frecuencia y editar ítems (facturas **propias**, nunca se
funden ❌).

**Regla propuesta** (para validar): clave = (contrato, receptor, moneda de facturación, tipo de documento, mes de
emisión) + ítem si el contrato factura "por ítem"; candidatas solo Por Emitir activas, no legacy, no
unificadas/consolidadas, sin conciliar ni NC (si cae en una unificada → bloqueo explicativo); fusionar = agregar líneas
(salvo delta neteado); período de la línea = período de servicio de su ítem con **una sola función**; encabezado = Σ
líneas con una sola función y protección de standardize; la factura nueva hereda moneda/política, tipo de documento,
vencimiento e IVA del contrato; preview que diga "se suma a la factura X / se crea nueva".

#### S3 · Segunda vuelta (B) — Editar ítems en contrato activo

**Política vigente**: editar = **corrección de errores**; lo comercial va por Modificaciones (reunión TiMining 29-07,
formalizada por Domi: flujo de excepción, solo períodos abiertos, muy usado en onboarding). En el front: ítems nuevos
solo NEW/RENEWAL, candado por períodos cerrados; **nada impide un cambio comercial** (`canEdit` fijo en true).
**Cómo guarda**: reenvía **todos los campos de todos los ítems** → el trigger recalcula `end_date = inicio + plazo − 1`
en cada guardado (**causa de Bosch** y de fines alineados perdidos); solo sincroniza ítems con cambios contables
(`account` no está en la lista: cambiar solo la cuenta no regenera glosas [no verificado en uso]); orden sin
transacción: moneda → UPDATE → INSERT → delete → TV desde el front → sync ítem por ítem.
**`sync_invoices_for_contract_item`**: permiso + holding + lock; solo contratos Activo/Cancelado/Expirado; bloqueos
explicativos (documento unificado, cantidades variables, emitido > total, sin períodos pendientes); **emitidas =
ancla** (incluye conciliadas o con NC/ND); reparte lo pendiente **parejo** con el residuo al último (sin prorrateo ni
no recurrentes); **reusa líneas por posición** (no por período) y en facturas compartidas conserva la fecha;
**períodos sobrantes → facturas propias que nunca se funden**; valida continuidad y revierte la sync (el ítem ya quedó
guardado). Uso real: 21 syncs (15 en facturas compartidas).
**Riesgo inferido**: sincronizar un ítem base neteado por downsell/renegociación **deshace el neteo**.

**Propuesta para el rediseño**: preview + una transacción + evento "Corrección"; enviar solo campos cambiados (el fin
como campo explícito); campos de corrección (glosa, cuenta que regenera glosas, tipo, unidad, custom fields, booking;
cantidad/precio/descuento si corrigen un error de carga; fechas y método sin emitidas en el rango); **derivar a
Modificar** cuando cambia el MRR con fecha posterior al inicio, hay emitidas afectadas, cambia frecuencia o se extiende
el plazo, se agrega un producto nuevo o se elimina un ítem con emitidas; bloquear edición de ítems delta y bases
neteadas; la sync empareja por período y usa la regla de agrupación de arriba; cantidades variables con la opción (a)
de Complejos #2; TV y fin recalculados en la base.

**Decisiones de Domi (23-09) — S3, segunda ronda:**

| # | Tema | Decisión |
|---|---|---|
| S3-13 | Vencido del mes anterior + Anticipado del mes en la misma factura | **Válido** (agrupar por mes de emisión funciona bien; el reclamo de BAT es particular de su cliente) |
| S3-14 | Upsell en la factura | Opción de **línea neta** también en upsell (8 + 2 → una línea de 10), igual que el downsell modifica la línea base. El ítem de ajuste se conserva para trazabilidad y métricas |
| S3-15 | Renovación con cambio de precio | Un solo **modelo de negocio**: renovación al precio anterior + ajuste explícito (diseño de Domi). `apply_renewal_price_split` **no es otro modelo**: es el **camino corto** (renovar con precio nuevo en un paso, sin renovar y luego modificar) — hoy lo guarda como 1 RENEWAL al precio nuevo + `renewal_base_unit_price` + split en el RSM, mientras la renegociación guarda RENEWAL al precio anterior + ítem de ajuste. **Propuesta (por confirmar)**: mantener el camino corto como experiencia y que por debajo guarde la misma estructura explícita (2 ítems), para que ítem madre, historial y waterfall vean un solo modelo |
| S3-16 | Día de ciclo del contrato | **Dato explícito** del contrato (hoy derivado del `MIN(start_date)` en 2 copias). También aclara la UI: ciclo de facturación / período de servicio ≠ fecha de emisión |
| S3-17 | Primer tramo proporcional | **La usuaria elige**: factura suelta de inmediato o en la factura del siguiente ciclo (Stripe: default próxima factura, `always_invoice` = inmediata) |
| S3-18 | Editar ítems con cantidades variables | Ya se permite (mejoras recientes) **respetando las cantidades variables registradas** aunque no calcen con el ítem; puede tener bugs → confirmar con benchmark |
| S3-19 | Tipo de ítem | **Master data por holding** (Fijo/Variable son los de SimpliRoute, no una regla). El ajuste hereda el tipo del padre, sea cual sea el catálogo |

**Principio de diseño (Domi)**: la base es transaccional a propósito (categoría y momentum para métricas y reportes),
pero **la UI y la forma de modificar deben ser simples** — por eso existe el ítem madre (que la usuaria no sume ni reste
mentalmente). Simple para la usuaria, con trazabilidad completa y flexibilidad para las casuísticas.

**Editar ítems y cierre de períodos**: editar es flexibilidad para corregir errores; lo que lo acota es el **cierre
mensual de períodos**, buena práctica a potenciar (avisos, notificaciones, o cierre automático N días después de fin de
mes, configurable) → va en Configuraciones.

**Caso de referencia (no se corrige aquí)**: CTR-2026-884106 — la usuaria hizo un downsell para eliminar un upsell que en
realidad debió ser cross-sell; el sistema le **canceló todas las facturas** y tuvo que emitir sueltas. Sea error de
ingreso o bug, muestra por qué hay que simplificar: coincide con "la contracción cancela la PE completa, incluidas líneas
de otros ítems" y con la clasificación upsell/cross-sell por tipo de cotización. Además hay triggers y funciones viejas
que pueden pisar registros que estaban bien.

**Unificadas y consolidadas**: Domi evalúa eliminarlas con el nuevo diseño (ruta de facturación declarada, A.5) → S4.

**Reglas propuestas (S3b)**: una fecha efectiva deriva todo · prorrateo por días según la granularidad de la compañía, igual en todas las acciones · preview + una transacción · evento siempre, con usuario, motivo y tipo normalizado · encabezado coherente (TV, fin según S2-13, term) · las facturas heredan moneda/política, ciclo, método, vencimiento (S1-4) y tipo de documento (S1-7) · agrupar por período excluyendo unificadas · plazo acotado al contrato (D-B) · Reactivar (S2-8) · Pausa (S2-12) · condiciones futuras pactadas (S1-18) · editar ítems solo corrige.

### S4 · Facturas del contrato — ✅ decisiones tomadas 23-24/09

Benchmark: [`benchmarks/benchmark-facturacion-agrupacion-edicion.md`](./benchmarks/benchmark-facturacion-agrupacion-edicion.md).

#### S4a · Motor de facturas (cómo nace y se mantiene una Por Emitir)

**Datos maestros verificados**: frecuencia (`Mensual|Trimestral|Semestral|Anual|Bianual`) y método
(`Anticipado|Vencido`) son un **CHECK fijo**, no master data; `item_types`, `payment_terms` (texto) y unidades **sí** son
master data por holding. `contracts` no tiene condiciones de pago ni día de ciclo; el generador no lee
`client_entities.payment_terms`.

**Ciclo**: cronograma `contract_invoices` (JSON por ítem, **sin período**) → al activar, `generate_missing…` crea una
factura por cuota → mantenimiento por sync de ítem, Reestructurar, overrides de cantidades, Reestructurar fechas masivo y
reagendar → emisión (S4b). **El cronograma queda congelado después de activar** (nadie lo actualiza; 4.917 "Programada"
para siempre): SimpliRoute 133/501 contratos con cronograma ≠ ítems.

**Generación** (`generate_missing…`): dos triggers idénticos; se salta el contrato si existe **cualquier** factura (también
legacy → caso 22-09 c); fallos tragados. Encabezado = monto de la cuota; IVA de la **compañía emisora**; `due = +30`;
`FACTURA`/export 0/serie FAC fijos; con conversión fx y montos en moneda de factura NULL. Líneas: descripción con cuenta;
frecuencia por `LIKE` (**Bianual → 12**); período derivado de la emisión (en "juntas" un ítem que parte el 15 recibe el
período del 1); **standardize pisa la línea al monto estándar** → encabezado ≠ Σ líneas cuando la cuota no es estándar
(tramo, residuo, descuento en monto o anual). Ej.: CTR-2026-116 perdió el descuento en 12 PE.

**Overrides de cantidades** (triggers de `quantities`): ajustan las líneas del mes (`unit` mensual: en líneas trimestrales o
anuales quedarían en el valor de un mes [no verificado]); al borrar un override restauran usando `discount_value` como %
aunque sea monto fijo; `update_pending_invoices_on_override` está muerta.

**Reestructurar** (V4): modos Reorganizar / Ajustar períodos / Ajustar montos, más acciones por producto. El front manda
**todas** las PE y líneas en `p_target_state`; la RPC mueve fechas (sin recalcular vencimiento), clona encabezado en
facturas nuevas (**vencimiento NULL** → 18 PE), descompone el bruto con la tasa de la factura destino, **fija `qty =
contract_items.quantity`**, borra lo que quedó fuera, recalcula encabezados y valida continuidad (rollback si falla).
**Continuidad**: esperado = `final_price` + ajuste por overrides; real = cada línea vale **el encabezado repartido en
proporción** (salvo unificadas); huecos, solapes, cola y exceso; tolerancia 0,01 × n. El front tiene un validador espejo.

**U1 (causa exacta)**: `invoice_reschedule_items:163-165` usa siempre la cantidad del ítem y, como el front reenvía todo,
**cualquier guardado** reescribe la cantidad de toda línea legítimamente distinta: overrides (Salvador) **y líneas netas de
downsell/upsell** → **53 PE en 12 contratos de SimpliRoute en riesgo** (S04620 2→10, CTR-2026-212, S06461, S02656). Arreglo:
conservar cantidad, unitario y descuento de la línea si no cambió su período ni su monto; si cambió, cantidad = override del
mes → la de la línea → la del ítem; y poner vencimiento en las facturas nuevas.
**U2 (causa exacta)**: el validador reparte **encabezados**; F101-00004292 tiene encabezado −6.095,88 bajo sus líneas
(callback de Odoo, que la decisión registrada acepta como vía deseada) → todos los productos fallan ~3,4%. Además la venta
única de Alicorp está en **3 documentos emitidos** (Δ −9.298,64 y solapes): leer líneas **no** alcanza. Arreglo recomendado:
**"no empeorar"** (bloquear solo si un ítem pasa de ok a no ok, crece el Δ o aparecen huecos/solapes nuevos; lo heredado
como aviso con "Ajustar a lo emitido").

**Standardize**: existe para que la generación tenga `qty × unit` reales; pisa en INSERT; dependen de él `generate_missing`
(y una huérfana); se protegen reschedule, sync, consolidar (patrón A) y NC, conciliaciones, contracción (patrón B). En el
rediseño el generador único calcula la línea y el trigger desaparece o solo rellena lo vacío (Complejos #3, opción 4).

**Desvíos de la base**: 3 valores de Bianual (1 / 12 / 24) · 3 semánticas de `vat` en el encabezado · vencimiento +30 fijo
o NULL · sync y reschedule **clonan el fx** de la última factura (79 PE spot con FX pegado, 6 por clonación) · 68 PE
multimoneda en estado mixto (standardize copia el monto de contrato a moneda de factura) · regenerate ignora Vencido y no
reparte residuo · `group_invoices_by_period` sin UI.

**Qué debe cumplir el motor rediseñado**: un solo generador (día de ciclo explícito, frecuencias de una tabla con Bianual =
24, tramo proporcional solo en upsell/cross-sell valorizado sobre el período, agrupación guardada, redondeo único, línea
calculada por el generador y encabezado = Σ líneas, vencimiento desde condiciones de pago, tipo de documento del contrato y
receptor, multimoneda sin mezcla ni clonación, una semántica de `vat`) y decidir el rol del cronograma tras activar.

#### S4b · Operaciones sobre facturas

**Piezas compartidas que explican casi todo**: la línea sin moneda toma la del ítem aunque el header esté en otra
(`auto_populate_invoice_item_fields.sql:33`); standardize pisa montos (INSERT → UPDATE en cada función); el IVA del header
se copia de la compañía **solo si viene NULL** (no se recalcula al cambiar de compañía); la moneda de sistema lee la del
contrato; el trigger del RSM atribuye por línea (cubre unificadas).

| Operación | Para qué | Uso en prod | Lo relevante |
|---|---|---|---|
| **Unificar** (`unify_invoices_multi_contract`) | Un documento para varios contratos del mismo receptor | **14**, todas SimpliRoute, **siempre 2 contratos de distinta moneda** (CLF+USD, USD+PEN, CLP+CLF): se unifica porque un contrato no puede tener ítems en dos monedas | Valida receptor, moneda, mes, documento y export; valoriza por par de moneda de **cada línea**; header del contrato principal; **pierde las referencias OC/HES**; no copia serie ni `auto_invoice` |
| **Consolidar** (1 contrato) | Una modificación dejó 2 PE en el mismo mes | 24 (ninguna desde 06-08: **reemplazada por Reestructurar cronograma**, que permite juntar y mucho más — confirmado por Domi) | **No valida** holding, receptor, moneda ni documento; total 0 → Cancelada, negativo → NC; sin historial |
| Desunificar / desconsolidar | Deshacer | 4 | DELETE físico; **no mira `odoo_invoice_id`** (borrador huérfano en Odoo); no revierte el FX escrito en los orígenes |
| Editar PE (`edit_pending_invoice`) | Editar un borrador | **0** (su modal nunca se abre) | FX 1 en PE con conversión → pisa montos en moneda de contrato; no bloquea unificadas |
| Reprogramar (`reschedule_invoice_safe`) | Mover fecha | 1 (el camino vivo es un UPDATE directo sin permiso) | Solo cambia `scheduled_at` (el vencimiento puede quedar antes de la emisión) |
| Emitir (`bulk_emit…`, `emit_invoice_manually`) | Registrar emisión | Masiva: marca "Enviada" sin enviar a Odoo · manual 24, **división 0** | La división copia moneda de factura al campo de moneda de contrato; nunca divide si el header es NULL |
| **Ajuste a lo emitido** (`adjust_issued_invoice`) | "El documento legal manda" (Alicorp) | **0** | Diseño correcto (Σ emitido = header, diferencia a PE destino, override de cantidades) sin uso |
| **NC** (`create_credit_note_safe`) | Anular o descontar | 112 NC (57 anulación, 23 descuento), **0 ND** | Anulación: NC nace Cancelada + reemplazo Por Emitir; descuento: nace Emitida repartida por línea; **IVA del header en moneda de contrato**; `p_nc_fx_rate` en dirección inversa; **la API no envía NC (todo `out_invoice`)** — 3 NC de churn enviadas así; `cancel_invoice_with_credit_note` **rota** |
| Acciones masivas | Descripciones 228 · reasignar entidad 35 · términos 1 · FX fijo · moneda de factura (API, **fuerza `auto_send_to_odoo=true`**) · reset Odoo (no cancela el borrador: puede duplicar) · eliminar PE (DELETE) · **duplicar en cualquier estado** | — | Reasignar no actualiza RUT, IVA, export ni serie |

**U3 — causa exacta del $0 de BAT (corrige el roadmap)**: el guard **no mira el header**: compara la moneda **de la
línea consigo misma** (`contract_currency ≠ invoice_currency` de la línea). Las líneas W/D del cross-sell desde cotización
quedaron con moneda de línea **CLF dentro de facturas CLP** (origen S3a / trigger de moneda de línea) → par CLF→CLF, "no
convertidoras": ni se valorizan ni las detecta el guard; la API ve header CLP→CLP, no recalcula y manda `price_unit = 0`.
⚠️ **Riesgo vivo: 20 líneas futuras de CTR-2026-86** (oct-2026 a jul-2027) siguen así → cada unificación mensual lo repite;
+ 4 líneas USD en PE CLP de COD-04. Arreglo en 3 capas: guard línea vs header · normalizar moneda de línea al valorizar ·
la API no envía líneas NULL ni Σ ≠ header; + corregir el origen en S3a.

**Documento fiscal hoy**: generación `FACTURA`/export 0/+30; renovación export **1**/+30; sync export 0/+30; Reestructurar
clona otra factura con **vencimiento NULL**; unificar = primera factura + vencimiento máximo; manual cambia
`document_type` sin `export_type`; NC vencimiento = emisión. **La API**: `move_type` siempre `out_invoice`, tipo LATAM solo
Perú, **no usa el IVA de Sapira** (toma el del producto en Odoo + posición fiscal), no envía plazo de pago ni PPD/PUE.
**Dos fuentes de verdad** (API decide por `export_type`, el front muestra `document_type`). Evidencia (PE activas):
uPlanner 83 export 1 locales y 103 export 1 con IVA > 0; TiMining 80 FACTURA + export 1 (Sapira muestra IVA 19%, Odoo sin
impuesto); SimpliRoute 35 export 0 con países distintos y 60 con vencimiento ≤ emisión. Configuración: `tax_rate` por
compañía (**Lenosoft 0,19 en 2 compañías**, SimpliRoute Colombia 0), `payment_terms` por receptor (0 cargadas); **no
existen** tablas de tipos de documento, series ni diarios (`invoice_series` = 'FAC' por defecto).

**Decisión de Domi (23-09) — S4-1 · Facturar primero, decidir después**: "ajuste a lo emitido", "división al emitir" y
"editar PE" fueron **parches**: hoy la factura se ajusta a partir del contrato, las usuarias lo encuentran largo, a veces
no tienen toda la información y aun así necesitan facturar. Con la flexibilidad de
[`flexibilidad-con-trazabilidad.md`](./flexibilidad-con-trazabilidad.md) se **eliminan al final**: la usuaria edita el
**borrador libremente** (líneas, montos, fechas) sin modificar antes el contrato; el sistema registra el desvío (evento con
quién, qué y por qué) y **marca** el desbalance plan ↔ facturado (no bloquea); después se decide —con sugerencia, incluso
agéntica— si corresponde una modificación de contrato. "Menos pasos, mejor". Caso que queda: **Odoo emite distinto a lo
enviado** (la usuaria corrige allá) → el callback trae el detalle real y Sapira se alinea sola registrando el desvío (regla
15 de soporte, automatizada). Lo emitido sigue inmutable: solo NC/ND.

**Decisión de Domi (23-09) — S4-2 · Dos piezas para escribir facturas**: todo lo que crea, pisa o modifica facturas se
audita y se reduce a **dos** piezas: (1) **Generar**, simple, solo al activar (parte de cero desde el contrato: día de
ciclo, agrupación, condiciones de pago, moneda, tipo de documento); (2) **Aplicar cambios**, una sola pieza que recibe el
estado objetivo y aplica el **cambio mínimo** sobre lo existente respetando siempre: emitidas intocables · líneas no
afectadas no se reescriben (causa de U1) · ediciones manuales del borrador (S4-1) no se pisan sin confirmar · cantidades
variables registradas · líneas netas de downsell/upsell · agrupación y documentos existentes · convención de FX (NULL con
conversión, nunca mixto, nunca clonado) · encabezado = Σ líneas · evento con quién/qué/por qué. La usan: editar ítems,
todas las modificaciones, Reestructurar (objetivo armado a mano), cantidades variables, cambio masivo de fechas y editar
borrador. U1 se corrige igual en el corto plazo (Fase 1), pero su solución de fondo es esta pieza.

**Inventario a auditar y migrar** (hoy escriben facturas o líneas por su cuenta): `generate_missing_invoices_for_contract`
· `regenerate_contract_invoices_from_items` / `_for_restructure` (cronograma) · `sync_invoices_for_contract_item` ·
`invoice_reschedule_items` · `bulk_restructure_contract_start_dates` · `apply_contract_contraction` ·
`apply_quote_downsell_to_contract` · `create_contract_renewal` · `approve_contract_amendment` · `UpsellingModal` (inline) ·
`AssignToContractModal` (inline) · triggers de `quantities` (sync / restore) · trigger `standardize_invoice_items` ·
`unify_invoices_multi_contract` / `consolidate_invoices_simple` / `unconsolidate_invoices_simple` ·
`create_credit_note_safe` · `emit_invoice_manually` · `adjust_issued_invoice` · `edit_pending_invoice` ·
`reschedule_invoice_safe` · `apply_fixed_fx_to_contract` · `POST /invoices/bulk-update-currency` (API) ·
`invoice_reassign_entity` · `invoice_items_bulk_update_description` · `invoice_bulk_update_terms` ·
`reset_invoice_odoo_draft` · escrituras directas del front (cambiar fecha, eliminar PE, duplicar, estado de contrato que
dispara la generación). Destino de cada una: se absorbe en **Generar**, en **Aplicar cambios**, queda como operación
sobre documento emitido (NC/ND, callback del ERP) o se retira.

**Decisiones de Domi (23-09) — S4, primera ronda:**

| # | Tema | Decisión |
|---|---|---|
| S4-3 | Alcance de U1 | Conservar cantidades variables **y líneas netas** de downsell/upsell (53 PE en riesgo) |
| S4-4 | Cronograma (`contract_invoices`) después de activar | **(b)** Queda como **registro de lo firmado**; mandan las facturas Por Emitir |
| S4-5 | Reemplazo de la unificación | **(a)** Multimoneda en el contrato (M3) |
| S4-6 | Consolidar | Se elimina (ya reemplazado por Reestructurar cronograma) |
| S4-7 | Fuente de verdad fiscal | Un solo campo **tipo de documento**, del que se deriva la exportación, sugerido desde la razón social (S1-7) |
| S4-8 | NC de anulación | Enviarla a Odoo como **NC real** con reemplazo opcional — **ver con Leon** (integración Odoo y tipo de documento) |
| S4-9 | Nota de débito | Espera la **matriz fiscal** (Complejos #4) |
| S4-10 | Vencimiento de PE existentes al conectar condiciones de pago | **Solo las nuevas** |
| S4-11 | Frecuencias (Bianual hoy vale 1 / 12 / 24 según el camino) | **Una sola lógica para todo** el sistema (tabla única de frecuencias; Bianual = 24 meses) — por revisar al diseñar |
| S4-12 | Residuos de datos (1×total, CTR-2026-116, FX pegado, mixtas, sin vencimiento) | **No van en esta sesión**: sesión dedicada de soporte y datos en producción |

| S4-13 | U2 · validador de Reestructurar | **"No empeorar"**: bloquea solo si el cambio de la usuaria descuadra algo que cuadraba o empeora un descuadre; lo heredado (encabezado ≠ líneas por el callback, venta única triplicada) se muestra como aviso |
| S4-14 | Emisión parcial con división · emisión manual | Se quita la **división**. **Se mantiene la emisión manual** (marcar como emitida con folio externo): **2 de los 3 clientes no tienen integración con ERP activa** hoy, así que es un camino principal, no una excepción |
| S4-15 | Frecuencias y período de facturación | Criterio único (Bianual = 24 meses); el **período de facturación siempre muestra el período completo**; una sola forma de expresar precio × cantidad en la línea (propuesta: cantidad del ítem × unitario del período = precio mensual × meses) |
| S4-16 | Último período corto | **Proporcional** |

**Observación de Domi (24-09) — facturación no estándar y trazabilidad**: las opciones estándar (anticipado/vencido;
mensual, trimestral, semestral, anual, bianual) no cubren todo: hay contratos que se facturan en **% o cuotas en meses
distintos**; para eso nació Reestructurar cronograma, pero encajaría mejor con la **edición flexible** de la factura. La
razón por la que no se hizo así desde el inicio es la **trazabilidad**: saber cuánto se factura en moneda de contrato y a qué
ítem/producto. Regla: la descripción (glosa) es libre, pero **cada línea de factura sigue enlazada a su ítem de contrato**.
Industria: "billing schedule" por ítem (Zuora, NetSuite, hitos en Salesforce/Chargebee), independiente del devengo →
investigar junto con S5 (con la salvedad de que en EE.UU. no hay factura electrónica con folio).

**Si se reemplazan unificar/consolidar por ruta declarada (A.5)**: cubrir (1) un documento con varias monedas de contrato
y mismo receptor → contrato multimoneda (M3) y/o ruta a nivel de receptor que agrupe contratos, con FX por par definido
antes; (2) dos movimientos del mismo mes → la regla de fusión de S3 hace desaparecer consolidar; (3) documento distinto
por OC y reparto entre razones sociales (split por peso, OC/HES por factura, A.11); (4) tipo de documento, export, IVA y
vencimiento declarados en la ruta con **una sola fuente de verdad que la API respete**. Sobreviven: NC, **ND nueva**
(enviadas como `out_refund`), ajuste a lo emitido, editar PE con preview, registrar emisión externa, mover fecha
recalculando vencimiento, reset de Odoo que cancele el borrador, descripciones masivas, cambio de receptor/emisor como
cambio de ruta con historial. Se retiran: unificar/consolidar/desunificar, `invoice_type` Unificada/Consolidada, estados
Consolidada/Dividida, `cancel_invoice_with_credit_note`, `emit_invoice_safe`, `get_next_invoice_number` y caminos muertos.
Los 38 documentos históricos quedan de solo lectura.

### S5 · RSM y devengo — ✅ decisiones tomadas 24-09

Benchmarks: [`benchmarks/benchmark-devengo-cronogramas-contabilidad.md`](./benchmarks/benchmark-devengo-cronogramas-contabilidad.md) · [`benchmarks/benchmark-consumo-desfase-mrr.md`](./benchmarks/benchmark-consumo-desfase-mrr.md) (variables con desfase, MRR de uso, granularidad: **confirma la regla mensual de S5-5**).

#### S5a · Motor del RSM y métricas (funciones de prod = corpus, md5 verificado)

**Modelo**: una fila por **ítem × mes × momentum** en todo el rango del contrato (incluye filas en 0 antes y después de la
vigencia del ítem); columnas de devengo, facturado, **deferred y unbilled (del período y EOM)**, MRR, MRR contratado y CMRR
en tres monedas; momentum `NEW, REACTIVATION, UPSELL, CROSS-SELL, DOWNSELL, CHURN, RENEWAL, BOP, PENDING_RENEWAL` (sin EOP:
se calcula al leer). 20.486 filas (3.001 de suscripciones Stripe, fuera de alcance).

**Construcción** (`revenue_schedule_rebuild` → núcleo en moneda de contrato → paso de FX): rango y día de ciclo derivados;
DELETE total o desde un mes; por ítem, devengo `final/term`; mes activo = `term` meses desde el mes de inicio (Capa 2);
**prorrateo del primer mes** solo en UPSELL/CROSS-SELL/DOWNSELL con día ≠ ciclo, **por mes calendario**; ajuste de NC de
descuento (`impact_month` / `defer_forward`); saldos desde acumulados; MRR y CMRR con chequeo al fin de mes (CMRR desde la
booking); momentum por trigger (categoría en el mes de inicio, BOP el resto). **Cola non-renewal** (BOP + / CHURN − en el mes
del churn; PEN-01) y **split de renovación** con cambio de precio (TiMining CER-01 18.500 → 22.500). Pending renewal:
proyecta `term` meses de MRR sin devengo, sin mirar el estado del contrato; al terminar la ventana el MRR desaparece **sin
movimiento de churn**. Variables: un parche aparte por override (otra fórmula de saldos) que **el rebuild no lee** → regla
operativa "re-aplicar lo facturado real tras cada rebuild". No recurrentes: lineal en el término (con prorrateo del primer
mes, decisión 24-08). Facturado: por `contract_item_id` en el mes de emisión (unificadas atribuidas por línea; líneas sin
ítem no cuentan).

**Cuándo se reconstruye**: al activar (completo) y por triggers de ítems, facturas y cantidades (parcial) — ⚠️ **gate por el
flag del holding del usuario de sesión**: sin sesión (API, webhook de Odoo, crons, SQL) **los triggers no hacen nada**.
Documentados pero inexistentes: `trg_rsm_on_churn`, trigger post-NC. Wrappers rotos: `populate_initial_revenue_schedule`
(lo llama un botón del front), `revenue_schedule_rebuild_for_invoice`, `admin_populate_revenue_schedule`.

**Métricas**: el dashboard de la API, el Cliente 360 y los KPIs de contratos suman **todas** las filas (incluye pending); el
**waterfall** excluye pending del EOP → **dos cifras de MRR para el mismo mes** (sep-26 USD: TiMining 422.416 vs 326.729;
uPlanner 306.934 vs 241.441). Asientos armados en el navegador (sin asiento de facturación). `revenue_monthly_journal` y
`revenue_monthly_summary` siempre vacías (leen filas TOTAL que no existen).

**Desvíos (con evidencia)**:
- ⚠️ **P1 · el rebuild parcial reinicia el devengo acumulado en 0** (carga el facturado previo pero no el devengado previo) →
  **deferred inflado** en 96 contratos Activo: deferred EOM ago-26 guardado vs calculado TiMining **3.415.677 vs
  1.258.463**, uPlanner 1.588.946 vs 1.018.863; unbilled SimpliRoute 1.001.702 vs 1.242.603. Es la "cola fantasma" que
  uPlanner corrigió en julio: **vuelve porque la causa es el rebuild parcial**.
- ⚠️ **P2 · facturado no capturado** cuando la factura cambia de estado sin usuario de sesión (webhook de Odoo): SimpliRoute,
  facturas con `odoo_invoice_id` desde mayo mayoritariamente **ausentes del RSM** (p. ej. 118/120 Emitidas de agosto) →
  1.649 ítem-mes en 431 contratos (mecanismo: inferencia fuerte de código + datos).
- P3 · FX de compañía a 1,0 (ver S5b). P4 · sub-bug **C sigue vivo** (falta el tramo final: TiMining ANG/CHI/COD, SimpliRoute
  CTR-2026-61, S04170, S04191, S07276, S07866) + doble prorrateo Bosch (−10,51). P5 · filas repetidas por (ítem, mes) (la
  mayoría por diseño). P6 · overrides pisados (51 de 285). P7 · dos fuentes de mensual (15 ítems > 1%). P8 · dos MRR.
- **Cerrados**: `RECURRENT` (0 ítems, CHECK sin el valor) y sub-bug B (resuelto en los datos). 159 contratos sin rebuild desde
  antes de Capa 2.

**Lo que funciona y se conserva**: devengo = TV en 942 de 957 ítems fijos Activo; momentum por trigger y waterfall; split de
renovación; cola non-renewal; contracción early; facturado por línea; NC de descuento con dos tratamientos; chequeo EOM;
separación núcleo / FX.

**Brechas M5, M6, M7, M12** y **invariantes propuestos**: Σ devengo = TV (fijos) o = facturado real (variables); acumulado =
Σ períodos; deferred/unbilled desde acumulados completos; todo documento emitido y vinculado está en el facturado; una sola
cifra de MRR por definición; meses cerrados no se reescriben; FX sin 1,0 silencioso.

**Decisiones de Domi (24-09) — S5:**

| # | Tema | Decisión |
|---|---|---|
| S5-1 | P1 · rebuild parcial reinicia el acumulado | **Corregir** cargando el acumulado previo y luego rebuild completo → **Fase 1** |
| S5-2 | P2 · facturado vía Odoo no entra al RSM | **Ambas**: los triggers (facturas, ítems, cantidades) toman el holding **del registro**, no del usuario de sesión; y la API reconstruye tras cada webhook → **Fase 1** (Domi ya lo había visto sin entender la causa). Evidencia 24-09: SimpliRoute agosto, 8/8 manuales reflejadas vs **51/480 vía Odoo** |
| S5-3 | Cuál es "el" MRR | **Sin pendiente de renovar**; el pendiente como tarjeta aparte |
| S5-4 | Pendiente de renovar que vence sin decisión | **Se mantiene hasta que la usuaria decida** (verlo para no perderlo), con **alertas cada vez más notorias** según pasa el tiempo, indicando el efecto en el devengo. Renovación tardía retroactiva (p. ej. 3 meses después, desde la fecha de vencimiento): **la usuaria elige** corregir hacia atrás (si el período está abierto o decide reabrir) o dejar todo lo atrasado en el mes de la renovación (catch-up) |
| S5-5 | Tramo inicial y final | Según la **granularidad de devengo** ("Configuración de Reglas de Reconocimiento", hoy solo mensual). En **mensual**: meses completos del ítem (el primer mes cuenta completo, nada extra al final), como hoy. Otras granularidades (diaria) a agregar → benchmark |
| S5-6 | Variables | **(a)** el devengo se ajusta a la cantidad variable (ya funciona así). Ojo: suelen tener **desfase de un mes** (el consumo de un mes se factura el siguiente) → ¿cerrar el mes sin esa info o ajustar siempre en el mes siguiente? + cómo se calcula el MRR de consumo → **investigar industria** |
| S5-7 | Cierre de períodos en el RSM | **(a)** meses cerrados congelados; ajustes al primer mes abierto |
| S5-8 | FX de lo facturado en moneda de compañía | **La tasa de la factura**: si la moneda de factura = la de compañía (p. ej. contrato CLF facturado en CLP), el monto en moneda de compañía **es** el monto facturado |
| S5-9 | Devengado en moneda de compañía | Diferido liberado a la **tasa de la factura** (IFRIC 22, anticipado: devengado = facturado, sin diferencia); devengado **sin factura previa** (vencido/unbilled) al **promedio mensual** → ahí nace la diferencia de cambio (M9). **Confirmar con el contador** |
| S5-10 | FX faltante | Nunca 1 (salvo misma moneda): la fila queda pendiente y se recalcula al llegar la tasa |
| S5-11 | Convención de tasa | **Una sola** ("1 origen = X destino", siempre se multiplica), migrando las fijas invertidas |
| S5-12 | Intercompañía (M10) | El **devengo queda en la compañía del contrato**; si una factura se emite desde otra compañía nace la relación intercompañía ligada a **ambas** (la del contrato con la PE "pendiente de emitir"; la que factura sin contrato ni devengo). Pocos casos, pero la opción debe existir; hoy no hay nada → **se detalla al final** |
| S5-13 | Reajuste UF | **Sin cuenta especial**: misma lógica y misma cuenta que la diferencia de tipo de cambio |
| S5-14 | Asientos | Generados desde el RSM en el **servidor**, en una **tabla de asientos en la base** como respaldo contable (hoy se arman en el navegador) |
| S5-15 | Moneda constante | La **tasa fija anual del holding = tasa de presupuesto** (comparable con el budget, M13); agregar la vista a tasa real con el "efecto tipo de cambio". Industria: "budget rate / plan rate" (NetSuite Budget Exchange Rates; FP&A) |
| S5-16 | Prorrateo del primer mes en upsell/cross-sell | **Es correcto** (no es la excepción): parte en su fecha real → primer mes proporcional, y **termina con el ítem relacionado** (co-terminación, D-B) → sin cola; el devengo cierra el mismo mes que el original. El **bug** es el **doble prorrateo**: el devengo debe usar el **precio mensual** × fracción del primer mes + precio mensual en los meses completos (= valor del ítem, = facturas), no `final/term` re-prorrateado (Bosch 169,95 vs 180,46). Sub-bug C solo aparece si el ítem no co-termina |
| S5-17 | Variables al cierre | **Política por compañía**: estimar y ajustar en el mes siguiente (default; true-up en el primer período abierto, sin reabrir) o "al facturar" como simplificación registrada. `quantities` guarda el **mes de servicio** separado del mes de facturación. MRR de uso aparte del comprometido (benchmark consumo §2) |

**Principio (Domi, 24-09)**: la configuración es más compleja pero **la flexibilidad es importante**; los **agentes deben entender estas configuraciones** (granularidad, política de variables, FX, cierre) para guiar a la usuaria, de modo que la flexibilidad no le traslade complejidad.

#### S5b · Monedas, tipo de cambio y contabilidad del devengo

**Las 4 monedas**: contrato (una por contrato, validada por trigger; cambiable solo antes de firmar) · factura (default en el
contrato, NULL en ~60%; FX al emitir: spot a la tasa directa del día de emisión, fixed a la pactada) · compañía/funcional
(`companies.currency`; copiada al contrato solo si viene NULL → 12 contratos desalineados; **las facturas no tienen
montos en moneda de compañía**) · sistema (una por holding; **los 4 holdings en USD con `fixed_period`**).

**Fuentes de tasa**: `exchange_rates` diaria (Banco Central de Chile; USD>PEN desde Perú API desde 17-07; sin filas X>USD);
`exchange_rates_monthly_avg` (**CLP/MXN/PEN/COP→USD con un solo punto de may a sep-26 cargado el 14-09 y 15 meses
futuros sembrados** [quién: no verificado]; pares invertidos ARS/UYU/BRL/GBP); `holding_fx_period_rates` (fija, **forma
inversa**: origen por USD); `contract_fx_period_rates` (la UI la muestra directa pero el RSM la trata como inversa → en prod
`CLF>CLP = 0,000025`; CTR-2026-215 quedó 1 USD = 1 MXN). **6 funciones FX muertas o que fallan** (tablas inexistentes).

⚠️ **Convenciones de dirección de tasa mezcladas**: promedios directos que se multiplican, fijas inversas que se dividen.
Funciona hoy solo porque los 4 holdings usan `fixed_period`; si uno pasa a `monthly_avg`, el TCV y las facturas en moneda
de sistema quedarían ~900.000 veces más grandes (CLP).

**RSM en monedas**: la tasa se toma **en el rebuild** y no se recalcula nunca; si falta, usa **1,0** (`missing_fx_rate`) →
⚠️ **6.265 filas en moneda de compañía convertidas 1:1 (435 contratos), 1.582 de meses ya pasados** (CLF>CLP 901, USD>CLP
353…); ningún cron re-aplica FX. Saldos acumulados re-expresados con la tasa del mes (efecto cambiario sin registrar).
**M9 no existe**: lo facturado en moneda de compañía = facturado en moneda de contrato × promedio del mes, no el monto real de
la factura; diferencia estimada desde 2025: USD→CLP +36,8 M CLP (+0,94%), USD→COP +37,0 M COP (+1,39%), CLF→CLP −2,17 M CLP.

**Contabilidad**: el único asiento es el de **reconocimiento**, armado **en el navegador** (`Revenue.tsx`) con cuentas por
defecto (**`company_account_mappings` = 0 filas**); sin asiento de facturación, CxC, IVA, FX ni reajuste UF; las funciones
SQL de journal (otros códigos) no tienen llamador. **Cierre de períodos**: fecha de corte por (holding, compañía), modo
`enforce`; bloquea solo ítems (por `start_date`) y campos padre del contrato; **no bloquea facturas, RSM ni política FX**; solo
SimpliRoute lo usa (15 eventos, 10 reaperturas) y sus cortes son anteriores a todo mes con RSM → hoy no protege nada.
**Intercompañía (M10)**: solo el demo de Hanka (1 split); los splits no tienen efecto; el RSM imputa a la compañía del
contrato. **Compañías (M11)**: `tax_rate` plano (Lenosoft 0,19; SimpliRoute Brasil e INC NULL; UI que muestra ×100); sin plan
de cuentas, política FX ni granularidad por compañía.

**Qué debería cumplir**: una sola convención de tasa (directa, se multiplica) con su fuente guardada; nunca completar con 1
(fila "pendiente" que se recalcula al llegar la tasa); por factura, monto funcional = monto de la factura si su moneda es la de
la compañía, si no × tasa de la fecha de factura; diferencias realizada / no realizada / reajuste UF en cuentas separadas;
MRR/ARR a tasa constante + "Impacto FX"; plan de cuentas por compañía; asientos generados en el servidor desde el RSM; cierre
que bloquee facturas, RSM y FX del mes cerrado con ajustes al primer período abierto.

### S6 + S7 · Tipo de cambio en contratos vivos y cantidades variables — ✅ cerrado 24-09 (dos vueltas)

#### S6 · Moneda de facturación y tipo de cambio en un contrato vivo
**Flujo**: pestaña Facturas → "Moneda de facturación" (aplica a **todas** las PE, incluidas unificadas y ya enviadas a Odoo;
API `POST /invoices/bulk-update-currency`: misma moneda → fx 1 sin recalcular IVA/total; otra → todo NULL; sin transacción;
⚠️ **no valida el holding** → seguridad para Leon; después el front fuerza `auto_send_to_odoo = true`; no toca la política) ·
"Tipo de cambio de facturación" (spot/fijo vía `apply_fixed_fx_to_contract`: fijo = moneda de contrato × fx; **política
guardada antes de validar**) · por factura (fija el **contrato completo** a "fijo"; "neto exacto" para OC: fx = neto / Σ
base, ej. ILUMI 97 USD → 330,77 PEN a 3,41) · al emitir: si es fijo con tasa se respeta; **en cualquier otro caso spot, incluso
"fijo" sin tasa (en silencio)** · PE nuevas nacen con fx NULL sin leer la política · el tipo de cambio de compañía, una vez
confirmado, **no se puede cambiar** desde la UI · historial registra solo `invoice_currency` (no políticas ni tasas).
**Vivos**: **11 PE "fijo" sin tasa que se emitirán a spot en silencio** (CTR-2026-151, CTR-2026-74 ILUMI, CTR-2026-96) · 3
contratos fijos con tasas distintas entre PE · 77 spot con FX pegado · 21 PE en moneda ≠ la del contrato · 74 PE con conversión
ya enviadas a Odoo.
**Con multimoneda real (M3)**: moneda por ítem, **una moneda por factura**, política y tasa **por par** (tabla por contrato y
par: política spot/fijo/neto exacto, tasa, fuente, confirmación, vigencia); "confirmar tasas" con bloqueo real; guard línea vs
encabezado (U3); evento por cambio de moneda/política/tasa; `auto_send_to_odoo` separado; al agregar un ítem en otra moneda,
pedir su par y política en la misma pantalla. Reutilizar la valorización por par de `unify_invoices_multi_contract`.

#### S7 · Cantidades variables
**Canales**: (1) vista "Cantidades" del contrato — "variable" = cualquier ítem con precio y cantidad (no el tipo de ítem);
precio × cantidad o monto total; ⚠️ si el ítem parte a mitad de mes, **el mes de inicio queda fuera** [inferido]; (2) Excel por
contrato — **no lee la columna `amount`**, convierte **0 en NULL**, sin transacción; (3) DWH/BigQuery — cron por hora con tabla
intermedia y estados; **nunca integró nada** (0 filas) y, sin usuario de sesión, **no actualizaría el RSM** (mismo P2).
**Triggers**: guard de estado (bloquea si la factura del mes no está Por Emitir/Cancelada); factura: línea = precio ×
cantidad × (1 − descuento); **RSM: sin descuento**; al borrar, restaura línea y RSM. `quantity ≥ 0` en quantities pero **> 0 en
líneas**; `created_by` nunca se llena (289/289).
**Vivos**: ⚠️ **override 0 ya cobró de más**: CTR-2026-110 emitió 54 USD en julio con override 0 (Medios #2) · RSM ≠ factura en
**8 de 10 overrides con descuento** (CTR-2026-60 y 85: RSM 522,50 vs facturado 391,88; semántica bruto/neto ambigua) · 28
overrides sin línea en su mes · **S3-18 no se cumple**: editar un ítem con variables guarda el ítem pero **bloquea la sync** →
ítem y PE separados (es Complejos #2 pendiente) · 289/289 overrides en ítems mensuales (en trimestrales el override de un mes
reemplazaría el trimestre [inferido]).
**Con mes de servicio (S5-17)**: `quantities.service_period` + `billing_period`; política "estimar" (fila estimada al cierre +
true-up en el primer mes abierto) o "al facturar"; el RSM lee `quantities` en el rebuild; holding del registro (S5-2); un solo
criterio bruto/neto; cantidad 0 = anular la PE; registrar autor y canal; MRR de uso aparte. **Con pricing por tramos (#20)**:
`quantities` guarda el consumo total y una tabla de tramos calcula el precio (reemplaza los N ítems-tramo de ValdiShopper y
Turboboy); el DWH solo entrega consumo.

#### Decisiones de Domi (24-09)
| # | Tema | Decisión |
|---|---|---|
| S6-1 | FX de una sola factura | **Cada factura define su FX** (fijo o spot); fijar la tasa para todo el contrato es riesgoso y se usa mal. Si una factura necesita FX y no tiene fijo → **spot del día de emisión automático, avisando**. Revisar auto-emisión / auto-envío: programarlos o dejar alertas |
| S6-2 | Factura nueva o línea nueva en contrato "fijo" sin tasa | **Bug**. La línea hereda política y tasa de la factura a la que se suma; si queda separada, la de su período. En la modificación: preguntar "hereda tasa y tipo de la factura / otra política" y permitir cargar la tasa fija ahí. **Nunca enviar una factura con política fija sin tasa** (a veces es fija pero la tasa aún no se conoce) |
| S6-3 | Cambiar moneda de PE ya enviadas a Odoo | Mientras no esté emitida (aunque esté en Odoo como borrador) hoy se **restablece** para que vuelva sin envío, se ajusta y se reenvía. Mejorar este flujo: **no quedó cubierto en S4** → se agrega |
| S6-4 | Override con descuento: bruto vs neto | Se define (al inicio o al facturar) y **el descuento del ítem se respeta también sobre el consumo variable**; el usuario debe entenderlo y decidirlo explícitamente |
| S7-5 | Mes de servicio del DWH | El DWH **siempre entrega el mes de servicio** (normalmente el mes anterior → facturación vencida). Corregir el trigger sin usuario. Revisar práctica de la industria sobre **eventos de consumo**. Agregar **vista de solo consumos**. Hoy hay casos por tramos que Sapira no resuelve (envían monto final o separan ítems del contrato, que no es lo correcto): con **modelos de pricing** el cliente entrega el consumo final del período y la factura puede mostrar el detalle por tramo o todo junto |
| S7-6 | Variables en ítems no mensuales | Se resuelve con los modelos de pricing (sumar / máximo + frecuencia del variable). Hoy no hay casos trimestrales variables: **no afecta ahora** |
| S7-7 | Editar ítem con variables / corregir consumo | Caso real: registraron mal el variable, anularon la factura (también en Sapira) y **no pudieron registrar el consumo correcto**. Regla: si hay una factura disponible Por Emitir → permitir; si está emitida y no anulada → no. Al editar el ítem: aviso de que tiene cantidades variables, y RSM y facturas respetan la cantidad registrada del período (y si está emitida) |

#### S6 + S7 · Segunda vuelta (24-09)
Fuentes: ROADMAP-OPERATIVO, memorias y metodología del agente de soporte (R8, R9, R12), código y SELECT en prod; benchmark nuevo
[`benchmarks/benchmark-metering-pricing-fx-emision.md`](./benchmarks/benchmark-metering-pricing-fx-emision.md).

**Correcciones a la primera vuelta**
- "Las PE nuevas nacen con FX NULL" solo vale para `generate_missing_invoices_for_contract`. `sync_invoices_for_contract_item`
  (:258-286) e `invoice_reschedule_items` (:122-133) **clonan el FX de la última factura creada del contrato, en cualquier
  estado** (emitida con spot viejo, cancelada) → origen del "FX pegado" (78 PE spot con FX). Una línea agregada a una PE existente
  hereda el FX del encabezado (:389-393).
- El spot no usa "la tasa del día": usa la tasa de la `issue_date` (`invoice-scheduler.service.ts:1217`).
- El descuadre RSM ≠ override **no es principalmente el descuento**: de 55 descuadres, 52 tienen el RSM = precio base (el
  override nunca se aplicó o lo pisó un rebuild); solo 4 tienen descuento. Causa: el trigger del RSM lee `financial_settings`
  del holding **seleccionado por el usuario de la sesión** (`rls_user_holding_id()`); sin sesión (DWH) no actualiza y con
  super admin en otro holding usa la configuración equivocada → confirma **U9**.
- **Auto-envío y auto-emisión** (corregido con Domi): `contracts.auto_send_to_odoo` = el scheduler **envía la PE a Odoo como
  borrador en su fecha de emisión**; `invoices.auto_invoice` = **auto-emisión**, que requiere el auto-envío: se envía con
  `auto_post = at_date` y Odoo la emite (`invoice-scheduler.service.ts:500,1006`). El filtro trata `auto_send_to_odoo` NULL como
  encendido (:196), pero **hoy no hay contratos activos en NULL** (408 con auto-envío, 1.747 PE pendientes, 1.162 con
  auto-emisión; 212 sin auto-envío, 938 PE). El scheduler corre una vez al día (hora 9) y **solo toma PE del mes en curso**.

**Bugs nuevos (vivos)**
| # | Bug | Evidencia | Gravedad |
|---|---|---|---|
| B1 | **Upsell / cross-sell / AssignToContract no respetan la moneda de facturación que ya tiene el contrato** (causa raíz, confirmada por Domi = ROADMAP Complejos #1): la PE nueva nace con la moneda del ítem de cotización y **fx 1**, y al sumar a una PE existente se agrega el subtotal en moneda de contrato a `amount_invoice_currency`. Consecuencia: con política fija el envío no recalcula → la línea viaja a Odoo con fx 1 (UF como CLP) | `UpsellingModal.tsx:762-769,791-798,846`; `AssignToContractModal.tsx:815-817` | 🔴 |
| B2 | IVA del encabezado = Σ IVA de línea **sin × fx** (queda en moneda de contrato); con política fija nunca se recalcula | `sync…:131,379`; `reschedule…:258`; **12 PE con conversión, 10 fijas** | 🔴 |
| B3 | Guard de FX fijo mira solo `contracts.fx_invoice_policy` y el FX del encabezado → **fijo sin tasa sale a spot en silencio** | `invoice-scheduler.service.ts:1201`; 11 PE | 🔴 (S6-2) |
| B4 | El sync de cantidades **no filtra `document_type`**: reescribiría NC en Por Emitir con montos positivos | `sync_invoice_items_amounts_from_quantities.sql:53-68`; 19 NC Por Emitir con líneas ligadas | 🔴 |
| B5 | Corregir un variable tras anular queda bloqueado si se anuló **solo en Odoo** (en Sapira sigue Emitida) o si una **NC ligada al período quedó "Vencida"** (20 NC); el mensaje "anula para que vuelva a Por Emitir" es falso (anular nunca devuelve a Por Emitir). La PE de reemplazo copia el FX con `COALESCE(fx,1)` | `validate_invoice_status_for_quantity_change.sql:40-62`; `create_credit_note_safe.sql:268-330` | 🟠 (S7-7) |
| B6 | Restablecer una PE enviada: **no toca Odoo** (el toast pide borrar a mano), **no limpia `invoice_number`** (folio fantasma) ni revierte el FX/montos del primer envío, y si `issue_date` no es del mes en curso **queda varada** (el scheduler no la toma) | `reset_invoice_odoo_draft.sql:27-41`; `ContratoFacturasTab.tsx:232-251` | 🟠 (S6-3) |
| B7 | DWH (en desarrollo, Leon): la columna del DWH se llama `billing_date` pero **según Domi es el período de servicio** (billing period), no la fecha de emisión. El código la trunca al mes y la guarda como `quantities.period`, así que **el mapeo es correcto si la columna es el período** (nombre engañoso; confirmar con Leon). El problema real es la **ventana del cron diario: solo el mes en curso** (`resolveDateRange`, :424-431). Como el consumo del mes se informa el mes siguiente (facturación vencida), **agosto llega en septiembre y el cron de septiembre no lo lee** sin un rango manual. Además no sobrescribe conflictos (:1014-1018) y, sin sesión, el RSM no se actualiza (U9) | `bigquery.service.ts` | 🟠 (S7-5) |
| B8 | La skill de Claude valoriza la variación **sin descuento** (mismo bruto/neto) | `quantity-variation-skills.ts:~88` | 🟡 |
| — | Siguen vivos del ROADMAP: reschedule usa la cantidad del ítem y no del override (l.85, asset en prod sin commit) · 7 líneas ≠ override (l.106b) · modal "Tipo de cambio: 1" en spot (l.120) · override 0 → anular (l.127) · badge FX + backfill 61 spot (l.130) · guard "tasa > 2 días" + `fx_policy_at_send` (l.149) · Actualizar moneda / Cambiar a spot no actúan sobre unificadas · rebuild pisa overrides (l.162, regla R9 del agente) · tramos #20 (Turboboy, ValdiShopper) | ROADMAP | — |

**Casos reales que explican el diseño**: LOGYTECH (FX pisado al enviar, resuelto) · TEXORA (CLP en campo CLF, resuelto) · Reutter y
Nestlé (unificadas con fx 1 → Odoo por $100) · TOPGROUP (FX editado en el borrador de Odoo; callback solo encabezados) ·
Turboboy (consumo real nunca llegó al RSM) · ValdiShopper (tramos como N ítems) · Ransa-82 (override con guard apagado; RSM
reaplicado a mano tras cada rebuild).

**Propuesta S6 · FX por factura**
1. **La política vive en la factura** (`fx_policy spot | fixed | net_exact`, `fx_rate`, `fx_rate_date`, `fx_rate_source
   official | contract | manual`). El contrato guarda solo un **default por par** que se propone a las PE nuevas.
2. **Herencia única** (S6-2): línea que se suma a una PE → hereda la política y tasa de esa PE; PE nueva → default del par del
   contrato para ese período; **nunca clonar la última factura**. En la modificación, paso explícito "hereda / otra política /
   cargar tasa ahora".
3. **Resolución al emitir**: `fixed` sin tasa → **bloquea la emisión y alerta** (nunca spot en silencio); `spot` → tasa oficial
   del país a la fecha de emisión (CL dólar observado, PE SBS venta, MX FIX o pactado, CO TRM) con aviso; sin tasa del día →
   detener y alertar (fallback explícito por país). Montos, IVA y encabezado se recalculan siempre en el servidor (cierra B1–B3).
4. **Emisión y envío programados** (S6-1): `billing_policies` por compañía/contrato (auto-envío como borrador en la fecha de
   emisión, auto-emisión que lo requiere, ventana de revisión, aviso N días antes, alertas "falta tasa", "fijo sin tasa", "sin
   partner"); `auto_send_to_odoo` pasa a `NOT NULL` (sí / no explícito, default "no" o el de la compañía) para
   que un NULL no signifique "sí" por accidente. "No" sigue sirviendo para no enviar o sin integración (emisión manual).
5. **Restablecer = solo borradores** (S6-3, corregido con Domi): aplica únicamente a PE enviadas a Odoo **como borrador** y no
   emitidas. Sapira actualiza o elimina el borrador en Odoo por API, limpia folio, FX y montos del envío y permite reenviar
   fuera del mes en curso. `erp_sync_state draft | posted` para saber si el botón aplica. **Una factura ya emitida** (auto-emisión
   o emitida desde el borrador en Odoo) **no se restablece: se anula con NC** (flujo de S4, que crea la PE de reemplazo).
   Se suma a S4 (operaciones sobre facturas).

6. **Facturas no emitidas al cambiar de mes** (mejora de usabilidad, Domi 24-09): antes de cerrar el mes o al pasar al
   siguiente, aviso con la lista de PE del mes que no se emitieron (incluidas las restablecidas) y acción **masiva "mover al
   mes siguiente"** (nueva fecha de emisión, sin tocar el período de servicio ni el devengo), con evento y motivo por factura.
   Evita que queden varadas fuera del scheduler (B6) y que se pierda el seguimiento. Se conecta con el cierre contable (S5).

**Propuesta S7 · Consumos**
1. **Registro de consumo** (evoluciona `quantities`). **El período ya es el de servicio** (corregido con Domi, verificado):
   `quantities.period` se cruza con el mes de `invoice_items.billing_period_start` de la línea del ítem, **no con la fecha de
   emisión** (`validate_invoice_status_for_quantity_change.sql:45-46`, `sync_invoice_items_amounts_from_quantities.sql:65-66`);
   en vencida, el consumo de agosto cae en la factura que cubre agosto aunque se emita en septiembre. **No hace falta un
   `billing_period` aparte** (se descarta esa parte de S5-17 y del benchmark). Lo que se agrega: `source api | csv | dwh |
   manual`, `idempotency_key`, autor, estado `active | archived`, `supersedes_id` y motivo. **Corregir = nueva versión**, sin
   update destructivo.
   **Modelo acordado con Domi (24-09)**: el registro anterior no se borra ni se edita; pasa a `status = cancelled` (con quién,
   cuándo y motivo) y eso **libera el período** para un override nuevo, que queda `active` y apunta al anterior
   (`supersedes_id`). La unicidad actual `UNIQUE (contract_item_id, period)` pasa a índice único parcial `WHERE status =
   'active'`. Factura, RSM, reportes y el DWH leen solo el activo; la vista Consumos muestra el historial.
2. **Regla de corrección** (S7-7): período con PE disponible (Por Emitir, incluida la de reemplazo tras anular) → se aplica; factura
   emitida no anulada → no se pisa: la diferencia va como **ajuste (true-up) en la siguiente factura o NC/ND**. El guard mira
   solo facturas del ítem y período de tipo factura (no NC) y el mensaje dice qué hacer.
3. **Vista "Consumos"** del contrato y del holding: período de servicio, cantidad, fuente, versión, factura donde quedó y su estado.
4. **Descuento sobre consumo** (S6-4): el descuento del ítem declara `applies_to fixed | usage | both` (default `both`) y se
   muestra al registrar el consumo; factura y RSM usan **el mismo neto** (cierra B8).
5. **RSM y facturas desde el servidor**: el recálculo por consumo deja de depender del holding de la sesión (U9) y un rebuild
   **lee `quantities`** (deja de pisar overrides: adiós regla R9 manual).
6. **DWH**: carga por período de servicio con ventana de backfill configurable, idempotente (reprocesa sin duplicar) y con reporte
   de rechazos; cuando el período ya está facturado, aplica la regla 2.
7. **Monto final y tramos**: mientras no existan los modelos de pricing (#20), un consumo puede venir como **monto** (cantidad
   informativa), marcado como tal; con modelos de pricing el cliente entrega solo el consumo y la factura muestra una línea por
   tramo o total con detalle (cuadrando con el DTE). Frecuencia del variable independiente de la del fijo (S7-6, sin urgencia).
8. **Editar ítem con consumos** (S7-7): se permite, con aviso "este ítem tiene consumos registrados en N períodos"; esos
   períodos conservan su cantidad en factura y RSM, y los emitidos no se tocan (reemplaza el bloqueo de Complejos #2).

**Decisiones de Domi, segunda vuelta (24-09)**
| # | Tema | Decisión |
|---|---|---|
| S6-8 | B1–B4 | **Sí a Fase 1**, cada uno cuando toque según el plan (§6) |
| S6-9 | Tasa spot | **Resuelto**: la API usa la tasa oficial que una integración guarda a diario desde fuentes oficiales. Solo falta que el guard no caiga a spot con "fijo" sin tasa (B3) |
| S6-10 | Defaults | **Auto-envío y auto-emisión apagados siempre por defecto** hasta que el usuario los active. Avisos **3 días y 1 día antes** |
| S6-11 | Restablecer: borrar el borrador en Odoo por API | Ideal, pero es de Leon (Odoo a veces no permite borrar) → lista de Leon, Domi lo revisa al final |
| S7-8 | Consumo corregido con factura emitida | Lo habitual: **NC de anulación y reemisión**. **Al anular la factura, los overrides de ese período pasan a `cancelled` en la misma operación** (motivo "factura anulada"), lo que libera el período para un override nuevo que afecta la PE de reemplazo. **Nuevo caso no cubierto**: si el consumo real fue mayor, opción "consumo adicional" en el override → crea una **factura complementaria** igual a la del período (hereda billing period, razón social, moneda, política FX, OC/HES, etc.) solo con la cantidad adicional |
| S7-9 | Descuento del ítem sobre el override | **Por defecto se mantiene**. Al crear o editar un override (con la factura no emitida), casilla **"el override es el monto final: no aplicar descuento"**. Se guarda en el registro de consumo (`apply_item_discount boolean default true`) y factura y RSM lo respetan. Hoy la factura ya mantiene el descuento (`sync_invoice_items_amounts_from_quantities.sql:78-79`); el que lo pierde es el RSM |
| S7-10 | Modelos de pricing | **Se desarrollan todos los modelos** (no solo tramos): por unidad, paquete, tramos graduado y por volumen, mínimo comprometido con true-up, máximo, prepago/créditos, frecuencia propia del variable. La web ya declara "modelos de pricing flexibles" → alcance de #20 |
| — | Aclaración Chile (corrige el benchmark) | La **UF es moneda de contrato**: en Chile se factura en CLP y se cobra en CLP, **no hay diferencia de cambio**. La diferencia de cambio (y una eventual ND) solo aparece al **facturar en moneda extranjera (USD) y cobrar en otra moneda** → queda para cobranza y conciliación |

**Fase 1**: B1 (moneda de facturación en upsell/assign), B2 (IVA encabezado), B3 (bloquear fijo sin tasa), B4 (sync pisa NC) — aprobados por Domi (S6-8).

### S8 · Legacy y onboarding — ✅ cerrado 24-09: limpieza mínima ahora, rediseño al final del rediseño

#### S8a · Legacy (MRR legacy y contratos legacy)
**Dos modelos casi disjuntos**: (A) **MRR legacy**, solo SimpliRoute, 11.839 filas mes × producto que luego se convierten en
contrato (`create_contract_from_mrr_legacy`, 488 contratos) o se relacionan con uno existente (V9); (B) **contrato legacy +
reconciliación** de facturas legacy contra una cuota programada (`reconcile_legacy_invoice`) o una Por Emitir
(`reconcile_legacy_with_por_emitir`), usado por uPlanner (59) y TiMining (42); los 101 se activaron con UPDATE directo +
`generate_missing_invoices_for_contract`. **7 de las 15 funciones están muertas o rotas**: `activate_legacy_contract` (0 usos;
depende de `validate_legacy_activation`, que lee `contracts.start_date/end_date`, columnas inexistentes),
`derive_contract_items_from_legacy`, `confirm_legacy_invoice_reconciliation` ×2 y `bulk_reconcile_legacy_invoices` ×2 (columnas,
tablas y estados que no existen). **`legacy_cutoff_date` no corta nada** (solo la leía la función muerta). El desvínculo al
borrar un contrato es la FK `ON DELETE SET NULL`, no un trigger: 301 filas en 32 lotes parecen pendientes y vienen de
contratos borrados.

**Problemas vivos**
1. 🔴 **MRR contado dos veces**: dashboard = RSM + `mrr_legacy` sin corte → 90 meses en 81 contratos (≈73 mil USD), ≈16 mil
   USD solo en agosto 2026 (CTR-2026-07, 110, 90).
2. 🔴 "No aplica" por **duplicado o error sigue sumando** en el MRR (57 filas, 26,5 mil USD de 2026); razón en texto libre (4
   variantes de "churn"), sin usuario.
3. 🔴 `create_contract_from_mrr_legacy` arma el **calendario siempre mensual** (anual → 12 cuotas: CTR-2026-219, 181, 178, 177),
   categoría RENEWAL fija, inicio del contrato para todos los ítems; la vista previa del modal muestra otra cosa.
4. 🔴 **Seguridad**: las 15 funciones ejecutables por `anon`; sin control de holding en `delete_mrr_legacy_group`,
   `mark_mrr_legacy_skip_activation`, `update_legacy_reconciliation_pct` y el UPDATE de `create_contract_from_mrr_legacy`;
   `create_legacy_contract_with_items` recibe `p_user_id` del cliente.
5. Se pueden reconciliar o borrar facturas ya `migrated`; borrar una factura legacy borra su MRR en cascada; la reconciliación
   contra Por Emitir salta filas de otra compañía y marca `migrated` igual.
6. Registro: meses ≠ term (31 líneas), un solo split por UI, triggers por columna (el truco `SET period_month = period_month`),
   tipo de cambio 1,0 si falta la tasa; import Odoo sin cruzar con facturas vivas; sin `migrated_by` (9.320/9.590).
7. Contratos legacy por Excel sin calendario (1 TiMining, 1 uPlanner); `is_legacy` queda true tras activar.

**Versión mínima propuesta**: módulo "Historia del cliente" en `api-sapira` con tres acciones: importar facturas legacy (dedup
contra `invoices.odoo_invoice_id`) · registrar historia ("cubre desde X hasta Y", el sistema reparte; cuadre ±1 %, mes ya
cubierto, magnitud rara) · vincular (crear contrato con el **generador común de S1** y vista previa del backend, o relacionar
con uno existente, también de otra moneda). Editable después de vincular con registro de cambios (M15). **Regla de corte
única**: el MRR legacy cuenta solo antes del primer mes con RSM del contrato. "No aplica" con catálogo cerrado (churn cuenta;
duplicado/error no; otra razón social → reasignar). **Retirar** las 7 muertas, los 3 paneles sin montar y el README de
reconciliación masiva; **fusionar** los dos "crear contrato" y las dos reconciliaciones.

#### S8b · Onboarding e imports
**Alta de holding**: **no hay camino de producto**. `ConfiguracionInicial` existe pero no se alcanza: el trigger de login
`sync_user_on_login` crea un holding temporal "Empresa de <nombre>" a todo usuario no invitado (2 en prod, sin compañías); la
API no tiene endpoint de creación. Lo hacemos nosotros, parte por UI de administración y parte por **SQL directo en
producción** (protocolo: preview → OK → SQL por MCP). Triggers al crear holding: 10 roles, quote stages y agentes estándar.
Configuración repartida: compañías y `tax_rate` (UI vieja), master data, FX (`holding_settings`, 3 holdings sin fila), cierre,
**granularidad de devengo con pantalla oculta (se define por SQL)**, usuarios (`invite_user_safe` + edge function; super admin
por SQL; `assign_admin_role_safe` busca el rol por nombre sin filtrar holding), Odoo (el front llama `/odoo/test`, que **no
existe**; mapeo de productos manual), Salesforce (tokens y `client_secret` sin cifrar), Stripe (**compañía SimpliRoute INC
fija en el código**) y BigQuery (sin UI, consultas fijas al DWH de SimpliRoute). El diseño `onboarding_runs` (wizard, dry-run)
**nunca se implementó**.

**Vías de entrada**: Excel de clientes/contactos/razones sociales (vivo; deduplica **solo por UUID**; la casilla "vista previa"
no hace nada) · **imports simulados** (clientes, facturas, cotizaciones de la página: toast de éxito sin importar nada) ·
contratos y cotizaciones del menú **no funcionan** (exigen .xlsx pero lo leen como CSV, y piden UUIDs) · cantidades masivas y
por contrato (vivos) · import legacy (frontera S8a: cliente por `ilike` de nombre, razón social **siempre nueva**) ·
**Salesforce** (manual en 2 pasos + scheduler diario; cruza por object mapping / `client_number` / RUT normalizado sin mayúsculas;
no crea contratos ni productos; **productos fantasma corregidos** con error explicativo; queda 1 fantasma; intenta vincular el
partner de Odoo y solo registra un warn si falla; crea master data por coincidencia exacta → 54 industrias) · **Odoo** (partners de
facturas posted a staging; escribe solo `client_entities`, nunca `clients` → 18 huérfanas; VAT exacto sin normalizar;
`parseTagValue: true` sigue abierto; error de uuid tipo Terra Madre por escribir el id crudo de Odoo; facturas a legacy sin
comparar contra `invoices.odoo_invoice_id`) · **Stripe** (solo SimpliRoute; 3.889 facturas sin contrato en la compañía fija) ·
**DWH** (0 filas integradas).

**Higiene**: deduplicación distinta en cada vía; 18 grupos de RUT duplicado (TiMining: 24 razones sociales con placeholder
`55555555-5`); **65 conflictos de RUT del 30-07 sin resolver**; 612 razones sociales de SimpliRoute sin partner de Odoo; 412
clientes sin razón social; `client_entities` **sin `created_at`**; sin `source`/`external_id`/lote común.

**Onboarding limpio propuesto**: asistente por holding retomable (holding y compañías con país de lista y RUT validado →
configuración financiera explicada por un agente → usuarios y roles por holding → conexiones con prueba real y mapeos
obligatorios → datos en orden fijo; legacy aparte) · **un solo motor de import** para todas las fuentes: staging → validar →
**vista previa (dry-run obligatorio)** → confirmar → aplicar en una transacción → reporte, con deshacer por lote · errores que
explican (nunca Postgres crudo, nunca éxito falso) · **deduplicación única** (normalización fiscal por país, placeholders como
"sin identificador", salida crear / vincular / conflicto a resolver en pantalla; no crear clientes solos) · trazabilidad
`source`, `external_id`, `import_batch_id`, `created_at/by` · IA para mapear columnas, detectar inconsistencias y proponer mapeo
de productos · vínculo automático con Odoo al crear razones sociales. **Se retiran**: `ConfiguracionInicial` y el holding
temporal, RPC de creación sin uso, imports simulados, `dataImportService` de cotizaciones/contratos/facturas, edge functions y
endpoints legados de Salesforce, `/odoo/test` y lógica duplicada de partners.

#### Decisiones de Domi (24-09)
**Contexto de Domi**: el diseño original suponía "cargar planillas", pero los clientes no tienen los datos ordenados ni
relacionados, ni la trazabilidad de qué facturaron realmente en moneda de contrato y por producto (descuentos puntuales,
precios que cambian). Por eso nació el MRR legacy: **la fuente más certera son las facturas de cada contrato**. Armar todo desde
ahí es largo con muchos clientes o facturas → idea: **tomar solo la última factura de cada cliente y armar el contrato con la
fecha de corte**. Subir rápido a un cliente es de lo más clave para la experiencia; los agentes son centrales.

| # | Tema | Decisión |
|---|---|---|
| S8-1 | Historia del cliente | **Aprobada** la propuesta de 3 acciones (importar con dedup contra vivas · registrar "cubre desde X hasta Y" · vincular con el generador común de S1 o a un contrato existente aunque tenga otra moneda). Se suman **dos caminos**: **arranque rápido** (última factura por cliente → contrato con fecha de corte; la historia es opcional y se completa después) e **historia completa** (MRR legacy) |
| S8-2 | Limpieza | Limpiar todas las observaciones y bugs detectados y simplificar el proceso |
| S8-3 | Alta de holding | Nosotros enviamos internamente la **firma de términos y condiciones por correo**; esa firma lleva a crear usuario y holding, relacionados. **Nadie entra sin autorización** (el signup abierto está bloqueado). **Se elimina el trigger "Empresa de X"** |
| S8-4 | Configuración guiada | El **agente guía** paso a paso las configuraciones; el módulo Configuraciones se rediseña (sobre todo UI). Las **configuraciones sin pantalla** (granularidad del devengo, FX, cierre, etc.) se agregan o mejoran |
| S8-5 | Imports y exports | Deben funcionar (hoy están malos). Aprobados: motor único (staging → validar → vista previa obligatoria → confirmar → transacción → reporte, deshacer por lote), dedup única con normalización fiscal por país, `source`/`external_id`/`import_batch_id` y **los campos de migración necesarios**, IA para mapear columnas, asistente retomable |
| S8-6 | Migración desde integraciones | La vía rápida: **Salesforce → clientes comerciales**, **ERP/facturador → razones sociales**, etc. Ya funciona así, pero hay que organizarlo para que lo entienda un usuario, no solo nosotros |
| S8-7 | Orden y experiencia | El orden del onboarding se rediseña con cuidado. Benchmark de la industria para un estándar sólido y escalable; IA y guías claras; explicar conceptos y flujos (product tours); explorar gamificación |
| S8-8 | Planificación | **Limpiar ahora lo mínimo y dejar el rediseño de onboarding, Historia del cliente e imports para el final de las etapas del rediseño**, con lo documentado aquí como base |

**Limpieza mínima para Fase 1** (aprobada por Domi 24-09). **Regla**: se corrige **código y funciones**; **no se tocan datos de
clientes en producción** (Domi los revisa caso a caso en otra sesión). Por eso U14 y U15 no incluyen corrección de filas ni de
los contratos CTR-2026-219, 181, 178, 177; U17 **mantiene el import de clientes** (con él se cargó Mercados) y solo corrige lo
que falle:
| # | Qué | Por qué ahora |
|---|---|---|
| U14 | **Corte del MRR legacy**: el dashboard y las métricas cuentan `mrr_legacy` solo antes del primer mes con RSM del contrato, y "No aplica: duplicado/error" deja de sumar (catálogo cerrado de motivos + usuario) | Doble conteo vivo: ≈16 mil USD en agosto, ≈73 mil USD total |
| U15 | `create_contract_from_mrr_legacy` genera el calendario **con la frecuencia e inicio de cada ítem** (o usa el generador común) (sin corregir datos: los 4 contratos los revisa Domi) | Se usa activamente; anual → 12 cuotas |
| U16 | Bloquear reconciliar o borrar facturas legacy ya `migrated` / con MRR (archivar en vez de borrar) | Duplica facturas o borra historia de MRR |
| U17 | El **import de clientes queda funcionando** (Excel de clientes / razones sociales / contactos, usado en Mercados; se revisa y corrige lo que falle). Se ocultan solo los **simulados** (botones de la página que muestran éxito sin importar) y los rotos (contratos/cotizaciones del menú) hasta el motor nuevo | Muestran éxito sin importar nada |
| U18 | Eliminar el trigger del holding temporal "Empresa de X" (S8-3) | Decidido |
| Leon | Revocar `anon` en las 15 funciones legacy + control de holding; `assign-to-all-holdings` solo super admin; cifrar secretos (Stripe, BigQuery, Salesforce); `parseTagValue` | Seguridad (§1) |
| Retiro | Las 7 funciones legacy muertas/rotas y los 3 paneles sin montar (vía ventana `REVOKE` → `DROP`, como las otras) | Deuda sin uso |

**Para el rediseño (etapa final)**: módulo Historia del cliente (arranque rápido + historia completa), asistente de onboarding
con agente, motor único de import/export, rediseño de Configuraciones, benchmark de onboarding (B2B finanzas: Stripe, Chargebee,
Maxio, Zuora, Rillet, Campfire; product tours y activación). Las preguntas S8a 1, 5-7 y S8b 12-21 se retoman ahí.

## Decisiones pendientes

| # | Decisión | Quién |
|---|---|---|
| 1 | `REVOKE` inmediato de `migrate_contracts_to_new_workflow`, `generate_missing_invoices_for_contract` y `approve_contract_amendment` a PUBLIC/anon/authenticated | Leon |
| 2 | Validar holding dentro de las 7 funciones que usan `get_contract_holding` (o retirar las muertas primero) | Leon |
| 3 | ¿Endurecimiento en bloque del EXECUTE a PUBLIC/anon? | Leon |
| 4 | Retirar las 9 funciones marcadas (ventana de observación con `REVOKE` → `DROP` por migración) | Domi + Leon |
| 5 | Auto-renovación: ¿se arregla (renovar sin usuario en el cron) o se apaga el cron? Hay 383 ítems esperando | Domi |
| 6 | Estado Expirado: ¿se activa `auto_expire_contracts` o se elimina el estado? | Domi |
| 7 | ¿Aprobación de modificaciones? Nunca se usó (0 Pending): ¿se elimina el concepto o se diseña de nuevo en el front nuevo? | Domi |
| 8 | Normalizar datos sucios (`type`, `item_type`, `event_type/status`, `contract_invoices.status`) con migración de datos | Domi + Leon |
| 9 | Unificar los dos triggers de generación de facturas y los 3 `updated_at` duplicados | Leon |
| 10 | Restablecer: ¿Sapira puede borrar o actualizar por API el borrador en Odoo? (a veces Odoo no permite borrar) — S6-11 | Leon (Domi revisa al final) |
| 11 | DWH: confirmar que `billing_date` es el período de servicio (y renombrar); ventana del cron que incluya el mes anterior; qué hacer con conflictos (hoy `DO NOTHING`) — B7 | Leon |
| 12 | Migrar los ~35 controladores previos y los 2 de Salesforce a `HoldingScopeGuard` + `@HoldingId()` (regla única de `autorizacion-y-tenancy.md`); retirar `HoldingAccessGuard` | Leon |
| 13 | Publicar Cliente 360 en prod: ~~migración `1790272076545` + assets~~ (✅ aplicada 24-09), `SUPABASE_SERVICE_ROLE_KEY` y `DOCUMENTS_LINK_BASE_URL` en la API, cookie `.aisapira.com` en ambos fronts; cerrar el bucket público `client_documents` (8 docs) y filtrar `deleted_at` en su policy (detalle en `docs/cambios/clientes-rediseno-lab.md`) | Leon (con OK de Domi) |
