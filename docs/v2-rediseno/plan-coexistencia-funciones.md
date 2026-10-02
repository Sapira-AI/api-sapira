# Plan de coexistencia · funciones, triggers y tablas de Contratos mientras conviven los dos fronts

> 28-09-2026 · para Domi. Responde: "de los flujos que hablamos, qué funciones quedan, cuáles se reemplazan o unifican;
> cuáles se pueden aplicar YA sin romper el front viejo, y cuáles hay que documentar y aplicar solo después del switch al
> front nuevo y la baja del front viejo". Consolida [`auditoria-contratos.md`](./auditoria-contratos.md),
> [`saneamiento-contratos.md`](./saneamiento-contratos.md), [`mapa-v2-contratos.md`](./mapa-v2-contratos.md),
> [`spec-pricing-v2.md`](./spec-pricing-v2.md), [`spec-modificaciones-contrato-v2.md`](./spec-modificaciones-contrato-v2.md),
> [`manual-modificaciones-contratos.md`](./manual-modificaciones-contratos.md), [`spec-tablas-por-modulo.md`](./spec-tablas-por-modulo.md),
> `ROADMAP-V2.md`, `sapira-ai/docs/ROADMAP-OPERATIVO.md` y `front-sapira/app/(protected)/lab/contratos/flujo-y-funciones.md` §5,
> verificado contra el código v2 (`src/modules/contracts/*`), el corpus (`src/databases/postgresql/{functions,triggers,cron,grants}`)
> y el front viejo (`sapira-ai/src`, grep de `supabase.rpc('<fn>')` y `.from('<tabla>')` el 28-09). Donde el uso real no está
> medido dice **por verificar en logs**. No propone decisiones nuevas de producto: ordena las ya tomadas en tres momentos.

## 1. Resumen ejecutivo

1. Las **tres ventanas** son: **AHORA** (no rompe el front viejo porque él no lo llama, o es un fix compartido que lo mejora),
   **AL SWITCH de Contratos** (`appModules.contratos.migrated = true` en `front-sapira/lib/app-links.ts:34`, hoy `false`: el
   front viejo deja de escribir contratos) y **DESPUÉS de la baja del front viejo** (deja de existir todo llamador `authenticated`
   vía PostgREST, incluidas Facturación, Revenue, períodos, legacy y tenancy).
2. El código v2 **no llama ninguna RPC de negocio**: solo `revenue_schedule_rebuild(...)` (3 sitios), `set_config('sapira.writer'…)`
   y locks. Escribe directo en `contracts`, `contract_items`, `invoices`, `invoice_items`, `contract_fx_period_rates`, `prices`,
   `consumption_entries`, `contract_lifecycle_events`. **Nunca** escribe `contract_invoices` ni `quantities` (las lee).
3. Por eso casi todo lo "reemplazable" **no se puede retirar antes del switch**: el front viejo sigue llamando 20 de las 27 RPC
   de contratos (grep 28-09, §2) y escribe `contract_invoices` (4 sitios en `useContractInvoices.ts`) y `quantities`
   (`useQuantityOverrides.ts`, `BulkQuantitiesImportModal.tsx`).
