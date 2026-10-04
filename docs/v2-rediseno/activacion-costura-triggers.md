# Activación v2 · qué se limpia o unifica (triggers y funciones)

> Análisis de solo lectura del 30-09-2026 sobre `contract-activation.service.ts` y los assets de `triggers/` y `functions/`. Complementa `plan-coexistencia-funciones.md` §3/§4 y `mapa-v2-contratos.md` §4/§7.1. Decisiones de Domi al final.
>
> **Estado 30-09: construido, sin commit y sin aplicar** (ver [§ Construido](#construido-30-09-sin-commit-sin-aplicar)). La columna
> "Decisión propuesta" de la tabla quedó superada por la regla de Domi: **toda** la lógica de negocio a la API; Postgres solo con
> invariantes ([`logica-en-api-triggers.md`](../reglas-desarrollo/logica-en-api-triggers.md)).

## Qué hace hoy la activación v2

En una transacción por contrato: (1) INSERT de facturas Por Emitir y sus líneas **sin** `contract_item_id` + UPDATE que lo fija (patrón B); (2) `UPDATE contracts SET status='Activo'`; (3) `revenue_schedule_rebuild(id, NULL)`; (4) evento `ACTIVATION`.

**Hallazgos:** la activación **no fija `sapira.writer`** (sí lo hacen cambios, facturas y consumos) y **ninguna función SQL lo lee todavía**: la costura exige el `set_config` en la activación y el `IF current_setting(...)` en cada función. La API no tiene `auth.uid()`: los triggers gateados por `get_current_user_holding_id()` no hacen nada en llamadas de la API y la auditoría registra usuario NULL.

## Tabla

| Objeto | Hoy | Al activar v2 | Decisión propuesta | Riesgo front viejo |
|---|---|---|---|---|
| `generate_invoices_on_contract_active` → `trigger_generate_invoices_on_status_change` | genera facturas legacy al pasar a Activo salvo que existan | se salta (v2 ya insertó) | costura no-op + unificar con el siguiente (decisión #9); DROP en la baja | nulo |
| `unified_generate_invoices_on_contract_signed` | duplicado del anterior (INSERT/Firmado/Activo) | se salta | unificar; conservar la rama INSERT/Firmado del FV | nulo |
| `generate_missing_invoices_for_contract` | materializa facturas legacy | no se llama | REVOKE a anon/authenticated ahora (30 días de logs en 0); DROP en la baja | medio |
| `set_booking_date_on_activate` | booking = hoy si NULL | igual que v2 espera (S2-7) | mantener | — |
| `trigger_revenue_schedule_on_contract_activation` | rebuild dentro del UPDATE, traga errores | duplica el rebuild explícito | costura no-op (opcional) | nulo |
| `trg_rsm_on_invoice_change` / `_contract_item_change` / `_quantity_change` | rebuild parcial gateado por holding de sesión | no hacen nada en la API; tras U9 dispararían N veces | al aplicar U9: no-op bajo `writer='api'` | nulo |
| `auto_calculate_contract_fx` → `calculate_contract_fx_amounts` | FX a sistema y `total_value_system_currency` con UPDATE anidado | escribe datos que v2 no calcula | mantener; reemplazar por lógica en el servicio al switch | — |
| `set_contract_company_currency` | rellena `company_currency` | inocuo | mantener | — |
| `trg_00_period_guard_contracts` | guard de período | `status` no está en la lista → pasa | mantener | — |
| validadores de moneda | exigen coincidencia | pasan (v2 bloquea antes) | mantener | — |
| `validate_fx_before_firmado` | exige FX al pasar a Firmado | no se dispara | retirar con doble confirmación | bajo |
| `trg_audit_contract_changes` | `contract_change_log` en Activo | 2 filas (estado + FX), usuario NULL; historial duplicado con `ACTIVATION` | mantener; con `writer='api'` marcar `source='api'` | nulo |
| `trigger_log_contract_workflow_transition` | solo `current_step_id` | no se dispara | congelar al switch | — |
| `standardize_invoice_items` (BEFORE INSERT) | pisa cantidad/unitario/subtotal si hay `contract_item_id` | se salta por el patrón B | costura no-op → el patrón B deja de hacer falta; DROP en la baja | nulo (FV depende) |
| `trigger_auto_populate_invoice_item_fields` | copia cabecera; con ítem pisa `contract_currency` (U3) | copia cabecera | mantener; U3 en Facturación | — |
| `trigger_sync_invoice_item_contract_id` | adivina el ítem por descripción en `contract_invoices` | puede adivinar; el UPDATE lo corrige | costura no-op o retirar al switch | bajo |
| `trigger_auto_populate_invoice_tax_rate` | IVA de la compañía si NULL | se salta | mantener | — |
| `trigger_auto_populate_invoice_fx_to_system` | montos en moneda del sistema | **v2 depende** | mantener | — |
| `invoices_fill_terms_from_contract_trigger` | términos del contrato si NULL | rellena (deseado) | mantener | — |
| `trg_assign_invoice_group_id` | `invoice_group_id` | inocuo | mantener | — |
| `sync_invoices_for_contract_item` (RPC) | editor de ítems post-firma legacy | no corre | retirar al switch / reemplazar por F4 v2 | alto si se toca antes |
| `trg_set_contract_item_end_date` | fin = inicio + término − 1 | recalcula lo que v2 manda (C1/PUT) | costura no-op | nulo |
| `trg_inherit_auto_renew_from_quote_item` | hereda auto-renovación pisando `false` | pisa datos en C1 (S1-5) | costura no-op | nulo |
| `trg_set_contract_item_categoria` | categoría si NULL | se salta si v2 la manda | costura no-op | nulo |
| `auto_calculate_pricing_fields` | mensual y por período | v2 confía en él (C1/PUT) | mantener; reemplazar con Pricing v2 al switch | — |
| `trigger_update_contract_term` | `contracts.term = MAX(term_months)` con UPDATE anidado | corre en C1/PUT | mantener; lógica en servicio al switch | — |
| `trg_z_fix_renewal_annual`, `trg_zzz_pending_renewal_on_item_change` | renovaciones / PENDING_RENEWAL | no corren al activar | mantener (sesión RSM) | — |

## Orden propuesto

**(a) Ahora, con la costura** (decisión de Domi, dueña de funciones y triggers; Leon solo valida lo que toque integraciones; el front viejo nunca fija `writer`): 1) `set_config('sapira.writer','api',true)` en la activación y en C1/PUT; 2) no-op bajo `writer='api'` en: los 2 triggers de generación (unificados), `standardize_invoice_items`, `set_contract_item_end_date`, `inherit_auto_renew_from_quote_item`, `trg_set_contract_item_categoria`, `trigger_revenue_schedule_on_contract_activation` (opcional), `sync_invoice_item_contract_id`; 3) U9 en `trg_rsm_on_*` + no-op para la API; 4) REVOKE de `generate_missing_invoices_for_contract`; 5) retirar `validate_fx_before_firmado`; 6) probar en QA activando desde ambos fronts y comparando facturas, RSM, `contract_change_log` y `booking_date`.

**(b) Al switch o en la baja:** DROP de los triggers de generación y de `generate_missing_invoices_for_contract`; retirar `sync_invoices_for_contract_item`; DROP de `standardize_invoice_items` y `sync_invoice_item_contract_id`; pasar `auto_calculate_contract_fx` y `update_contract_term` a lógica en el servicio; evaluar el DROP del rebuild en activación; congelar el workflow.

**Mantener siempre:** booking, `company_currency`, guard de período, validadores de moneda, IVA, FX al sistema, términos, `group_id`, auditoría.

**Por verificar:** que la API no setee `request.jwt.claims`; la lista completa de campos del guard de período frente al UPDATE de FX; que C1 y PUT fijen `writer`.

## Decisiones de Domi

- ✅ 30-09: **lógica de negocio en la API; Postgres solo invariantes.** Con `sapira.writer = 'api'` todo trigger legacy de la
  lista es no-op para la API salvo los invariantes (`trg_00_period_guard_contracts` y los validadores de moneda). El front viejo
  nunca fija la marca: su comportamiento no cambia. Se construye todo junto (costura + campos explícitos + retiro del patrón B).
- ✅ 30-09: los dos triggers de generación se unifican (decisión #9); `validate_fx_before_firmado` queda no-op para la API y va a
  la lista de retiro (DROP con doble confirmación); `trg_audit_contract_changes` no-op para la API (el historial v2 es el evento).
- Pendiente: OK para `grants/030` (REVOKE de `generate_missing_invoices_for_contract`): el front viejo **todavía la llama por rpc**
  desde la pestaña Legacy (ver § Construido).

## Construido (30-09, sin commit, sin aplicar)

### API (`src/modules/contracts`, `src/modules/quotes`)

- **`api-writer.ts`**: `setApiWriter(runner)` = `SELECT set_config('sapira.writer','api',true)` (local a la transacción) y
  `withApiWriter(dataSource, work)` para escrituras que eran una sola sentencia. Es la **primera sentencia** de toda transacción v2
  que escribe: activación, borrador (alta, PUT, condiciones, borrado y borrado masivo), masivos de configuración, cambios, acciones
  de facturas (emisión externa, reprogramar, FX), consumos, precios (alta, edición, publicar, archivar, nueva versión), métricas
  facturables y cotizaciones (alta, PUT, etapa, duplicar, borrar) y etapas de cotización. Un spec recorre el texto de cada
  `*.service.ts` y exige que después de cada `startTransaction()` la primera sentencia sea la marca.
- **`api-written-fields.ts`**: lo que antes rellenaban triggers (la aritmética en moneda del sistema corre en SQL con `ROUND`
  numérico). Nació como réplica exacta; la auditoría del 30-09 ([`activacion-campos-api.md`](./activacion-campos-api.md))
  corrigió las réplicas de bugs documentados (dirección de la tasa con `monthly_avg`, IVA 0,19, anual con descuento, pago único,
  plazo indefinido, moneda de compañía, NC espejo, categoría con borradores borrados): la tabla de abajo es el inventario original.

  | Campo | Antes (trigger) | Ahora (API) |
  |---|---|---|
  | `contract_items`/`quote_items`: `unit_price` (modo anual), `annual_unit_price`, `annual_price`, `price_entry_mode`, `monthly_price`, `billing_period_price` | `auto_calculate_pricing_fields` | `pricingFields()` en alta/PUT de borrador, `insert_item` de cambios y alta/PUT/duplicar de cotizaciones |
  | `contract_items.end_date` | `set_contract_item_end_date` | explícito en INSERT/UPDATE (co-terminación va en el INSERT; se quitó el UPDATE posterior) |
  | `contract_items.categoria` | `trg_set_contract_item_categoria` | INSERT del borrador con `calculate_contract_item_categoria` (cambios ya la mandaba) |
  | `contract_items.auto_renew` | `inherit_auto_renew_from_quote_item` (pisaba `false`, S1-5) | lo elegido; se quitó la corrección posterior |
  | `contracts.term` | `update_contract_term` | `syncContractTerm()` tras escribir ítems (alta, PUT, cambios) |
  | `contracts.booking_date` | `set_booking_date_on_activate` | activación: `COALESCE(booking_date, CURRENT_DATE)` con el contrato aún en borrador (S2-7) |
  | `contracts.company_currency` | `set_contract_company_currency` | alta/PUT (ya) y activación `COALESCE` |
  | `contracts.fx_rate_to_system`, `total_value_system_currency`, `system_currency` | `auto_calculate_contract_fx` → `calculate_contract_fx_amounts` | `refreshContractSystemFx()` en la activación (antes del estado, el guard de período no mira borradores) y en cambios cuando se cumple la condición del trigger (`contractFxNeedsRefresh`); no bloquea (SAVEPOINT) |
  | `invoices.fx_contract_to_system`, `system_currency`, `amount_system_currency`, `total_system_currency` | `auto_populate_invoice_fx_to_system` (INSERT y cada UPDATE) | `refreshInvoiceSystemAmounts()` después de cada INSERT/UPDATE de facturas v2 (activación, cambios, NC espejo, consumos, emisión externa, reprogramar, FX) |
  | `invoices.invoice_group_id` | `assign_invoice_group_id` | id generado en el mismo INSERT (`gen_random_uuid()`) = grupo; NC: el de la factura espejada |
  | `invoices.invoice_terms_and_conditions` | `invoices_fill_terms_from_contract` | copia del contrato en el INSERT (consumos: la de la emitida o, si no tiene, la del contrato) |
  | `invoices.tax_rate` | `auto_populate_invoice_tax_rate` | ya explícito (la activación bloquea sin IVA configurado) |
  | `invoice_items`: `contract_item_id`, `status`, `issue_date`, `product_id`, monedas | `standardize_invoice_items` + `auto_populate_invoice_item_fields` (+ patrón B) | **patrón B retirado**: la línea nace con `contract_item_id`; `status`/`issue_date` del encabezado; producto y monedas explícitos |
  | RSM al activar / al tocar facturas o ítems | `trigger_revenue_schedule_on_contract_activation`, `trg_rsm_on_*` | `revenue_schedule_rebuild` explícito (ya existía) |
  | Auditoría | `trg_audit_contract_changes` → `contract_change_log` | evento v2 en `contract_lifecycle_events` (la API no escribe `contract_change_log`) |

### Assets y migración (`src/databases/postgresql`)

- **23 funciones editadas en su lugar**: primera sentencia `IF current_setting('sapira.writer', true) = 'api' THEN RETURN NEW|NULL;
  END IF;` (NEW en las BEFORE, NULL en las AFTER). Firmas y cuerpos restantes sin cambios (comparados con QA 30-09 en `READ ONLY`:
  iguales salvo comentarios).
- **U9** en `trigger_rsm_on_contract_item_change`, `_invoice_change` y `_quantity_change`: `financial_settings` del holding de la fila
  (`NEW/OLD.holding_id`), no `get_current_user_holding_id()`. Efecto buscado: las escrituras sin sesión (webhook Odoo, DWH, cron)
  empiezan a reconstruir el RSM.
- **Generación unificada**: `trigger_generate_invoices_on_contract_signed` pasa a `SECURITY DEFINER` (rama INSERT/Firmado/Activo del
  front viejo intacta) y la migración `1790660000000-UnificaTriggerGeneracionFacturas` elimina el trigger duplicado
  `generate_invoices_on_contract_active` (se borra su asset). No es un `DROP` dentro del asset: eliminar es migración (CLAUDE.md) y
  `schema:status` vería el asset distinto para siempre. `trigger_generate_invoices_on_status_change` queda sin trigger, con la costura.
- **Invariantes sin tocar**: `trg_period_guard_contracts`, `validate_contract_currency_consistency`,
  `validate_contract_item_currency_consistency` (no hay validador de moneda a nivel factura en el corpus). También siguen corriendo
  para la API (no están en la lista): `trg_00_period_guard_contract_items`, `prevent_end_date_update_when_active` (con su bypass
  explícito), `trg_audit_contract_item_changes`, `trg_z_fix_renewal_annual`, `trg_zzz_pending_renewal_on_item_change`,
  `trg_cancel_schedule_on_contract_cancelled`, `sync_invoice_items_on_invoice_update` (decisión de Domi 02-10: se deja como está: espejo de status e issue_date en las líneas, invariante simple hasta el switch; la API no escribe esos campos), los de `quantities` y los `updated_at`.
  ⚠️ `trg_z_fix_renewal_annual` pisa precio anual y mensual de un RENEWAL cuyo original era anual: candidato a la próxima tanda.
- **`grants/030-generate-missing-invoices-execute.sql`** (aparte): REVOKE a PUBLIC/anon/authenticated, EXECUTE a `service_role`.
  **No aplicar sin OK**: el front viejo la llama por rpc desde código montado (`LegacyContractActivationModal.tsx:161` en la pestaña
  Legacy; `useContractInvoiceGeneration.ts:12`). QA 30-09: anon y authenticated tienen EXECUTE.

### Orden de aplicación (QA primero, después de commitear)

El código nuevo depende de los assets (sin patrón B, con `standardize_invoice_items` activo la línea se pisaría) y los assets dejan
de rellenar campos que el código viejo no escribía: **aplicar y desplegar en la misma ventana**. En producción v2 está apagado
(`DESIGN_LAB_ENABLED`), así que la ventana no tiene escrituras v2.

```bash
DOTENV_CONFIG_PATH=.env.qa.db yarn schema:status --target qa
DOTENV_CONFIG_PATH=.env.qa.db yarn migration:run --target qa          # 1790660000000-UnificaTriggerGeneracionFacturas (+ las pendientes previas)
DOTENV_CONFIG_PATH=.env.qa.db yarn postgres:assets --apply --target qa \
  --only functions/trigger_generate_invoices_on_contract_signed.sql \
  --only functions/trigger_generate_invoices_on_status_change.sql \
  --only functions/standardize_invoice_items.sql \
  --only functions/auto_populate_invoice_item_fields.sql \
  --only functions/sync_invoice_item_contract_id.sql \
  --only functions/set_contract_item_end_date.sql \
  --only functions/inherit_auto_renew_from_quote_item.sql \
  --only functions/trg_set_contract_item_categoria.sql \
  --only functions/auto_calculate_pricing_fields.sql \
  --only functions/update_contract_term.sql \
  --only functions/trigger_revenue_schedule_on_contract_activation.sql \
  --only functions/set_booking_date_on_activate.sql \
  --only functions/set_contract_company_currency.sql \
  --only functions/auto_populate_invoice_tax_rate.sql \
  --only functions/auto_populate_invoice_fx_to_system.sql \
  --only functions/invoices_fill_terms_from_contract.sql \
  --only functions/assign_invoice_group_id.sql \
  --only functions/auto_calculate_contract_fx.sql \
  --only functions/trg_audit_contract_changes.sql \
  --only functions/trigger_rsm_on_contract_item_change.sql \
  --only functions/trigger_rsm_on_invoice_change.sql \
  --only functions/validate_fx_confirmation_before_firmado.sql
# desplegar la API con el código de la costura
# SOLO con OK de Domi (logs 30 días + llamadores del front viejo resueltos), DESPUÉS del asset de la función unificada:
DOTENV_CONFIG_PATH=.env.qa.db yarn postgres:assets --apply --target qa --only grants/030-generate-missing-invoices-execute.sql
DOTENV_CONFIG_PATH=.env.qa.db yarn schema:status --target qa
```

### Prueba en QA: activar lo mismo desde los dos fronts y comparar

Preparar dos borradores iguales (mismo cliente, compañía, ítems y fechas): **FV** activado desde el front viejo y **API** activado
desde `/lab/contratos` (o `POST /contracts/activate`). Reemplazar `:fv` y `:api` por sus ids.

```sql
-- 0. Costura aplicada: 23 funciones con la marca, invariantes sin ella, un solo trigger de generación.
SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND prosrc LIKE '%current_setting(''sapira.writer''%';           -- 23
SELECT proname FROM pg_proc WHERE proname IN ('trg_period_guard_contracts','validate_contract_currency_consistency',
  'validate_contract_item_currency_consistency') AND prosrc LIKE '%sapira.writer%';                                                  -- 0 filas
SELECT tgname FROM pg_trigger WHERE tgrelid = 'public.contracts'::regclass AND tgname LIKE '%generate_invoices%';                      -- solo unified_…
SELECT prosecdef FROM pg_proc WHERE proname = 'trigger_generate_invoices_on_contract_signed';                                          -- true

-- 1. Contrato: booking, monedas, FX a sistema y plazo.
SELECT id, status, booking_date, company_currency, system_currency, fx_rate_to_system, total_value, total_value_system_currency, term
FROM contracts WHERE id IN (:fv, :api);

-- 2. Ítems: fin, categoría y precios derivados (deben coincidir fila a fila por producto).
SELECT contract_id, product_id, start_date, end_date, term_months, categoria, auto_renew, unit_price, annual_unit_price, annual_price,
  price_entry_mode, monthly_price, billing_period_price
FROM contract_items WHERE contract_id IN (:fv, :api) ORDER BY product_id, contract_id;

-- 3. Facturas: cantidad, fechas y montos por período; grupo = id; condiciones del contrato; moneda del sistema.
SELECT contract_id, issue_date, due_date, status, document_type, tax_rate, amount_contract_currency, vat, total_invoice_currency,
  fx_contract_to_invoice, system_currency, fx_contract_to_system, amount_system_currency, total_system_currency,
  invoice_group_id = id AS group_ok, invoice_terms_and_conditions IS NOT DISTINCT FROM
    (SELECT c.invoice_terms_and_conditions FROM contracts c WHERE c.id = i.contract_id) AS terms_ok
FROM invoices i WHERE contract_id IN (:fv, :api) ORDER BY issue_date, contract_id;

-- 4. Líneas: sin patrón B (ítem en todas), estado/fecha del encabezado, producto y monedas.
SELECT ii.contract_id, count(*) AS lines, count(*) FILTER (WHERE ii.contract_item_id IS NULL) AS sin_item,
  count(*) FILTER (WHERE ii.status IS DISTINCT FROM i.status OR ii.issue_date IS DISTINCT FROM i.issue_date) AS desalineadas,
  count(*) FILTER (WHERE ii.product_id IS NULL) AS sin_producto, sum(ii.subtotal_contract_currency) AS neto
FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id WHERE i.contract_id IN (:fv, :api) GROUP BY ii.contract_id;

-- 5. RSM: mismo devengo y MRR por mes.
SELECT period_month, contract_id, sum(recognized_period_contract_ccy) AS devengo, sum(mrr_period_contract_ccy) AS mrr,
  sum(billed_period_contract_ccy) AS facturado
FROM revenue_schedule_monthly WHERE contract_id IN (:fv, :api) GROUP BY 1, 2 ORDER BY 1, 2;

-- 6. Historial: el FV deja contract_change_log (trigger); la API no, y deja su evento ACTIVATION.
SELECT contract_id, change_type, fields_changed, changed_by FROM contract_change_log WHERE contract_id IN (:fv, :api) ORDER BY changed_at;
SELECT contract_id, event_type, metadata->>'source' AS source FROM contract_lifecycle_events WHERE contract_id IN (:fv, :api) ORDER BY created_at;

-- 7. Sonda sin dejar rastro: con la marca, standardize_invoice_items no pisa la línea (esperado: 7 y 7).
BEGIN;
SELECT set_config('sapira.writer', 'api', true);
WITH i AS (SELECT id, contract_id FROM invoices WHERE contract_id = :api AND status = 'Por Emitir' LIMIT 1),
     ci AS (SELECT id FROM contract_items WHERE contract_id = :api LIMIT 1)
INSERT INTO invoice_items (invoice_id, contract_item_id, holding_id, contract_id, description, quantity, unit_price_contract_currency,
  subtotal_contract_currency, total_contract_currency, contract_currency, invoice_currency, status, issue_date)
SELECT i.id, ci.id, c.holding_id, c.id, 'sonda costura', 7, 7, 49, 49, c.contract_currency, c.contract_currency, 'Por Emitir', CURRENT_DATE
FROM i, ci, contracts c WHERE c.id = i.contract_id
RETURNING quantity, unit_price_contract_currency;
ROLLBACK;
```

Esperado: 1–5 iguales entre FV y API (salvo ids, `created_at` y la etiqueta de origen); en 4, `sin_item = 0` y `desalineadas = 0`
en la API; en 6, solo el FV tiene filas en `contract_change_log`.

### Agregado 01-10: pagos de Facturación v2 (sin commit, sin aplicar)

`functions/after_invoice_payment_change.sql` (AFTER INSERT/UPDATE/DELETE de `invoice_payments` → `recalc_invoice_status`) lleva el guard
(`RETURN NULL`): el módulo `billing` recalcula el estado por pagos en la API (pagos en la moneda de la factura, nunca sobre Por Emitir, hacia
atrás al anular; [`mapa-v2-facturacion.md`](./mapa-v2-facturacion.md) §2). Va en la lista AFTER de `costura-sapira-writer.spec.ts` (24
funciones con la marca). `set_invoice_payment_defaults` (BEFORE INSERT) no lleva guard: la API escribe `holding_id`, `currency` y
`created_by` explícitos, así que no rellena nada. Aplicación (QA primero, con el despliegue de `billing`):
`yarn postgres:assets --apply --target qa --only functions/after_invoice_payment_change.sql`.

### Retiro (baja, con doble confirmación)

`DROP FUNCTION trigger_generate_invoices_on_status_change()`; `DROP TRIGGER validate_fx_before_firmado` + `DROP FUNCTION
validate_fx_confirmation_before_firmado()`; `DROP FUNCTION generate_missing_invoices_for_contract(uuid)` (tras quitar sus llamadores
del front viejo); y, cuando el front viejo se apague, el resto de las 23 funciones de la costura salvo U9.