4. **Aplicable ahora** (§3): las 2 migraciones aditivas pendientes (documentos tributarios, Pricing v2) con su seed y policies;
   los 3 fixes compartidos ya aprobados (U13, U9, U8); la costura `sapira.writer` en los triggers que rellenan/pisan (con OK de
   Leon); el `REVOKE` de las 2 funciones sin chequeo de usuario que quedan; el retiro con doble confirmación de ~7 objetos muertos;
   y apagar el cron de auto-renovación (decisión #5, hoy falla siempre).
5. **Al switch** (§4): retiro de las RPC de movimientos/activación/regeneración que solo llama el front viejo, `contract_invoices`
   y `quantities` pasan a solo lectura, `contract_amendments`/workflow se congelan, arranca la migración parcial
   `quantities → consumption_entries`. Condición: que v2 cubra lo que hoy hacen (faltan F4 en activo, Reestructurar, cambio de
   cliente comercial, M4 reactivar, `bulk_restructure_contract_start_dates`).
6. **Después de la baja** (§5): triggers de costura, `standardize_invoice_items`, `generate_missing_invoices_for_contract` con sus
   2 triggers, familia Facturación (unificar/consolidar, emitir, NC), tablas congeladas, tenancy (`get_user_holding_id` es el
   corazón de las RLS: nunca antes).
7. Hay **inconsistencias documentales** (§6) que conviene cerrar antes de ejecutar: destino de `contract_invoices` (4 versiones),
   qué hacer con el cron de auto-renovación, la decisión D-A de la auditoría (obsoleta tras el 25-09), el estado de U1, y el
   mapa §2f que sigue diciendo "emitida → 409" cuando el código ya crea complementaria/NC.

Regla de retiro (saneamiento 24-09): **doble confirmación** = (1) código: ningún llamador alcanzable en `sapira-ai`, `api-sapira`,
`front-sapira`, ni función (`pg_proc.prosrc`), trigger (`pg_trigger`) o `cron.job` que la use; (2) uso: 0 llamadas a
`/rest/v1/rpc/<nombre>` en los logs del gateway de los últimos 30 días. QA antes que prod; OK de Domi por cambio.

## 2. Tabla maestra por objeto

Leyenda · **FV** = front viejo (`sapira-ai/src/…`, grep 28-09) · **v2** = `api-sapira/src/modules/contracts` · Cuándo:
**AHORA** · **SWITCH** (Contratos) · **SWITCH-F** (switch de Facturación) · **BAJA** (baja del front viejo).

### 2a · Activación, estado y regeneración

| Objeto | Tipo | Qué hace hoy | Quién lo usa | Decisión | Cuándo | Riesgo · cómo verificar |
|---|---|---|---|---|---|---|
| `bulk_activate_contracts` | RPC | Activación masiva (572 contratos, auditoría §2b) | FV ✔ `components/contratos/hooks/useBulkActivation.ts` · v2 ✖ (`POST /contracts/activate` propio) | Reemplazar por activación v2; retirar | SWITCH | Bajo. Logs `/rpc/bulk_activate_contracts` = 0 tras el switch |
| `mark_contract_signed_safe` | RPC | Activación individual desde el diálogo de workflow; no valida estado (auditoría §2b) | FV ✔ `hooks/useContractWorkflowV2.ts` · v2 ✖ | Eliminar (v2 ya la "fusionó": solo Borrador → Activo, S1-9) | SWITCH | Bajo. Idem logs |
| `generate_missing_invoices_for_contract` | función | Materializa el cronograma en `invoices` al pasar a Activo; llamada por los 2 triggers y por `bulk_restructure_contract_start_dates` | FV ✔ (`legacy/LegacyContractActivationModal.tsx`, `hooks/useContractInvoiceGeneration.ts`: la auditoría los da por muertos/agotados) · triggers ✔ · v2 ✖ (esquiva por orden de escritura) | **AHORA**: `REVOKE EXECUTE` a PUBLIC/anon/authenticated (auditoría §1, decisión pendiente #1, Leon). **BAJA**: `DROP` con sus triggers | AHORA (grant) · BAJA (drop) | Medio: sin EXECUTE, los 2 llamadores del FV fallarían si alguien los usa → confirmar 0 llamadas en logs 30 días antes del REVOKE |
| `trigger_generate_invoices_on_status_change` / `…_on_contract_signed` (+ triggers `generate_invoices_on_contract_active`, `unified_generate_invoices_on_contract_signed`) | trigger ×2 | Generan facturas al pasar a Activo/Firmado; se saltan si ya hay facturas; duplicados entre sí (auditoría §3) | FV ✔ (implícito: cualquier activación) · v2 esquiva | Costura `sapira.writer` (mapa §4) y unificar en uno (decisión pendiente #9, Leon); `DROP` cuando nadie active sin costura | AHORA (costura + unificar) · BAJA (drop) | Medio: la costura no cambia el FV (nunca setea `writer`); test en QA activando desde ambos fronts |
| `set_booking_date_on_activate` | trigger | Booking = hoy si venía nula (S2-7) | FV ✔ · v2 ✔ (lo usa) | **Queda** | — | — |
| `trigger_revenue_schedule_on_contract_activation` | trigger | Rebuild RSM al activar; se traga errores | ambos | Queda (redundante con el rebuild explícito de v2, inocuo) | BAJA (evaluar) | — |
| `regenerate_contract_invoices_from_items` | RPC | Rearma `contract_invoices` (solo legacy) | FV ✔ `edit/EditableContractItems.tsx`, `edit/EditableContractGeneralInfo.tsx` · v2 ✖ | Retirar (v2 no escribe `contract_invoices`) | SWITCH | Bajo. Logs |
| `regenerate_contract_invoices_for_restructure` | función | Gemela de la anterior con otro filtro | FV ✖ (0 `rpc`) · v2 ✖ · llamadores SQL **por verificar** (`bulk_restructure…`?) | Retirar con doble confirmación | AHORA si `pg_proc.prosrc` no la nombra; si no, SWITCH | Bajo. `pg_proc.prosrc ILIKE '%regenerate_contract_invoices_for_restructure%'` + logs |
| `bulk_restructure_contract_start_dates` | RPC | Mueve fechas de inicio en masa (destructiva multi-tabla) | FV ✔ `hooks/useBulkRestructureDates.ts` · v2 ✖ | **Sin reemplazo v2 hoy** → delegar o construir antes del switch (pregunta §7) | SWITCH (condicionado) | Alto: es multi-tabla; nunca retirar sin sustituto |
| `auto_expire_contracts` | función | Estado Expirado; **sin llamador** (auditoría §3) | FV ✖ · cron ✖ · v2 ✖ (estado derivado `contract-status.ts`) | Eliminar (decisión pendiente #6) | AHORA (doble confirmación) | Bajo. Falta grep en edge functions de `sapira-ai/supabase/functions` + logs |
| `reconcile_contract_status` | función | Puede pasar un contrato a "Terminado" (S3b) | Vive dentro de `approve_contract_amendment` | Retirar junto con su llamador | SWITCH | Bajo |
| `trigger_log_contract_workflow_transition`, `workflow_steps`, `contract_workflow_history` | trigger + tablas | Workflow de aprobación (S1-9/S2-11: se oculta) | FV ✔ (diálogo de workflow; `workflow_steps` 4 lecturas) · v2 ✖ | Ocultar en v2; congelar (solo lectura) | SWITCH (solo lectura) · BAJA (drop tras decidir si la historia migra a eventos) | Bajo |

### 2b · Modificaciones (S3) y sus piezas

| Objeto | Tipo | Qué hace hoy | Quién lo usa | Decisión | Cuándo | Riesgo · cómo verificar |
|---|---|---|---|---|---|---|
| `create_contract_cross_sell` → `approve_contract_amendment` → `recalc_revenue_for_contract` | RPC + 2 funciones | Cross-sell con "aprobación" automática; `recalc` borra `contract_invoices` editables | FV ✔ `lifecycle/hooks/useContractAmendments.ts` · v2 ✖ (`item_add`) | Reemplazadas por `POST /contracts/:id/changes` `item_add`; retirar las tres (S3-10). `recalc` ya sin EXECUTE para roles (grants/020, 24-09) | SWITCH | Medio: `approve_contract_amendment` sin chequeo de usuario → **AHORA** `REVOKE` a roles (decisión pendiente #1); cross_sell la sigue llamando como SECURITY DEFINER |
| `apply_quote_downsell_to_contract` | RPC | Downsell parcial / por precio / renegociación (14 usos, rama renegociación 0) | FV ✔ `cotizaciones/modals/AssignToContractModal.tsx`, `lifecycle/modals/ContractionModal.tsx` · v2 ✖ (`item_change`) | Reemplazar; retirar | SWITCH | Bajo. Logs. Nota: renegociación con cambio de frecuencia/término sigue **ABIERTA** en v2 (S3-15 → 400) |
| `apply_contract_contraction` | RPC | Churn total / de ítem (la canónica, 41 usos) | FV ✔ `useContractAmendments.ts` · v2 ✖ (`item_remove`, `contract_cancel`) | Reemplazar; retirar | SWITCH | Medio: v2 no cambia `status` en `item_remove` del último ítem (solo `contract_cancel`) → confirmar comportamiento con las usuarias antes del switch |
| `create_contract_renewal` (v2 SQL) | RPC | Renovación por ítem (33 usos); exige `auth.uid()` (`create_contract_renewal.sql:57-59`) | FV ✔ `useContractAmendments.ts` · cron `auto-renew-contract-items` ✔ (falla siempre) · v2 ✖ (`renewal` mismo precio) | Reemplazar; retirar con el cron | SWITCH (función) · ver cron abajo | Medio: `renewal` v2 con cambio de precio → 400 hasta S3-15; el FV sí lo permite (`EnhancedRenewalModal`) |
| `apply_renewal_price_split` | función | Split RSM mes 1 de renovación con precio nuevo | RSM (rebuild) | Queda hasta S3-15; si se unifica el almacenamiento, retirar | BAJA (o antes con S3-15 cerrada) | Bajo |
| Upsell inline (`UpsellingModal`), `AssignToContractModal` (rama upsell/cross-sell) | escrituras FV en 5–6 tablas sin transacción | Bugs 22/23-09, B1 | FV ✔ · v2 ✖ | Reemplazadas por `item_change`/`item_add`; el FV se apaga al switch | SWITCH | Alto mientras conviven: cada upsell del FV puede dejar datos que v2 luego lee (líneas CLF en PE CLP, U3). Sensor de invariantes antes/después (auditoría §6.3) |
| `change_contract_currency` | RPC | Cambia moneda solo en borrador | FV ✔ `edit/Editable*.tsx` · v2 ✖ (`PUT /contracts/:id` con `sapira.skip_currency_validation`) | Reemplazar; retirar | SWITCH | Bajo |
| `change_contract_commercial_client` | RPC | Cambia cliente comercial (rechaza Activo) | FV ✔ `edit/EditableContractGeneralInfo.tsx` · v2 parcial (`change_entity` solo misma razón/cliente; `client_id` → 400, spec §2.10a) | Reemplazar tras cerrar §2.10a; retirar | SWITCH (condicionado) | Bajo |
| `sync_invoices_for_contract_item` | RPC | Editar ítems post-firma → sincroniza PE (22 usos) | FV ✔ `edit/EditableContractItems.tsx` · v2 ✖ | Reemplazar por F4 + F3. **F4 sobre contrato Activo no está construido** (solo `PUT` de borrador, flujo §2) | SWITCH (condicionado a F4) | Alto si se retira sin F4. Logs |
| `invoice_reschedule_items` + `check_contract_item_continuity` | RPC + función | Reestructurar cronograma (74 usos); U1 regresión viva (ROADMAP 23-09 #3, 2º caso NSAgro 28-09); U2 "no empeorar" (S4-13) | FV ✔ `detail/restructure/useRestructureDraft.ts` · v2 ✖ | Mapa §7.3: "Reestructurar no se descarta; se decide al construir" → delegar o F2/F3. Mientras: **asset correctivo U1/U2 en su lugar** (pregunta §7) | AHORA (U1/U2, si Domi lo aprueba) · SWITCH (retiro) | Alto: 53 PE en riesgo (S4-3). Test e2e QA de los 3 caminos + regresión NSAgro/Salvador |
| `set_contract_item_end_date` (`trg_set_contract_item_end_date`) | trigger | `end_date = inicio + término − 1` en INSERT/UPDATE (causa Bosch) | FV ✔ · v2 escribe el mismo valor y fija el fin explícito con UPDATE posterior | Costura `sapira.writer` | AHORA (costura) · BAJA (drop) | Bajo: el FV no setea `writer` |
| `inherit_auto_renew_from_quote_item` | trigger BEFORE INSERT | Hereda `auto_renew` tratando `false` como null (S1-5) | FV ✔ · v2 esquiva con UPDATE | Costura (S1-5 diferido para el FV) | AHORA (costura) · BAJA | Bajo |
| `trg_set_contract_item_categoria` (`trg_calculate_contract_categoria`) | trigger | Calcula `categoria` al insertar | ambos (v2 respeta la explícita) | Costura | AHORA · BAJA | Bajo |
| `auto_calculate_pricing_fields`, `update_contract_term` | triggers | Mensual/período/final; `contracts.term = MAX` | ambos | **Quedan** (v2 manda el mismo cálculo) | — | — |
| `prevent_end_date_update_when_active`, `trg_00_period_guard_*`, `validate_contract*_currency_consistency`, `trg_audit_*` | triggers | Invariantes y auditoría | ambos | **Quedan** (v2 los respeta; bypass explícito solo en el fin del contrato + evento) | — | — |
| `contract_amendments` + `contract_amendment_items` | tablas | 96 amendments, todos Approved (S3-10) | FV ✔ (1 escritura: AssignToContract/Upsell inline; 3 lecturas) · v2 ✖ (eventos) | Congelar (solo lectura); historia → `contract_lifecycle_events` | SWITCH (REVOKE INSERT/UPDATE/DELETE a authenticated) · BAJA (drop tras migrar la historia) | Bajo |
| `contract_lifecycle_events` (+3 triggers `updated_at` idénticos) | tabla | Historial normalizado; ambos escriben | ambos | **Queda**. Unificar los 3 `updated_at` en uno (decisión pendiente #9) | AHORA (updated_at) | Nulo |

### 2c · Facturas del contrato, FX y Facturación (lo que Contratos toca)

| Objeto | Tipo | Qué hace hoy | Quién lo usa | Decisión | Cuándo | Riesgo · cómo verificar |
|---|---|---|---|---|---|---|
| `standardize_invoice_items` (`standardize_invoice_items_trigger`, BEFORE INSERT) | trigger | Pisa cantidad/unitario/subtotal de líneas con `contract_item_id` | FV ✔ (dependen `generate_missing`, sync/restore de `quantities`) · v2 esquiva (patrón B) y fija `writer`, **pero el trigger no lo lee** (grep: ninguna `current_setting` en `standardize_invoice_items.sql`) | Costura ahora; **desaparece o solo rellena lo vacío** cuando el generador v2 sea el único (S4a, Complejos #3) | AHORA (costura) · BAJA (drop) | Medio: el FV y `generate_missing` **dependen** de él; nunca DROP antes de la baja |
| `auto_populate_invoice_tax_rate`, `auto_populate_invoice_fx_to_system`, `invoices_fill_terms_from_contract`, `assign_invoice_group_id`, `auto_populate_invoice_item_fields`, `sync_invoice_item_contract_id`, `sync_invoice_items_on_invoice_update` | triggers | Rellenan encabezado/línea al insertar o actualizar | ambos | **Quedan** (v2 los valida antes: `no_tax_rate`) | — | `auto_populate_invoice_item_fields:33` toma la moneda del ítem aunque el header esté en otra (U3): corregir en Facturación |
| `apply_fixed_fx_to_contract` | RPC | Fija tasa contrato→factura en **todo** el contrato; política antes de validar (bug) | FV ✔ `detail/hooks/useContractInvoices.ts` · v2 ✖ (espeja la rama fija al activar) | Reemplazar por F5 "FX por factura" (S6-1) | SWITCH-F | Medio: el scheduler (`invoice-scheduler.service.ts:1201`) lee `contracts.fx_invoice_policy` → U12/B3 diferido |
| `bulk_confirm_fx_policy` | RPC | Confirma política FX de compañía en lote (ajustada 28-09: `purpose='company'`) | FV ✔ `useBulkActivation.ts` · v2 ✖ | Queda hasta el switch; después la configuración v2 | SWITCH | Bajo. Pendiente FV: `useContractFxRates` debe filtrar `purpose = 'company'` (saneamiento §2) |
| `revenue_schedule_apply_fx_for_contract`, `calculate_contract_fx_rate` | funciones | FX del devengo (corregidas y aplicadas 28-09) | RSM · ambos fronts indirecto | **Quedan** | — | — |
| `contract_fx_period_rates` (+ `purpose`, `trg_contract_fx_rates_updated_at`) | tabla | Tasas fijas `company`/`invoice` | FV lee todas las filas (bug: mostraría `invoice` como compañía) · v2 ✔ | Queda | — | Filtro `purpose` en el FV antes de que v2 cree tasas `invoice` en prod |
| `invoice_items_bulk_update_description`, `invoice_bulk_update_terms`, `invoice_reassign_entity`, `reset_invoice_odoo_draft` | RPC | Acciones masivas de la pestaña Facturas (la 1ª es la más usada: 227) | FV ✔ `detail/hooks/useInvoiceBulkUpdate.ts`, `detail/tabs/ContratoFacturasTab.tsx` (+ Facturación) · v2 ✖ | Módulo `invoices`; `reassign_entity` la absorbe en parte `change_entity` (PE pendientes) | SWITCH-F | Bajo. `reset_invoice_odoo_draft` con bugs B6 (S6-3) |
| `unify_invoices_multi_contract`, `consolidate_invoices_simple`, `unconsolidate_invoices_simple` | RPC | Unificar/consolidar/deshacer | FV ✔ `hooks/useInvoiceConsolidation.ts` · v2 bloquea `unified_invoice_in_range` | Retirar cuando exista multimoneda M3 + ruta declarada (S4-5/6). U3 (guard línea a línea) en su lugar mientras tanto | SWITCH-F (+M3) | Alto: 20 líneas CLF de CTR-2026-86 repiten el $0 en Odoo cada mes (U3) |
| `edit_pending_invoice` | RPC | Editar PE; **0 usos**, su modal nunca se abre (S4b) | FV ✔ (llamador en `facturacion/services/invoiceAdvancedService.ts`, no alcanzable) · v2 ✖ (F2) | Retirar: primero quitar el llamador del FV (como el 24-09), luego DROP con doble confirmación | AHORA (con commit en `sapira-ai`) | Bajo. Logs 30 días |
| `cancel_invoice_with_credit_note` | función | Obsoleta/rota (censo, S4) | **por verificar** (sin `rpc` en el grep de Contratos; revisar Facturación y `pg_proc`) | Retirar | AHORA (doble confirmación) | Bajo |
| `adjust_issued_invoice` (0 usos), `create_credit_note_safe` (112 NC), `emit_invoice_manually`/`_safe`, `bulk_emit_*`, `reschedule_invoice_safe`, `get_next_invoice_number` | RPC | Operación de facturas | FV ✔ (`components/facturacion/**`) · v2 ✖ (crea NC espejo y complementarias por su cuenta) | Facturación decide (S4 "sobreviven / se retiran"); `emit_invoice_safe` y `get_next_invoice_number` marcadas a retirar | SWITCH-F | Fuera del alcance de Contratos; se lista para que el mapa de Facturación las herede |
| `contract_invoices` (+ `trg_cancel_schedule_on_contract_cancelled`) | tabla + trigger | Cronograma previo a activar; 4.891 filas (censo) | FV ✔ **escribe** (`useContractInvoices.ts:474,505,551,871`) y lee en 8 archivos (editor, wizard, legacy, reestructurar fechas, vendedores) · v2 ✖ (test lo exige) | Ver §6.1 (4 versiones en los docs). Propuesta: **solo lectura al switch**, drop después de la baja | SWITCH (REVOKE INSERT/UPDATE/DELETE) · BAJA (drop) | Medio: `useVendedorAnalytics` y el detalle viejo la leen; Reportes v2 debe leer `invoices` antes del drop |
| `invoice_items_quantity_check` `> 0` → `>= 0` | constraint | Migración `1790630000000` (pendiente) | FV: el sync de `quantities` con 0 hoy falla en silencio (Medios #2) | Aplicar con Pricing v2 | AHORA | **Cambia el comportamiento del FV**: un override 0 dejaría la línea en 0 en vez de fallar; la PE no se anula (Medios #2). Confirmar con Domi (§7) |
| `contracts_billing_anchor_day_check`, `_document_type_check`, `_payment_terms_check`, `contract_fx_period_rates_purpose_check` | constraints | Nacieron con v2 (aplicadas 28-09) | v2 | Quedan | — | — |
| UNIQUE (compañía, número) | constraint | No existe; 2 duplicados (CTR-2026-200, 210) | — | Crear tras corregir los datos (Domi) | SWITCH | Dato, no código |

### 2d · Pricing y consumos (S7 → Pricing v2)

| Objeto | Tipo | Qué hace hoy | Quién lo usa | Decisión | Cuándo | Riesgo · cómo verificar |
|---|---|---|---|---|---|---|
| `quantities` (+ `trg_quantities_set_holding`, `trg_validate_quantity_invoice_status`, `trg_sync_invoice_items_from_quantities`, `trg_restore_invoice_items_on_quantity_delete`, `trg_rsm_on_quantity_change`, `trg_restore_rsm_on_quantity_delete`) | tabla + 6 triggers | Cantidades variables por mes | FV ✔ **escribe** (`hooks/useQuantityOverrides.ts:146,207`, `legacy/BulkQuantitiesImportModal.tsx:311`) · API `bigquery.service.ts:1014,1337` **escribe** (canal DWH, 0 filas integradas) · v2 **lee** (`source = legacy`) | Reemplazada por `consumption_entries`. Al switch: solo lectura + migración parcial (spec pricing §7); triggers anotados "reemplazados por consumption.service" | SWITCH (REVOKE + migración) · BAJA (drop) | Alto si el DWH sigue escribiendo `quantities` tras el switch → **antes** re-apuntar `bigquery.service.ts` a `consumption_entries` (etapa 2 pendiente) |
| `sync_invoice_items_amounts_from_quantities` + `restore_invoice_items_amounts_on_quantity_delete` | funciones de trigger | Sync de líneas por override; **no filtran `document_type`** (U13/B4: grep confirma que no aparece) | FV ✔ · v2 ✖ | **Fix compartido U13 AHORA**; retirar con `quantities` | AHORA (fix) · BAJA (drop) | Bajo: 19 NC Por Emitir expuestas hoy. Test QA: override sobre período con NC ligada |
| `update_pending_invoices_on_override` | función | "Está muerta" (S4a) | por verificar `pg_trigger`/`pg_proc` + logs | Retirar | AHORA (doble confirmación) | Bajo |
| `sapira_quantity_imports` + `bigquery.scheduler.ts` (cron horario) | tabla + cron API | Staging DWH → `quantities`; ventana solo mes en curso (B7) | API ✔ · v2 ✖ | Pasa a escribir `consumption_entries` con `source = dwh` e `idempotency_key` (etapa 2) | SWITCH (antes de él) | Medio: decisión pendiente #11 (Leon): `billing_date` = período de servicio, ventana mes anterior, conflictos |
| `billable_metrics`, `prices`, `consumption_entries`, `consumption_entry_revisions`, `contract_items.price_id`, `invoice_items.pricing_breakdown`/`quantity_source` | tablas/columnas nuevas | Pricing v2 etapas 1–2 (migración `1790630000000` + 4 policies RLS) | v2 ✔ · FV ✖ (no las conoce; `price_id NULL` = standard) | **Aplicar** | AHORA | Bajo: aditivo. Riesgo solo el CHECK `>= 0` (fila anterior). Grants: **no** exponer a `anon`; `authenticated` solo si el FV las leyera (no) |
| `tax_document_types` + `contracts.tax_document_type_id` (+ seed 003 + policy select) | tabla/columna nuevas | Alta v2 (migración `1790620000000`) | v2 ✔ · FV ✖ (`document_type` sigue siendo la familia) | **Aplicar** (orden: migración → assets `--only` seed + rls → código) | AHORA | Bajo. Sin seed, el catálogo viene vacío y crear cae al tipo sugerido por país |

### 2e · RSM, crons y tenancy

| Objeto | Tipo | Qué hace hoy | Quién lo usa | Decisión | Cuándo | Riesgo · cómo verificar |
|---|---|---|---|---|---|---|
| `revenue_schedule_rebuild` (+ `_contract_ccy`, `_all`, `_for_invoice`) | funciones | Reconstruye el devengo | FV ✔ `hooks/useMonthlyRevenueSchedule.ts` · v2 ✔ (3 llamadas explícitas) · triggers y 8 funciones SQL | **Queda**. Fix compartido **U8** (acumulado previo) + rebuild completo con OK aparte | AHORA (U8) | Alto: rebuild completo reescribe el devengo de todos → OK explícito de Domi; sensor antes/después (TiMining deferred 3,4 M vs 1,26 M) |
| `trg_rsm_on_contract_item_change` / `_on_invoice_change` / `_on_quantity_change` | triggers | Rebuild parcial **gateado por `get_current_user_holding_id()`** (`trigger_rsm_on_*.sql:13-19`, U9) | ambos (sin sesión no hacen nada: webhook Odoo, DWH, API) | **Fix compartido U9 AHORA**: holding del registro; + la API reconstruye tras el webhook (S5-2) | AHORA | Medio: tras el fix, escrituras sin sesión empiezan a reconstruir el RSM (deseado). QA con webhook simulado |
| `apply_pending_renewal_tail`, `refresh_all_pending_renewals` + cron `refresh-pending-renewals` (06:00) | función + trigger + cron | Proyecta MRR "pendiente de renovar" (PENDING_RENEWAL) | RSM · KPIs FV y v2 (L2 excluye pendiente, S5-3) | **Queda** hasta la sesión RSM (S5) | — | No revisa estado del contrato (S2-10): fix en la sesión RSM |
| `populate_initial_revenue_schedule`, `admin_populate_revenue_schedule`, `revenue_schedule_rebuild_for_invoice` | funciones | Wrappers rotos (S5a) | FV ✔ `revenue/EnableMonthlyScheduleCard.tsx` (la 1ª) · otras sin llamador | Retirar las 2 sin llamador (doble confirmación); la 1ª con el módulo Revenue | AHORA (2) · BAJA (1) | Bajo |
| cron `auto-renew-contract-items` (02:00) → `process_auto_renewals(90)` → `execute_auto_renewal_for_item` → `create_contract_renewal` | cron + 3 funciones | Falla siempre ("Usuario no encontrado", 253 corridas "succeeded") | nadie útil · FV ✖ | **Apagar el job ahora** (`cron.unschedule`) — decisión pendiente #5; funciones se retiran con `create_contract_renewal`. Reemplazo v2 (01-10, B2-4): job `contracts-auto-renewal` de la API que **propone** (`RENEWAL_PROPOSED` + notificación) y nunca renueva sola | AHORA (unschedule, con OK Domi) · SWITCH (drop) | Bajo hoy; **alto si alguien lo arregla** (290 ítems SimpliRoute entran a la ventana desde ~02-10, S2). Verificar `cron.job` y `cron.job_run_details` |
| `validate_fx_confirmation_before_firmado` (`validate_fx_before_firmado`) | trigger | Nunca se dispara (no existe Firmado en la práctica, auditoría §3) | ninguno | Retirar | AHORA (doble confirmación) | Bajo |
| `generate_invoices_for_contract_item` | función | Rota (censo) | por verificar (`pg_proc`, logs) | Retirar | AHORA (doble confirmación) | Bajo |
| `get_current_user_holding_id` (57 archivos FV), `get_user_holding_id` (14 + 385 policies), `rls_*` | funciones tenancy | Sesión/RLS del front viejo | FV ✔ masivo · API ✖ (`HoldingScopeGuard`) | **Quedan hasta la baja** (autorizacion-y-tenancy "Limpieza de la base") | BAJA | Alto: `get_user_holding_id()` es el corazón de las policies; retirar solo tras `REVOKE authenticated` módulo a módulo |
| `REVOKE EXECUTE … FROM authenticated` de las RPC de Contratos | grants | — | — | Al switch, cada función que el FV deja de llamar queda solo para la API/`postgres` | SWITCH | Bajo si el switch redirige `/contratos` y `/cotizaciones?assign…` al front nuevo |

## 3. Aplicable AHORA (sin romper el front viejo)

Orden propuesto; cada paso con la **doble confirmación** del 24-09 (código en los 3 repos + `pg_proc.prosrc` + `pg_trigger` +
`cron.job`; logs del gateway `/rest/v1/rpc/<fn>` 30 días) y el ciclo QA → OK Domi → prod → `schema:status` → snapshot.

1. **Migraciones aditivas pendientes** (saneamiento §3–§4): `1790620000000-CreateTaxDocumentTypes` → `postgres:assets --only
   seed/003-tax-document-types.sql --only rls/tax_document_types_select_authenticated.sql` → `1790630000000-CreatePricingV2` →
   `--only` de las 4 policies `holding_access_*` → deploy del código. Sin ellas fallan `form-options`, crear/activar con `price`,
   `/consumption` y `/billable-metrics`. **Antes**: decidir el CHECK `>= 0` (§7.1). Verificar: `schema:status` 0 pendientes;
   specs `pricing-v2.entity.spec`, `tax-document-type.entity.spec`, `contratos.entities.spec` en verde tras refrescar snapshot.
2. **Grants de seguridad** (auditoría §1, decisión pendiente #1, Leon): `REVOKE EXECUTE` a PUBLIC/anon/authenticated de
   `generate_missing_invoices_for_contract` y `approve_contract_amendment` (asset nuevo en `grants/`, hermano de `020`).
   Verificar: logs 30 días = 0 llamadas directas; activar un contrato y hacer un cross-sell desde el FV en QA (siguen funcionando
   porque las llaman triggers/funciones SECURITY DEFINER).
3. **Fixes compartidos en su lugar** (saneamiento "Capa 1 · Lo único que se corrige en su lugar"), uno por sesión, presentados a
   Domi con función, casos, qué no debe romper y prueba: **U13** (`sync_invoice_items_amounts_from_quantities` + `restore…`
   excluyen NC por `document_type`), **U9** (`trigger_rsm_on_*` toman el holding del registro; API reconstruye tras webhook Odoo),
   **U8** (`revenue_schedule_rebuild_contract_ccy` carga el acumulado previo) + rebuild completo con **OK aparte**. Verificar con el
   sensor de invariantes (auditoría §6.3) antes y después; casos SimpliRoute agosto (51/480), TiMining deferred.
4. **Costura `sapira.writer = 'api'`** (mapa §1.3/§4; ✅ Domi 30-09: todo trigger legacy no-op para la API salvo invariantes; **construida sin aplicar**, orden `--only` y prueba en [`activacion-costura-triggers.md`](./activacion-costura-triggers.md) § Construido, que incluye U9 y el `grants/030` del paso 2):
   `standardize_invoice_items`, `trigger_generate_invoices_on_*`, `set_contract_item_end_date`, `inherit_auto_renew_from_quote_item`,
   `trg_set_contract_item_categoria`. Hoy **ninguna función lee `sapira.writer`** (grep 28-09); la API ya lo fija
   (`contract-changes.service.ts:59,104`, `consumption.service.ts:1073`). Unificar de paso los 2 triggers de generación y los 3
   `updated_at` de `contract_lifecycle_events` (decisión pendiente #9). Verificar en QA: activar/modificar desde **ambos** fronts;
   el FV no cambia (nunca setea la variable).
5. **Retiros con doble confirmación** (objetos sin llamador alcanzable): `auto_expire_contracts`, `update_pending_invoices_on_override`,
   `validate_fx_confirmation_before_firmado` + su trigger, `generate_invoices_for_contract_item`, `cancel_invoice_with_credit_note`,
   `admin_populate_revenue_schedule`, `revenue_schedule_rebuild_for_invoice`, `regenerate_contract_invoices_for_restructure`
   (si `pg_proc` no la nombra). `edit_pending_invoice` requiere antes quitar su llamador en `sapira-ai` (`invoiceAdvancedService.ts`).
   Todos **por verificar en logs** y en `sapira-ai/supabase/functions/*` (edge functions no grepeadas en la auditoría).
6. **Apagar el cron `auto-renew-contract-items`** (`SELECT cron.unschedule('auto-renew-contract-items')` como `postgres`, asset en
   `cron/` anotado) — decisión pendiente #5. Hoy falla en el 100 % de los ítems; apagarlo no cambia nada funcional y elimina el
   riesgo de renovación masiva si alguien "lo arregla". Requiere OK de Domi (§7.3).
7. **Front viejo (sapira-ai)**: filtrar `purpose = 'company'` en `useContractFxRates`/`ContractFxCompanyConfig` antes de que v2
   cree tasas `invoice` en prod (saneamiento §2). Sin esto, el FV mostraría tasas de facturación como de compañía.
8. **U1/U2** (`invoice_reschedule_items`, `check_contract_item_continuity`): regresión nuestra viva (ROADMAP 23-09 #3; NSAgro 28-09).
   El 25-09 se decidió no corregir en su lugar lo que el FV usa, **salvo triggers compartidos**; U1 no es trigger pero corrompe
   datos hoy → decisión de Domi (§7.2). Si se aprueba: asset correctivo (cantidad = override del mes → línea → ítem; vencimiento en
   facturas nuevas; U2 "no empeorar", S4-13), test e2e de los 3 caminos + regresión Salvador/NSAgro/CEFA.

## 4. Al SWITCH de Contratos (`migrated: true`)

Lo que cambia el día que el FV deja de escribir contratos (mapa §1.8 y §5; cada retiro con la doble confirmación):

- **Prerrequisitos de paridad** (hoy no construidos, flujo §6 y mapa "Después"): F4 editar ítems en contrato Activo, Reestructurar
  (delegar o F2/F3), M4 reactivar, M5/`change_entity` con cambio de cliente comercial (§2.10a), renovación con cambio de precio
  (S3-15), sustituto de `bulk_restructure_contract_start_dates`, "Asociar a contrato" desde Cotizaciones con el mismo panel.
  Sin ellos, el switch necesita enlace temporal al FV **solo si no corrompe datos v2** (mapa §7.4).
- **RPC que se retiran** (`REVOKE authenticated` → `DROP`): `bulk_activate_contracts`, `mark_contract_signed_safe`,
  `regenerate_contract_invoices_from_items` (+ `_for_restructure` si quedó), `create_contract_cross_sell` + `approve_contract_amendment`
  + `recalc_revenue_for_contract` + `reconcile_contract_status`, `apply_quote_downsell_to_contract`, `apply_contract_contraction`,
  `create_contract_renewal` (+ `process_auto_renewals`, `execute_auto_renewal_for_item`, `get_items_pending_auto_renewal`; los
  reemplaza la auto-renovación v2 con confirmación: jobs `contracts-auto-renewal` 06:00 y `contracts-scheduled-changes` 05:30 de la API,
  spec modificaciones §9.3.5, B2-4 construido 01-10),
  `sync_invoices_for_contract_item`, `invoice_reschedule_items` + `check_contract_item_continuity` (si F2/F3 cubren Reestructurar),
  `bulk_restructure_contract_start_dates`, `change_contract_currency`, `change_contract_commercial_client`, `bulk_confirm_fx_policy`.
- **`contract_invoices`**: solo lectura (`REVOKE INSERT/UPDATE/DELETE` a `authenticated`); `trg_cancel_schedule_on_contract_cancelled`
  queda inocuo; Reportes/vendedores v2 leen `invoices`. Drop en §5 (ver §6.1).
- **`quantities`**: solo lectura; migración a `consumption_entries` **solo de períodos no emitidos o futuros** de contratos activos
  (spec pricing §7, tabla de mapeo; `unit_price` de override **no** se migra: lista para revisión de Domi); triggers de `quantities`
  anotados "reemplazados por consumption.service". **Antes**: `bigquery.service.ts` escribiendo `consumption_entries` (`source = dwh`,
  `idempotency_key`), decisión #11 de Leon cerrada.
- **`contract_amendments`/`_items`, `workflow_steps`, `contract_workflow_history`**: solo lectura; limpiar los 4 Activo con paso
  asignado (S2-11).
- **UNIQUE (compañía, número)** tras corregir CTR-2026-200/210.
- **Cron `auto-renew-contract-items`**: si no se apagó en §3, se apaga aquí; E2 (propuesta de renovación con confirmación) lo reemplaza.
- **Grants**: todo lo que el FV deja de llamar pierde `authenticated`; las tablas nuevas de v2 nunca reciben grants para `anon`.
- **Datos**: no se tocan filas de clientes (regla del bloque); las normalizaciones de `type`, `item_type`, `event_type` (decisión
  pendiente #8) se planifican como migración de datos aparte.

## 5. DESPUÉS de la baja del front viejo

- Triggers de la costura y `standardize_invoice_items` (cuando el generador v2 sea el único que inserta líneas con ítem);
  `generate_missing_invoices_for_contract` + `trigger_generate_invoices_on_*` + sus 2 triggers.
- `contract_invoices` (drop, con `trg_cancel_schedule_on_contract_cancelled`), `quantities` + 6 triggers + `sync/restore…from_quantities`,
  `contract_amendments`/`_items`, workflow (tablas y `trigger_log_contract_workflow_transition`), `contract_billing_splits`
  (→ `invoice_routes`, A.5), `apply_renewal_price_split` si S3-15 unifica el almacenamiento.
- Familia Facturación (con su propio mapa): `apply_fixed_fx_to_contract`, `invoice_items_bulk_update_description`,
  `invoice_bulk_update_terms`, `invoice_reassign_entity`, `reset_invoice_odoo_draft`, unificar/consolidar/desunificar (tras M3 y
  ruta declarada), `emit_invoice_safe`, `get_next_invoice_number`, `edit_pending_invoice`/`adjust_issued_invoice` si S4-1 los
  elimina, `create_credit_note_safe` cuando la API envíe NC reales (S4-8, Leon).
- Revenue/períodos: `populate_initial_revenue_schedule`, `revenue_monthly_journal`/`_summary` (siempre vacías), `close_period_until`
  / `reopen_period_from` / `get_cutoff_date` (pasan a API de períodos, spec-tablas módulo 7).
- Legacy (S8, "al final del rediseño"): las 8 funciones vivas (`create_contract_from_mrr_legacy`, `create_legacy_contract_with_items`,
  `reconcile_legacy_*`, `update_legacy_reconciliation_pct`, `mark_mrr_legacy_skip_activation`, `delete_mrr_legacy_group`) → módulo
  Historia del cliente; mientras, U14–U18 en su lugar.
- Tenancy: `get_current_user_holding_id`, `get_user_holding_id`, `rls_*`, variantes `_safe/_robust/_direct`, y las 385 policies
  que dependen de ellas — solo cuando **ningún** cliente use PostgREST con `authenticated` (autorizacion-y-tenancy "Limpieza de la
  base" → "Después").

## 6. Inconsistencias entre documentos

1. **Destino de `contract_invoices`** (cuatro versiones). `auditoria-contratos.md` S4-4: "**(b)** Queda como **registro de lo
   firmado**; mandan las facturas Por Emitir". `mapa-v2-contratos.md` §7.2: "el cronograma (`contract_invoices`) es solo la **vista
   previa antes de activar**: v2 no lo escribe". `flujo-y-funciones.md` §5: "**No se escribe**; **eliminar al switch**".
   `spec-tablas-por-modulo.md` módulo 5: "🗑️ Redundante". Además el FV la **escribe** en 4 sitios y la lee en 8. Propuesta:
   S4-4 manda mientras exista el FV (registro histórico, solo lectura al switch), drop después de la baja y de que Reportes v2 lea
   `invoices`. Actualizar flujo §5 ("al switch" → "solo lectura al switch, drop tras la baja").
2. **Cron de auto-renovación**. `mapa-v2-contratos.md` E2: "El cron viejo **no se arregla** (decisión #5)". `spec-modificaciones…`
   §2.5/§8.5: "**apagar el cron al publicar E2 y no antes** (hoy falla, no hay riesgo)". `auditoria-contratos.md` S2: "290 ítems
   `auto_renew` … entran a la ventana de 90 días desde ~**02-10** … **no hay riesgo mientras nadie lo arregle**". Decisión
   pendiente #5 sigue abierta. Propuesta: apagarlo **ahora** (elimina el riesgo de que un arreglo bienintencionado renueve en masa;
   E2 no depende de él).
3. **D-A de la auditoría vs estrategia del 25-09**. `auditoria-contratos.md` §6.7 D-A recomienda "**(2)**: una función SQL atómica
   `apply_quote_upsell_to_contract` … que el front viejo llama en lugar de los inserts"; `sapira-ai/docs/ROADMAP-OPERATIVO.md`
   Complejos #1 sigue pidiendo "refactor AssignToContract a RPC atómica". `saneamiento-contratos.md` "Cambio de estrategia (Domi
   25-09)": "En vez de corregir en su lugar … **se construye la v2 al lado**". Propuesta: marcar D-A y U4 como **cubiertos por
   `item_add`/`item_change`** (mapa M1) y anotarlo en ambas copias del ROADMAP-OPERATIVO (la de `api-sapira` está desincronizada:
   auditoría §6.1, "164 líneas vs 179").
4. **Estado de U1 (Reestructurar con overrides)**. ROADMAP-OPERATIVO 23-09 #3: "El asset está aplicado en prod y **SIN commit**
   (pendiente validación Fernanda): corregir antes de commitear". `auditoria-contratos.md` §6.1: "El fix del 21-09 **ya está
   commiteado** (`a2647bc`) … El asset vigente no lee `quantities` → la regresión está viva". Y el 28-09 apareció un 2º caso
   (NSAgro). Bajo la estrategia del 25-09 no está claro si U1 se corrige en su lugar (§7.2). Propuesta: sí, como excepción
   explícita (regresión propia que corrompe datos), asset correctivo con test e2e.
5. **Consumo con factura emitida**. `mapa-v2-contratos.md` §2f P4: "emitida → **409 `consumption_period_issued`**" y `spec-pricing-v2.md`
   §8.4 lo deja como pregunta abierta ("¿solo bloqueo explicado … o ya la factura complementaria?"). Pero `flujo-y-funciones.md` §1/§2
   describe lo construido: "`on_issued` (`block` por defecto, `additional`, `reissue`) … crea la complementaria o la NC + nueva
   factura (eventos `CONSUMPTION_ADDITIONAL_INVOICE` / `CONSUMPTION_REISSUE`)". Propuesta: cerrar la pregunta 4 como decidida
   (S7-8) y actualizar mapa §2f y saneamiento §4.
6. **Nombre técnico del consumo**. `glosario.md` y `spec-tablas-por-modulo.md` módulo 4/6: `quantity_entries`; `spec-pricing-v2.md`
   §2.3 y el código: `consumption_entries`. Propuesta: el glosario adopta `consumption_entries` (nombre en la base).
7. **Capa 2 del saneamiento vs mapa**. `saneamiento-contratos.md` Capa 2 (escrita antes del 25-09) dice para `mark_contract_signed_safe`
   "Fusionar en `bulk_activate_contracts` (`POST /contracts/activate`) y retirar" y para `regenerate_*` "Fusionar en una"; el mapa
   C2/F1 las **reemplaza** por activación y generador v2 (ninguna fusión SQL). Propuesta: reescribir esas filas como "reemplazada por
   X; retirar al switch", igual que mapa §5.
8. **Facturación en Next**. `front-sapira/AGENTS.md`: "**Facturación operativa** (`/facturacion`) vive en Vite; no implementar ese
   módulo en Next". El módulo `contracts` v2 ya crea NC espejo, facturas complementarias y edita Por Emitir del contrato (F2/F3,
   `item_remove`, `on_issued`). `mapa-v2-contratos.md` §7.5 lo anticipa ("se actualiza esa regla"). Propuesta: precisar la regla:
   Facturación **como módulo** sigue en Vite; las operaciones sobre facturas **del contrato** viven en Contratos v2.

## 7. Preguntas para Domi

1. **CHECK `invoice_items_quantity_check` `>= 0`** (migración Pricing v2): ¿se aplica ahora aunque cambie el comportamiento del
   front viejo con override 0 (la línea queda en 0 en vez de fallar en silencio; la PE no se anula, Medios #2), o se difiere al switch?
2. **U1/U2 en su lugar**: ¿se corrige `invoice_reschedule_items` / `check_contract_item_continuity` ahora como excepción a "no
   corregir lo que el FV usa" (regresión nuestra, 2 casos, 53 PE en riesgo), o se espera al reemplazo de Reestructurar en v2?
3. **Cron `auto-renew-contract-items`**: ¿OK para `cron.unschedule` ahora (decisión pendiente #5)? Hoy falla en el 100 %.
4. **Costura `sapira.writer`**: ¿OK tuyo para tocar los 5 triggers ahora? (Leon no interviene: no es integración) Sin ella, v2 sigue esquivando
   con patrón B y UPDATE posterior (funciona, pero cada nuevo flujo repite el truco).
5. **Retiros "AHORA" del §3.5**: ¿los ejecutamos en un solo bloque (como el 24-09) tras la doble confirmación, o uno por uno?
6. **Reestructurar y `bulk_restructure_contract_start_dates`** al switch: ¿delegar en las funciones actuales desde la API (paridad) o
   exigir F2/F3 antes de `migrated: true`? Define si el switch puede ser en semanas o depende de dos piezas grandes.
7. **`contract_invoices`**: ¿confirmas la propuesta §6.1 (solo lectura al switch como "registro de lo firmado", drop tras la baja)?
8. **Canal DWH**: ¿`bigquery.service.ts` pasa a `consumption_entries` **antes** del switch (bloqueante) o se acepta una ventana en
   que el DWH siga escribiendo `quantities` (que v2 solo lee)?
