# Catálogo de funciones y triggers de la base (`public`, producción)

> 04-10-2026 · para Domi. **Fuente única** de qué función o trigger de la base sigue, cuál se retira y cuál ya se retiró. Decisión de
> Domi (04-10): **no se renombran funciones**; en su lugar, este catálogo. Los demás documentos ([`switch-supabase-inventario.md`](./switch-supabase-inventario.md)
> §3–§4, [`plan-coexistencia-funciones.md`](./plan-coexistencia-funciones.md) §2, §4–§5, [`activacion-costura-triggers.md`](./activacion-costura-triggers.md))
> guardan el **porqué** y el historial de cada decisión; la lista vigente es esta.
>
> **Cómo se armó (solo lectura, nada se cambió):** producción (`Sapira MVP`) con `BEGIN TRANSACTION READ ONLY … ROLLBACK`: `pg_proc` de `public`
> sin las de extensiones (`vector`, `pg_trgm`), `pg_trigger` no internos de `public` y `auth`, `pg_policies`, `cron.job`, privilegios de `anon`;
> `list_edge_functions` del proyecto. Cruce por nombre con el corpus (`src/databases/postgresql/{functions,triggers,grants,cron,migrations}`),
> con el código de la API (`src/modules/**`, sin specs; solo cuenta una llamada real en SQL, no un comentario), con el front viejo
> (`sapira-ai/src`, llamadas `.rpc('…')`) y con el cuerpo de las demás funciones (`prosrc`). Fecha de la foto: 04-10-2026, después de aplicar
> `grants/030`, `grants/050` y `grants/060`.
>
> **Cómo se mantiene:** quien crea, cambia de destino o retira una función o un trigger actualiza este catálogo en el mismo commit. Una
> función nueva entra a la lista 1 con su frase; un retiro pasa de la lista 2 a la 3 con la migración que la borró.

## Resumen

| | Funciones | Triggers |
|---|---|---|
| En producción hoy (`public`, sin extensiones) | **273 nombres** (281 firmas: 7 nombres con sobrecarga) | **127** (126 en `public` + `t_sync_user_on_login` en `auth.users`); 58 son de `updated_at` |
| 1 · En uso en v2 y se mantienen | **87** (86 en prod + `holding_fixed_fx_rate`, nueva sin aplicar) | 93 (58 de ellos `updated_at`) |
| 2 · Se retiran después del período de pruebas | **123** (115 con llamador del front viejo o de un trigger a retirar + **8 sin uso detectado** que esperan otro bloque o se quedan por decisión) | 32 |
| 3 · Ya retiradas (o retiro pendiente de aplicar) | 23 firmas desde el 14-09 + 2 pendientes de aplicar (`1791300000000`) + **62 sin uso (64 firmas) pendientes de aplicar (`1791400000000`)** | 1 por migración + 2 pendientes de aplicar |

Por familia (cantidad de funciones):

| Familia | 1 · Se mantienen | 2 · Se retiran (con llamador) | 2 · Sin uso detectado (quedan) | 3 · Sin uso, retiradas 04-10 (`1791400000000`) |
|---|---|---|---|---|
| Devengo/RSM y Revenue | 12 | 7 | 4 | 9 |
| FX | 5 (3 con cambio pendiente, 1 nueva) | — (las FX viejas con llamador van en Contratos) | 2 | 4 |
| Contratos | 12 | 52 | 1 | 8 |
| Facturación | 5 | 24 | — | 9 |
| Consumos (`quantities`) | 4 | — | — | — |
| Clientes y Administración (holding, usuarios) | 7 | 13 | — | 10 |
| Notificaciones y comunicaciones | 2 | — | 1 | 3 |
| Integraciones | 3 | 2 | — | 6 |
| Legacy / MRR histórico (B2) | — | 17 | — | — |
| Tenancy/RLS y pruebas | 13 | — | — | 13 |
| Utilidades (`updated_at`) | 24 | — | — | — |
| **Total** | **87** | **115** | **8** | **62** |

Leyenda de columnas · **Tipo**: RPC = se llama como función; **trigger fn** = función de trigger (el trigger va al lado, `tabla.trigger`);
helper = solo la llaman otras funciones. **Costura**: ✔ = primera sentencia `IF current_setting('sapira.writer', true) = 'api'` (no hace
nada cuando escribe la API). **Asset**: siempre `functions/<nombre>.sql` y `triggers/<trigger>.sql` (sin excepciones en el corpus); se
anota solo lo distinto. **anon**: la función todavía tiene EXECUTE para `anon` y `authenticated` (se puede llamar con la anon key por
`/rest/v1/rpc/…`). ⏳ = **cambio pendiente de aplicar** (asset editado sin commit en `domi`, 04-10).

---

## 1 · En uso en v2 y se mantienen

### 1.1 Devengo/RSM

| Nombre | Tipo | Qué hace | Quién la usa | Costura |
|---|---|---|---|---|
| `revenue_schedule_rebuild` | RPC (anon) | Rehace el devengo y el MRR mes a mes de un contrato desde un mes dado: calcula en moneda del contrato, convierte y agrega la cola "por renovar". | API: `contract-activation`, `contract-changes`, `consumption`, `contract-invoice-edit`, `contract-invoice-partial-po`, `bigquery.service.ts`. Triggers `trg_rsm_on_*`. Front viejo (`useMonthlyRevenueSchedule.ts`) | — |
| `revenue_schedule_rebuild_contract_ccy` ⏳ | helper (anon) | El cálculo del devengo en moneda del contrato (precio, descuentos, multimoneda, NC, overrides de cantidad). ⏳ D2/D3 del 04-10: override del período = devengo del mes; facturas emitidas antes del inicio caen en su mes. | `revenue_schedule_rebuild`, `revenue_schedule_apply_fx_for_contract` | — |
| `revenue_schedule_apply_fx_for_contract` ⏳ | helper (anon) | Convierte el devengo ya calculado a moneda de la compañía y del sistema con la política de tipo de cambio del holding. ⏳ usa `holding_fixed_fx_rate` (tasa proyectada hacia adelante). ⏳ moneda de compañía con promedio mensual solo en meses terminados con promedio cerrado; el mes en curso y los futuros `pending_month_close` (Domi 04-10). | API: `holding-fx-recalc.ts` y `FxMonthCloseService` (cierre del día 1) (⏳ sin commit); `revenue_schedule_rebuild`, `apply_pending_renewal_tail`, `apply_renewal_price_split` | — |
| `apply_pending_renewal_tail` | helper (anon) | Agrega al devengo las filas "por renovar" de los ítems vencidos que no se renovaron ni se dieron de baja. | `revenue_schedule_rebuild`, `refresh_all_pending_renewals`, trigger `trg_zzz_pending_renewal_on_item_change` | — |
| `refresh_all_pending_renewals` | RPC | Recorre todos los contratos con ítems "por renovar" y les rehace esa cola. | **pg_cron** `refresh-pending-renewals` (06:00 UTC). Sin EXECUTE para `anon`/`authenticated` (`grants/060`) | — |
| `apply_renewal_price_split` | helper (anon) | En una renovación con precio nuevo, separa en el devengo el monto base de la diferencia (upsell/downsell) del primer mes. | `revenue_schedule_rebuild_contract_ccy` | — |
| `nc_discount_revenue_adjustment` | helper | Resta del devengo el descuento de las notas de crédito emitidas y los descuentos únicos. | `revenue_schedule_rebuild_contract_ccy` | — |
| `trigger_rsm_on_invoice_change` | trigger fn · `invoices.trg_rsm_on_invoice_change` | Al crear, cambiar o borrar una factura, rehace el devengo del contrato desde ese mes. | Escritores sin la marca: edge `check-overdue-invoices` (pasa a Vencida), webhook de Odoo, `invoice-scheduler`, `invoices.service`, sync de Stripe; front viejo | ✔ |
| `trigger_rsm_on_contract_item_change` | trigger fn · `contract_items.trg_rsm_on_contract_item_change` | Al crear o cambiar un ítem, rehace el devengo del contrato. | Escritores de `contract_items` sin la marca (hoy solo el front viejo; la API lleva la marca y rehace explícito) | ✔ |
| `trigger_pending_renewal_on_item_change` | trigger fn · `contract_items.trg_zzz_pending_renewal_on_item_change` | Después de tocar un ítem, recalcula la cola "por renovar" del contrato (si falla, avisa y no bloquea). | Todo escritor de `contract_items`, también la API (decisión: sigue corriendo) | — |
| `assign_momentum_to_revenue_schedule` | trigger fn · `revenue_schedule_monthly.trg_assign_momentum` | Si una fila de devengo llega sin tipo de movimiento (nuevo, upsell, renovación…), lo deduce del ítem. | Todo INSERT/UPDATE del devengo (rebuild) | — |
| `fix_renewal_annual_fields` | trigger fn · `contract_items.trg_z_fix_renewal_annual` | Al crear una renovación, copia del ítem original los campos de precio anual y recalcula mensual y por período. | Todo INSERT de `contract_items`, también la API. ⚠️ Pisa precio anual y mensual de una renovación cuyo original era anual: anotado para la próxima tanda de costura | — |

### 1.2 FX (tipo de cambio)

| Nombre | Tipo | Qué hace | Quién la usa | Costura |
|---|---|---|---|---|
| `holding_fixed_fx_rate` ⏳ **nueva** | helper | Busca la tasa fija del holding para un par de monedas y una fecha: directa, inversa o, para meses futuros sin tasa, la última registrada proyectada. | API: `metrics/fx-projected.ts` (⏳); `calculate_system_fx_rate` y `revenue_schedule_apply_fx_for_contract` (⏳). No existe aún en prod ni QA | — |
| `calculate_system_fx_rate` ⏳ | helper (anon) | Da la tasa para pasar un monto de la moneda del contrato a la moneda del sistema, según la política del holding (promedio mensual o tasa fija). ⏳ usa `holding_fixed_fx_rate`. | API: `api-written-fields.ts` (`refreshInvoiceSystemAmounts`); `auto_populate_invoice_fx_to_system`, `calculate_contract_fx_amounts` | — |
| `contract_item_fx_rate` | helper | Da la tasa fija pactada para convertir un ítem en otra moneda a la moneda del contrato (multimoneda); sin tasa devuelve vacío, nunca 1. | API: `contracts.service.ts` (TCV); `revenue_schedule_rebuild_contract_ccy` | — |
| `auto_populate_invoice_fx_to_system` ⏳ | trigger fn · `invoices.trigger_auto_populate_invoice_fx_to_system` | Completa en cada factura la tasa y los montos en moneda del sistema. ⏳ Regla por estado (04-10): Por Emitir desde la moneda de contrato del encabezado; cualquier otro estado desde la moneda de factura (recalcula al emitir, en el UPDATE de estado) + migración de datos `1791200000000-InvoiceSystemAmountsFromInvoiceCurrency`. | Escritores de facturas sin la marca (edge de vencidas, Odoo, `invoice-scheduler`, `invoices.service`, Stripe); front viejo. La API lo hace explícito (`refreshInvoiceSystemAmounts`) | ✔ |
| `validate_holding_fx_period_rates` | trigger fn · `holding_fx_period_rates.validate_holding_fx_period_rates_trigger` | **Invariante:** impide cargar tasas fijas del holding con períodos que se superponen o datos inválidos. | API: Administración (`settings-holding.service.ts`) | — |

### 1.3 Contratos (invariantes y lo que la API necesita)

| Nombre | Tipo | Qué hace | Quién la usa | Costura |
|---|---|---|---|---|
| `trg_period_guard_contracts` | trigger fn · `contracts.trg_00_period_guard_contracts` | **Invariante:** bloquea cambios contables en un contrato que ya tiene ítems en un período cerrado. | Todo escritor (API incluida) | — (invariante) |
| `trg_period_guard_contract_items` | trigger fn · `contract_items.trg_00_period_guard_contract_items` | **Invariante:** bloquea cambios contables en ítems que empiezan en un período cerrado. | Todo escritor | — (invariante) |
| `get_period_guard_mode` | helper | Lee si el guard de período está apagado, solo avisa o bloquea (por defecto, bloquea). | Los 2 guards de período | — |
| `is_period_guard_bypassed` | helper | Dice si un super admin abrió explícitamente el bypass del guard (cargas masivas). | Los 2 guards de período | — |
| `get_cutoff_date` | RPC (anon) | Devuelve hasta qué fecha está cerrado el período de una compañía. | API: `contract-activation`, `contract-changes`, `contract-invoice-consolidation`, `contract-invoices`, `holding-fx-recalc.ts`; guards de período; front viejo (`useCutoffDate.ts`) | — |
| `trg_validate_cutoff_company_holding_match` | trigger fn · `accounting_period_cutoff.trg_cutoff_validate_company_holding`, `accounting_period_events.trg_events_validate_company_holding` | **Invariante:** impide registrar un cierre de período de una compañía con otro holding. | API: cierre/reapertura (`accounting-periods.service.ts`) | — |
| `prevent_end_date_update_when_active` | trigger fn · `contracts.trg_prevent_end_date_update_when_active` | **Invariante:** impide cambiar la fecha de término de un contrato activo, salvo bypass explícito de la API (que deja evento). | API (fin de contrato con `sapira.bypass_end_date_guard`) | — (invariante) |
| `validate_contract_currency_consistency` | trigger fn · `contracts.validate_contract_currency_trigger` | **Invariante:** la moneda del contrato tiene que ser coherente con la de sus ítems. | Todo escritor | — (invariante) |
| `validate_contract_item_currency_consistency` | trigger fn · `contract_items.validate_contract_item_currency_trigger` | **Invariante:** un ítem en otra moneda solo si el contrato está marcado multimoneda. | Todo escritor | — (invariante) |
| `trg_audit_contract_item_changes` | trigger fn · `contract_items.trg_audit_contract_item_changes` | Deja en el historial de cambios cada alta, cambio o baja de ítems de contratos activos, cancelados o expirados. | Todo escritor (para la API queda con usuario vacío; el historial v2 son los eventos) | — |
| `audit_resolve_user` | helper (anon) | Averigua el usuario de la sesión para los registros de auditoría. | `trg_audit_contract_item_changes` (y `trg_audit_contract_changes`, lista 2) | — |
| `set_lifecycle_event_holding_id` | trigger fn · `contract_lifecycle_events.trg_set_lifecycle_event_holding_id_{ins,upd}` | Copia el holding del contrato en cada evento del historial y exige que el contrato exista. | API (todos los eventos v2) | — |

### 1.4 Facturación (rellenos que siguen sirviendo a integraciones)

Con la costura no hacen nada para los servicios v2 que fijan la marca, pero **sí corren** para los escritores de facturas de la API que todavía
no la fijan (`invoice-scheduler.service.ts`, `invoices.service.ts`, `stripe-sync.service.ts`, webhook de Odoo) y para la edge de vencidas. Se
retiran solo cuando cada uno de esos escritores fije `sapira.writer = 'api'` y escriba explícito (revisar con Leon).

| Nombre | Tipo | Qué hace | Costura |
|---|---|---|---|
| `auto_populate_invoice_tax_rate` | trigger fn · `invoices.trigger_auto_populate_invoice_tax_rate` | Si la factura llega sin IVA, toma el de la compañía (y falla si la compañía no lo tiene). | ✔ |
| `invoices_fill_terms_from_contract` | trigger fn · `invoices.invoices_fill_terms_from_contract_trigger` | Si la factura llega sin condiciones, copia las del contrato. | ✔ |
| `assign_invoice_group_id` | trigger fn · `invoices.trg_assign_invoice_group_id` | Asigna a la factura su identificador de grupo (la factura y sus documentos relacionados). | ✔ |
| `auto_populate_invoice_item_fields` | trigger fn · `invoice_items.trigger_auto_populate_invoice_item_fields` | Completa en cada línea los datos que vienen de la cabecera (holding, contrato, monedas, estado). | ✔ |
| `sync_invoice_items_on_invoice_update` | trigger fn · `invoices.trigger_sync_invoice_items_on_invoice_update` | Cuando cambia el estado o la fecha de emisión de una factura, copia ese dato a todas sus líneas. | — (decisión 02-10: se deja; la API no escribe esos campos en líneas) |

### 1.5 Consumos (`quantities`)

Los usa el **sync del DWH de la API** (`bigquery.service.ts`, que escribe `quantities`), además del front viejo. Se quedan hasta que el DWH
escriba `consumption_entries` (decisión #11, Leon); entonces pasan a la lista 2 con `quantities`.

| Nombre | Tipo | Qué hace |
|---|---|---|
| `quantities_set_holding_from_contract_item` | trigger fn · `quantities.trg_quantities_set_holding` | Al cargar una cantidad, encuentra su contrato, ítem y holding (la API cuenta con esto). |
| `validate_invoice_status_for_quantity_change` | trigger fn · `quantities.trg_validate_quantity_invoice_status` | Bloquea cambiar una cantidad si la factura de ese mes ya no está Por Emitir. |
| `sync_invoice_items_amounts_from_quantities` | trigger fn · `quantities.trg_sync_invoice_items_from_quantities` | Lleva la cantidad nueva a la línea de la factura Por Emitir del mismo mes. |
| `restore_invoice_items_amounts_on_quantity_delete` | trigger fn · `quantities.trg_restore_invoice_items_on_quantity_delete` | Al borrar una cantidad, devuelve la línea Por Emitir al monto del contrato. |

### 1.6 Clientes y Administración

| Nombre | Tipo | Qué hace | Quién la usa |
|---|---|---|---|
| `sync_client_entity_primary_client` | trigger fn · `client_entity_clients.trg_sync_client_entity_primary_client` | Mantiene un solo cliente principal por razón social y lo copia a la razón social. | API: Clientes (`client-entity-writer.ts`, `client-directory.service.ts`, `clients.service.ts`); sync de Stripe |
| `sync_contracts_company_currency` | trigger fn · `companies.trigger_sync_contracts_company_currency` | Si cambia la moneda de una compañía, la actualiza en todos sus contratos. | API: Administración (`settings-companies.service.ts`) |
| `create_default_roles_for_holding` | trigger fn · `company_holdings.trigger_create_default_roles` | Al crear un holding, le crea sus roles por defecto. | Alta de holding (hoy manual, B4) |
| `create_quote_stages_for_new_holding` | trigger fn · `company_holdings.trigger_create_quote_stages_on_holding_creation` | Al crear un holding, le siembra las etapas de cotización. | Alta de holding |
| `create_default_quote_stages_for_holding` | helper (anon) | Crea las etapas de cotización por defecto de un holding. | `create_quote_stages_for_new_holding` (la API replica el set en `quote-status.ts`) |
| `create_standard_agents_for_holding` | trigger fn · `company_holdings.trigger_create_standard_agents` | Al crear un holding, le crea los agentes estándar (proformas y cobranza). | Alta de holding |
| `sync_user_on_login` | trigger fn · `auth.users.t_sync_user_on_login` | En cada ingreso: vincula el usuario de Auth, pasa a Activo a un invitado y guarda el último acceso (y crea "Empresa de X" si no tiene holding). | Todo login (los dos fronts). **B1**: mantener hasta que la API haga el primer ingreso y `last_access` |

### 1.7 Notificaciones y comunicaciones

| Nombre | Tipo | Qué hace |
|---|---|---|
| `validate_email_matches_domain` | trigger fn · `email_sender_addresses.trigger_validate_email_matches_domain` | Impide registrar un remitente cuyo correo no es del dominio configurado. |
| `validate_client_agent_config_email_sender` | trigger fn · `client_agent_configs.trigger_validate_client_agent_config_email_sender` | Impide que la configuración de un agente use un remitente de otro holding. |

### 1.8 Integraciones

| Nombre | Tipo | Qué hace | Quién la usa |
|---|---|---|---|
| `cron_invoke_edge_function` | RPC | Llama una edge function con la URL y la clave guardadas en Vault (sin secretos en el comando). | **pg_cron** `check-overdue-invoices-daily`. Solo `postgres` (`grants/050`) |
| `update_invoice_timestamp` | trigger fn · `odoo_invoices_stg.update_invoice_timestamp_trigger` | Marca la fecha de actualización del staging de facturas de Odoo. | Sync de Odoo (API) |
| `update_invoice_line_timestamp` | trigger fn · `odoo_invoice_lines_stg.update_invoice_line_timestamp_trigger` | Ídem para las líneas del staging de Odoo. | Sync de Odoo (API) |

### 1.9 Tenancy/RLS (tabla compacta)

v2 **no las usa** (la API corre como `postgres`, sin RLS; el front nuevo no usa PostgREST). Se mantienen porque son la barrera de las 411
policies mientras la anon key y PostgREST sigan abiertos, y su retiro es el **último paso** (`plan-coexistencia` §5, tenancy).

| Nombre | Policies que la usan | Otros llamadores | Qué hace |
|---|---|---|---|
| `get_current_user_holding_id` | 94 | front viejo (62 archivos), ~40 funciones | Holding activo del usuario de la sesión. |
| `rls_user_holding_id` | — | `get_current_user_holding_id` | Ídem, versión interna para RLS. |
| `get_user_holding_id` | 8 | front viejo (16 archivos) | Holding del usuario (el seleccionado o el primero activo). |
| `get_current_user_id` | 5 | guards de período, `set_invoice_payment_defaults`, RPC viejas | Id interno del usuario de la sesión. |
| `rls_is_super_admin` | 9 | `audit_user_holding_security` | ¿Es super admin? (versión RLS). |
| `rls_is_holding_admin` | 4 | — (`debug_user_access` se retira con `1791400000000`) | ¿Es administrador del holding? (versión RLS). |
| `is_holding_admin` | 4 | `close_period_until`, `reopen_period_from`, front viejo | ¿Es administrador del holding? ⚠️ su comentario dice "no usar en RLS" y está en 4 policies. |
| `is_super_admin` | — | `invite_user_safe`, `close_period_until` y otras; front viejo | ¿Es super admin? |
| `user_has_permission` | 5 | RPC de facturación viejas | ¿Tiene el permiso X? ⚠️ mismo comentario contradictorio. |
| `rls_can_see_user`, `rls_can_see_user_no_rls` | 1 | — | ¿Puede ver a ese otro usuario? |
| `can_access_financial_data`, `can_manage_financial_data` | 1 c/u | front viejo (`useUserPermissions.ts`) | ¿Puede ver / editar datos financieros? |

### 1.10 Utilidades: `updated_at` (24 funciones, 58 triggers)

Todas hacen lo mismo: **ponen la fecha de actualización de la fila al guardarla**. Se mantienen (inocuas). Duplicadas entre sí: bastaría
`update_updated_at_column` (16 tablas) o `set_updated_at` (7 tablas); las otras 22 son copias por tabla
(`trg_set_updated_at_accounting_period_cutoff`, `update_app_notifications_updated_at`, `update_bigquery_connections_updated_at`,
`update_client_agent_configs_updated_at`, `update_contract_lifecycle_events_updated_at`, `update_email_sender_addresses_updated_at`,
`update_generic_export_vats_updated_at`, `update_holding_email_sender_updated_at`, `update_invoice_items_updated_at`,
`update_odoo_connections_updated_at`, `update_odoo_mapping_updated_at`, `update_quote_stages_updated_at`,
`update_revenue_schedule_monthly_updated_at`, `update_salesforce_{connections,field_mappings,mapping,opportunities_cache,staging}_updated_at`,
`update_stripe_customers_bigquery_updated_at`, `update_stripe_sync_jobs_updated_at`, `update_stripe_updated_at_column`,
`update_user_view_preferences_updated_at`). `contract_lifecycle_events` tiene **3 triggers iguales** de `updated_at` (decisión pendiente #9
del plan: dejar uno). Unificarlas es limpieza opcional, no bloquea nada.

---

## 2 · Se retiran después del período de pruebas

Regla de retiro (sin cambios): **doble confirmación** (ningún llamador en los 3 repos, `prosrc`, `pg_trigger`, `cron.job` + 0 llamadas en
los logs del gateway de 30 días), QA antes que prod, migración con `DROP` + borrar el asset, OK de Domi. **REVOKE**: ✔ = sin EXECUTE para
`anon`/`authenticated` (`grants/0x0` aplicado); "anon" = todavía expuesta.

### 2.1 Contratos · RPC del front viejo (las reemplazan los flujos v2)

| Nombre | Por qué se va · qué la reemplaza en v2 | REVOKE | Riesgo |
|---|---|---|---|
| `bulk_activate_contracts`, `mark_contract_signed_safe` | Activación del front viejo → `POST /contracts/activate` | ✔ 060 | Bajo |
| `generate_missing_invoices_for_contract` | Materializa facturas legacy al activar → generador v2 de la activación. La llaman `trigger_generate_invoices_on_contract_signed` y `bulk_restructure_contract_start_dates` (DEFINER) | ✔ 030 | Bajo (se va con su trigger) |
| `regenerate_contract_invoices_from_items`, `regenerate_contract_invoices_for_restructure` | Rearman el cronograma viejo `contract_invoices` → v2 no usa `contract_invoices` | ✔ 060 / anon | Bajo |
| `create_contract_cross_sell`, `approve_contract_amendment`, `recalc_revenue_for_contract`, `reconcile_contract_status` | Cross-sell con enmiendas → `POST /contracts/:id/changes` `item_add` | ✔ 060 (+020) | Bajo |
| `apply_quote_downsell_to_contract`, `_recalc_invoice_header_from_items` | Downsell/renegociación → `item_change` | ✔ 060 / anon | Bajo |
| `apply_contract_contraction` | Churn → `item_remove` / `contract_cancel` | ✔ 060 | Medio: v2 no cancela el contrato al sacar el último ítem |
| `create_contract_renewal`, `process_auto_renewals`, `execute_auto_renewal_for_item`, `get_items_pending_auto_renewal` | Renovación → `renewal` v2 y job `contracts-auto-renewal` (propone, no renueva). El cron viejo ya se apagó | ✔ 060 | Bajo |
| `sync_invoices_for_contract_item`, `calculate_billing_period`, `get_frequency_months` | Editar ítems post-firma → F4 v2 (en activo, pendiente) | ✔ 060 / anon | Alto si F4 no está |
| `invoice_reschedule_items`, `check_contract_item_continuity` | Reestructurar cronograma → reorganizar facturas v2 (`contract-invoice-reorganize.service.ts`) | ✔ 060 | Medio |
| `bulk_restructure_contract_start_dates`, `compute_new_contract_start`, `months_between_dates` | Mover fechas en masa → sin sustituto v2 | ✔ 060 / anon | Alto: no retirar sin sustituto |
| `change_contract_currency`, `change_contract_commercial_client`, `get_commercial_clients_by_tax_id` | Editar borrador → `PUT /contracts/:id` y `change_entity` | ✔ 060 / anon | Bajo |
| `bulk_confirm_fx_policy` | Política FX en lote → Administración v2 | ✔ 060 | Bajo |
| `get_contract_holding`, `log_lifecycle_event` | Helpers de las RPC viejas (la API escribe sus eventos directo) | anon | Nulo; se van con sus llamadores |
| `get_user_company_id` | Plantillas de contrato del front viejo | anon | Nulo |

### 2.2 Contratos · triggers (§3a con costura, §3c sin costura)

Solo los dispara con efecto el front viejo: la API lleva la marca y escribe cada campo explícito (`api-written-fields.ts`).

| Trigger (tabla) · función | Qué hace | Lo reemplaza en v2 | Riesgo |
|---|---|---|---|
| `contracts.unified_generate_invoices_on_contract_signed` · `trigger_generate_invoices_on_contract_signed` ✔ | Genera facturas al activar | Generador de la activación | Nulo |
| `contracts.validate_fx_before_firmado` · `validate_fx_confirmation_before_firmado` ✔ | Exige FX al pasar a Firmado (nunca se dispara) | — | Nulo |
| `contracts.trg_audit_contract_changes` · `trg_audit_contract_changes` ✔ | Historial `contract_change_log` | Eventos `contract_lifecycle_events` | Nulo |
| `contracts.trg_set_booking_date_on_activate` · `set_booking_date_on_activate` ✔ | Fecha de booking = hoy si falta | Activación (`COALESCE`) | Nulo |
| `contracts.trigger_auto_calculate_contract_fx` · `auto_calculate_contract_fx` ✔ (+ helpers `calculate_contract_fx_amounts`, `fx_rate`) | FX y total del contrato en moneda del sistema | `refreshContractSystemFx()` | Nulo |
| `contracts.trigger_set_contract_company_currency` · `set_contract_company_currency` ✔ | Moneda de la compañía y del sistema en el contrato | Alta/PUT/activación | Nulo |
| `contracts.trigger_revenue_schedule_on_contract_activation` · ídem ✔ | Rehace el devengo al activar (se traga errores) | `revenue_schedule_rebuild` explícito | Nulo |
| `contract_items.trg_set_contract_item_end_date` · `set_contract_item_end_date` ✔ | Fin = inicio + plazo − 1 | Fin explícito | Nulo |
| `contract_items.trg_inherit_auto_renew_from_quote_item` · `inherit_auto_renew_from_quote_item` ✔ | Hereda auto-renovación de la cotización | Lo elegido | Nulo |
| `contract_items.trg_calculate_contract_categoria` · `trg_set_contract_item_categoria` ✔ (+ `calculate_contract_item_categoria`) | Categoría (nuevo, upsell…) | `itemCategoriaSql` (réplica en la API) | Nulo |
| `contract_items.trg_contract_items_calculate_pricing`, `quote_items.trg_quote_items_calculate_pricing` · `auto_calculate_pricing_fields` ✔ (+ `calculate_monthly_and_period_prices`) | Precio mensual, anual y por período | `pricingFields()` | Nulo (verificado: solo `quotes.service.ts` escribe `quote_items`, con marca) |
| `contract_items.trigger_update_contract_term` · `update_contract_term` ✔ | Plazo del contrato = mayor plazo de ítems | `syncContractTerm()` | Nulo |
| `contracts.trg_cancel_schedule_on_contract_cancelled` · `cancel_contract_invoices_on_contract_cancelled` | Cancela el cronograma viejo al cancelar | v2 no usa `contract_invoices` | Nulo; se va con la tabla |
| `contracts.trigger_log_contract_workflow_transition` · `log_contract_workflow_transition` (+ `workflow_steps.update_workflow_steps_updated_at`) | Historial del workflow de aprobación | Oculto en v2 | Nulo |
| `contract_amendments.trg_set_amendment_holding`, `contract_amendment_items.trg_set_amendment_item_holding` · `set_contract_amendment_{,item_}holding_id` | Holding de las enmiendas | Eventos v2 | Nulo; se van con las tablas |

### 2.3 Facturación

| Nombre | Por qué se va · reemplazo v2 | REVOKE | Riesgo |
|---|---|---|---|
| `standardize_invoice_items` ✔ (trigger `invoice_items.standardize_invoice_items_trigger`) | Pisa cantidad/precio de líneas con ítem → generador v2 (sin patrón B) | — | **Medio**: `stripe-sync.service.ts` inserta `invoice_items` sin la marca; verificar que no mande `contract_item_id` antes del DROP |
| `sync_invoice_item_contract_id` ✔ (trigger `invoice_items.trigger_sync_invoice_item_contract_id`) | Adivina el ítem por descripción | Línea nace con ítem | Bajo |
| `after_invoice_payment_change` ✔ (3 triggers `invoice_payments.trg_recalc_after_*`) + `recalc_invoice_status` | Recalcula estado por pagos → `billing-payments.service.ts` | anon (recalc) | Nulo: solo `billing` escribe pagos en la API (con marca) |
| `set_invoice_payment_defaults` (trigger `invoice_payments.trg_set_invoice_payment_defaults`) | Rellena holding, moneda y autor del pago → la API los manda | — | Nulo (el inventario §3b lo dejó por inocuo) |
| `adjust_issued_invoice`, `edit_pending_invoice` | Ajustar emitida / editar Por Emitir → acciones de factura v2 | anon | Bajo |
| `emit_invoice_manually`, `emit_invoice_safe`, `bulk_emit_invoices_safe`, `bulk_emit_invoices_with_scheduled_dates`, `get_next_invoice_number` | Emisión del front viejo → emisión externa v2 | anon | Bajo |
| `reschedule_invoice_safe` | Reprogramar → reprogramar v2 | anon | Bajo |
| `create_credit_note_safe` | NC → NC espejo v2 | anon | Bajo |
| `apply_fixed_fx_to_contract` | FX fijo de facturación → FX por factura v2 | anon | Bajo |
| `invoice_items_bulk_update_description`, `invoice_bulk_update_terms`, `invoice_reassign_entity`, `reset_invoice_odoo_draft` | Acciones masivas → endpoints de facturas v2 | anon | Bajo |
| `unify_invoices_multi_contract`, `consolidate_invoices_simple`, `unconsolidate_invoices_simple` | Unificar/consolidar → `contract-invoice-consolidation.service.ts` | anon | Medio (unificadas multimoneda, F1) |
| `mark_overdue_invoices`, `manual_check_overdue_invoices` | Marcar vencidas: **ninguna la llama** (la edge `check-overdue-invoices` hace el UPDATE directo) | ✔ 060 | Nulo |

### 2.4 Clientes, Revenue/períodos, usuarios e integraciones viejas

| Nombre | Por qué se va · reemplazo v2 | REVOKE | Riesgo |
|---|---|---|---|
| `assign_clients_to_entity`, `unassign_client_from_entity`, `get_entities_by_client`, `get_clients_by_entity` | Razones sociales del front viejo → Clientes v2. `get_entities_by_client` era la más llamada (≈30 mil/día el 30-09) | anon | Bajo |
| `close_period_until`, `reopen_period_from` | Cierre de período → `accounting-periods.service.ts` (replica la lógica) | anon | Bajo |
| `get_monthly_revenue_schedule_by_product`, `revenue_monthly_journal`, `revenue_monthly_summary`, `populate_initial_revenue_schedule`, `revenue_schedule_rebuild_all` | Pantallas Revenue viejas → Ingresos/Métricas v2 (`/metrics/*`) | anon | Bajo |
| `invite_user_safe`, `update_user_role_safe`, `delete_current_user`, `delete_user_complete`, `assign_admin_role_safe`, `create_user_holding_association_safe` | Usuarios y alta de holding → Administración v2 (alta de holding manual hasta onboarding, B4) | ✔ 060 | Bajo |
| `get_current_user_permissions`, `audit_user_holding_security`, `detect_orphaned_users` | Permisos/seguridad del front viejo → `PermissionsService` de la API | anon | Bajo |
| `get_table_columns`, `cleanup_old_processed_records` | Pantalla Odoo vieja → Integraciones v2 | anon | Bajo |

### 2.5 Legacy / MRR histórico (retiro condicionado a B2)

Sin reemplazo v2 todavía (**B2**: carga de MRR histórico). Se retiran cuando exista el módulo de datos históricos, no antes.

`create_contract_from_mrr_legacy`, `mark_mrr_legacy_skip_activation`, `delete_mrr_legacy_group`, `create_legacy_contract_with_items`,
`reconcile_legacy_invoice`, `reconcile_legacy_with_por_emitir`, `apply_reconciliation_template`, `detect_similar_invoices`,
`update_legacy_reconciliation_pct` (RPC, todas anon) y los triggers de las tablas legacy: `mrr_legacy` (`calculate_mrr_legacy_fields`,
`calculate_mrr_legacy_system_currency`, `update_invoice_legacy_status_on_mrr_creation`), `invoices_legacy`
(`auto_populate_client_tax_id_from_entity`), `invoice_items_legacy_match` (`prevent_confirmed_match_edit`, `set_match_confirmed_metadata`,
`update_invoice_legacy_status`, `validate_match_total`).

### 2.6 Sin uso detectado (quedan 8)

Las otras 62 (64 firmas) se retiran con `1791400000000` (04-10, decisión de Domi: borrar ya lo que no tiene ningún llamador conocido): ver §3 y el
respaldo [`archivo-funciones/2026-10-04-sin-uso.sql.txt`](./archivo-funciones/2026-10-04-sin-uso.sql.txt). Estas 8 tampoco tienen
llamador real, pero su retiro depende de otro bloque o Domi decidió conservarlas (04-10):

| Función | Por qué espera |
|---|---|
| `calculate_contract_fx_rate` (3 firmas, + `fx_rate_with_indirect`) | Duplicada de FX. `fx-model.spec.ts` (bloque FX sin commit del 04-10) lee su asset: se retira cuando ese bloque cierre, en la misma tanda que su spec |
| `revenue_schedule_update_period_quantities` | Sus llamadores (`trigger_rsm_on_quantity_change`, `restore_rsm_on_quantity_delete`) siguen en prod hasta aplicar `1791300000000`; después queda sin llamador y se retira |
| `trigger_generate_invoices_on_status_change` | Función de trigger sin trigger desde el 30-09. `costura-sapira-writer.spec.ts` (sin commit) la verifica y el `down()` de `1790660000000` la usa para recrear el trigger |
| `get_effective_client_agent_config` | **Se queda para Automatizaciones** (decisión de Domi 04-10): el front nuevo la anota como base de la configuración de agentes por cliente (`AgentesClienteCard.tsx`) |
| `rsm_rebuild_subscription`, `rsm_rebuild_from_subscription`, `rsm_apply_fx_for_subscription` | **Motor del devengo de suscripciones Stripe** (`revenue_schedule_monthly` con `subscription_id`): sin llamador hoy, pero se revisa con Stripe antes de retirarlo (decisión de Domi 04-10; salieron de `1791400000000` y sus assets volvieron al repo). `rsm_rebuild_subscription` llama a las otras dos; ninguna llama a una función que `1791400000000` borra |

---

## 3 · Ya retiradas

| Fecha | Qué | Cómo / respaldo |
|---|---|---|
| 14-09-2026 | `check_invoice_changes_before_insert`, `cleanup_duplicate_pending_invoice_lines`, `cleanup_duplicate_pending_invoices`, `cleanup_old_processed_invoices`, `integrate_invoices_to_legacy`, `rollback_invoice_integration` (+ tabla `integration_logs`) | Migración `1757390000000-DropIntegrationLogs` (la definición queda en su `down()` y en git) |
| 15-09-2026 | `cleanup_duplicate_pending_records`, `debug_invoice_trigger` (+ tabla `invoice_trigger_debug_logs`) | `1789040000000-RetiraObjetosDebugMuertos` |
| 21-09-2026 | Vistas `invoices_with_net_amounts`, `invoice_items_consolidated` (no son funciones; dejaron huérfanas 2, ver 2.6) | `1789100000000-DropVistasSinUso` |
| 21-09-2026 | 23 assets huérfanos (objetos que ya no existían en prod ni QA) | Borrados del corpus, `REGISTRO-DB-COMO-CODIGO.md` punto 4 |
| 23-09-2026 | `check_salesforce_sync_cron_status` + job `salesforce-daily-sync` | `1790163360141-RetiraSincronizacionSalesforcePorEdgeFunction` (la reemplaza `SalesforceScheduler`) |
| 24-09-2026 | 14 firmas: `activate_legacy_contract`, `bulk_reconcile_legacy_invoices` (×2), `confirm_legacy_invoice_reconciliation` (×2), `create_contract_churn`, `create_contract_downsell`, `create_contract_renewal` (firma vieja de 6 args), `create_contract_upsell`, `derive_contract_items_from_legacy`, `get_contract_reconciliation`, `migrate_contracts_to_new_workflow`, `register_item_non_renewal`, `validate_legacy_activation` | `1790292150143-RetiraFuncionesContratosYLegacyMuertas` (`saneamiento-contratos.md`) |
| 30-09-2026 | Trigger `generate_invoices_on_contract_active` (su función sigue, sin trigger: 2.6) | `1790660000000-UnificaTriggerGeneracionFacturas` |
| 01-10-2026 | Job `auto-renew-contract-items` (fallaba siempre) | `1790700000000-MulticurrencyContract` (`cron.unschedule`) |
| 03/04-10-2026 | Edge functions `agents-webhook` (stub 410), `send-invitation`, `delete-user`, `sync-exchange-rates`, `diagnose-odoo-model`, `diagnose-odoo-invoices`, `get-odoo-companies`, `chargebee-proxy`, `data-gateway`, `rag-chat`, `rag-ingest`, `rag-ingest-semantic-catalog` | Fuentes en [`archivo-edge-functions/`](./archivo-edge-functions/README.md) |
| 04-10-2026 · **pendiente de aplicar** | Triggers `quantities.trg_rsm_on_quantity_change`, `quantities.trg_restore_rsm_on_quantity_delete` y sus funciones `trigger_rsm_on_quantity_change`, `restore_rsm_on_quantity_delete` | `1791300000000-RetiraTriggersDevengoQuantities` (sin commit; assets ya borrados del repo; **siguen en prod**). El DWH llama `revenue_schedule_rebuild` |
| 04-10-2026 · **pendiente de aplicar** | **62 funciones sin uso (64 firmas)**, la lista 2.6 salvo 8. Devengo/Revenue (9): `admin_populate_revenue_schedule`, `enable_and_populate_revenue_schedule`, `revenue_schedule_rebuild_for_invoice`, `revenue_schedule_get_monthly`, `revenue_consolidated_summary`, `revenue_consolidated_journal`, `get_current_mrr_by_holding`, `trigger_update_schedule_on_override`, `update_revenue_schedule_period` · FX (4): `calculate_fx_suggestion`, `contract_fx_policy_upsert`, `convert_amount`, `get_fx_rate` · Contratos (8): `auto_expire_contracts`, `generate_invoices_for_contract_item`, `mark_contracts_as_bulk_import`, `search_contracts_by_client_identity`, `suggest_contract_item_matches`, `validate_billing_splits_total`, `validate_legacy_reconciliation`, `validate_mrr_legacy_splits` · Facturación (9): `cancel_invoice_with_credit_note`, `get_consolidable_invoices_for_period`, `get_invoice_items_with_credits`, `get_invoice_net_amount`, `recalculate_invoice_totals`, `send_proforma_safe`, `trigger_update_invoices_on_override`, `update_pending_invoices_on_override`, `is_date_closed` · Clientes y holding (10): `duplicate_client_entity_for_multiple_clients`, `create_company_holding`, `create_company_holding_direct`, `update_company_holding_direct`, `create_user_holding_safe`, `check_user_has_holding`, `check_user_has_holding_direct`, `validate_user_has_holding`, `get_custom_field_definitions`, `validate_custom_fields` · Integraciones (6): `apply_field_mapping_to_data` (×2), `resolve_field_transformation`, `extract_mapped_fields_hierarchical`, `get_invoice_staging_stats`, `get_odoo_partners_stg_debug`, `cleanup_duplicate_partners_by_vat` (+ asset `grants/010`) · Notificaciones/agentes (3): `get_default_email_sender`, `rag_match_documents`, `rsm_metrics` (×2) · Tenancy/pruebas (13): `get_user_holding_id_robust`, `get_user_holding_id_safe`, `get_user_holding_data_direct`, `get_user_holding_data_robust`, `get_current_user_role`, `debug_current_user_context`, `debug_user_access`, `rls_can_see_user_debug`, `test_can_see_users`, `test_rls_access`, `test_rls_access_v2`, `test_user_access`, `bootstrap_accounting_period_cutoffs` | `1791400000000-RetiraFuncionesSinUso` (sin commit; assets ya borrados del repo; **siguen en prod**). Respaldo para restaurar (definición, dueño, comentario y permisos de prod): [`archivo-funciones/2026-10-04-sin-uso.sql.txt`](./archivo-funciones/2026-10-04-sin-uso.sql.txt). Verificado contra prod el 04-10 (`prosrc`, `pg_trigger`, `pg_policy`, `pg_depend`, `cron.job`, 3 repos y edge vigentes) y probado en la copia local |

---

## 4 · pg_cron y edge functions vigentes

**pg_cron (producción, 2 jobs activos):**

| Job | Horario (UTC) | Comando | Asset | Destino |
|---|---|---|---|---|
| `check-overdue-invoices-daily` | `1 4 * * *` | `cron_invoke_edge_function('check-overdue-invoices','POST')` | `cron/check-overdue-invoices-daily.sql` | Se mantiene; después, job de la API |
| `refresh-pending-renewals` | `0 6 * * *` | `refresh_all_pending_renewals()` | `cron/refresh-pending-renewals.sql` | Se mantiene hasta la sesión RSM |

**Edge functions desplegadas (13, `list_edge_functions` 04-10):**

| Función | Uso | Destino |
|---|---|---|
| `check-overdue-invoices` | pg_cron diario: pasa a Vencida y registra `overdue_check_log` (UPDATE directo, no usa funciones SQL) | **Mantener**; migrar a la API |
| `send-proforma`, `send-collection` | Front viejo (bloqueado); 0 usos | Retirar después de las pruebas (se ven con Automatizaciones). No rotar `RESEND_API_KEY` antes |
| `sync-odoo-invoices`, `sync-odoo-partners`, `approve-odoo-invoices`, `process-odoo-invoices`, `process-odoo-lines`, `test-odoo-connection` | Sin llamador en ningún repo ni fuente; 0 usos en 30 días | Revisar con Leon y retirar |
| `agents-run`, `agents-approve`, `agents-render-email` | Sin llamador ni fuente; 0 usos | Retirar (reemplaza el módulo `agents` de la API) |
| `agents-webhook` | Stub que responde 410 (v12, 03-10) | Borrar con las anteriores |

---

## 5 · Hallazgos

1. **70 funciones sin uso detectado** (2.6). ✅ 04-10: 62 (64 firmas) se retiran con `1791400000000-RetiraFuncionesSinUso` (pendiente
   de aplicar): 63 de las 64 firmas tenían EXECUTE para `anon` (50 SECURITY DEFINER) y 21 escribían datos, entre ellas `create_company_holding`,
   `create_company_holding_direct`, `update_company_holding_direct`, `create_user_holding_safe`, `mark_contracts_as_bulk_import`,
   `contract_fx_policy_upsert`, `admin_populate_revenue_schedule` y `cancel_invoice_with_credit_note`. Quedan 8 (2.6): las 3 `rsm_*` de
   suscripciones Stripe y `get_effective_client_agent_config` salieron de la migración por decisión de Domi (04-10).
2. **Lo que sigue expuesto a `anon`:** 241 de 273 nombres (tras `1791400000000`, 180 de 211). Además de las sin uso, 50 RPC de la lista 2 sin REVOKE (toda la familia de
   Facturación, Clientes, Revenue y Legacy) y RPC de la lista 1 como `revenue_schedule_rebuild` y sus helpers. `grants/060` cubrió Contratos,
   usuarios y crons; el siguiente REVOKE natural es la tanda de Facturación/Clientes/Revenue de 2.3–2.4.
3. **Duplicadas:** holding de la sesión en 7 variantes (`get_current_user_holding_id`, `rls_user_holding_id`, `get_user_holding_id`,
   `_robust`, `_safe`, `get_user_holding_data_robust`, `_direct`); tipo de cambio en 8 (`fx_rate` ×2, `get_fx_rate`, `fx_rate_with_indirect`,
   `calculate_contract_fx_rate` ×3, `calculate_fx_suggestion`, `calculate_system_fx_rate`, `contract_item_fx_rate`, `holding_fixed_fx_rate`;
   en v2 solo quedan las 3 últimas; `get_fx_rate`, `calculate_fx_suggestion` y las 4 variantes `_robust`/`_safe`/`_data_*` del holding se
   retiran con `1791400000000`); `updated_at` en 24 funciones y 3 triggers iguales en `contract_lifecycle_events`; `is_holding_admin` /
   `rls_is_holding_admin` e `is_super_admin` / `rls_is_super_admin`.
4. **Funciones de trigger sin trigger:** `trigger_generate_invoices_on_status_change`, `trigger_update_invoices_on_override`,
   `trigger_update_schedule_on_override` (y tras `1791300000000`, `revenue_schedule_update_period_quantities` sin llamadores). Las dos
   `*_on_override` se retiran con `1791400000000`; las otras dos esperan (2.6).
5. **18 assets del repo sin función en producción ni en QA**: `holding_fixed_fx_rate` (nueva, esperado) y 17 de staging/mapeo de Odoo que no
   figuran en el registro de huérfanos (`apply_field_transformations_from_frontend`, `apply_partner_mapping_with_transformations`,
   `classify_invoice_before_insert`, `detect_invoice_changes`, `detect_invoice_line_changes`, `detect_invoice_line_changes_with_dynamic_mapping`,
   `detect_partner_changes`, `detect_partner_changes_with_mapping`, `get_available_transformation_types`, `get_hierarchical_mapping`,
   `get_invoice_integration_stats`, `migrate_existing_partners_to_new_system`, `process_partner_staging_to_client_entities`,
   `process_partner_staging_with_transformations`, `update_odoo_invoices_staging_updated_at`, `validate_hierarchical_mapping`,
   `verify_hierarchical_mapping_extension`, `verify_invoice_staging_integrity`). Un `postgres:assets --apply` sin filtro **las crearía**;
   conviene llevarlas al `REGISTRO-DB-COMO-CODIGO.md` y borrarlas del corpus (o confirmar con Leon si alguna debe existir). Desde
   `1791400000000`, tres de ellas llaman funciones retiradas (`process_partner_staging_to_client_entities` y
   `apply_field_transformations_from_frontend` → `apply_field_mapping_to_data`; `apply_partner_mapping_with_transformations` →
   `resolve_field_transformation`): aplicarlas crearía funciones que fallan al ejecutarse. Una razón más para borrarlas.
6. **Escritores de la API sin la marca** (por eso 1.4 no puede retirarse): `invoice-scheduler.service.ts`, `invoices.service.ts`,
   `stripe-sync.service.ts` (también inserta `invoice_items`: verificar `standardize_invoice_items` antes de su DROP), webhook de Odoo y
   `settings-companies.service.ts` (inocuo).
7. **Comentarios que engañan:** `is_holding_admin` y `user_has_permission` dicen "no usar en políticas RLS" y están en 4 y 5 policies;
   el comentario de `grants/060` dice que las edge usan `mark_overdue_invoices`/`refresh_all_pending_renewals` con service role, pero la edge
   `check-overdue-invoices` hace el UPDATE directo y `refresh_all_pending_renewals` la llama pg_cron (no cambia nada del grant).
8. **Función inexistente llamada:** la edge `rag-chat` (ya retirada) llamaba `match_copilot_rules`, que no existe en la base.

---

## 6 · Comentarios propuestos (sin aplicar)

Para la lista 1, donde hoy no hay comentario o el que hay confunde. Se aplicarán como assets en otra tarea (`COMMENT ON FUNCTION` al final del
asset de cada función, `postgres:assets --apply --only`). Las ⏳ conviene comentarlas en el mismo asset que ya está editado.

```sql
COMMENT ON FUNCTION public.revenue_schedule_apply_fx_for_contract(uuid, date) IS
  'Convierte el devengo ya calculado de un contrato a moneda de compañía y de sistema con la política FX del holding (promedio mensual o tasa fija vía holding_fixed_fx_rate). Paso 2 de revenue_schedule_rebuild.';
COMMENT ON FUNCTION public.holding_fixed_fx_rate(uuid, text, text, date) IS
  'Tasa fija del holding para un par de monedas en una fecha: directa, inversa o, para meses posteriores al mes en curso sin tasa, la última registrada proyectada (projected = true). Única búsqueda de tasa fija para devengo, facturas y API.';
COMMENT ON FUNCTION public.calculate_system_fx_rate IS -- completar la firma vigente al aplicar
  'Tasa para convertir un monto de la moneda del contrato a la moneda del sistema según la política del holding: promedio mensual (exchange_rates) o tasa fija (holding_fixed_fx_rate, proyectada hacia adelante).';
COMMENT ON FUNCTION public.auto_populate_invoice_fx_to_system() IS
  'Trigger de invoices: completa tasa y montos en moneda del sistema usando la moneda del encabezado. No-op con sapira.writer = api (la API usa refreshInvoiceSystemAmounts). Corre para escritores sin la marca: edge de vencidas, Odoo, invoice-scheduler, Stripe.';
COMMENT ON FUNCTION public.contract_item_fx_rate IS -- completar la firma vigente al aplicar
  'Tasa fija pactada (contract_fx_period_rates purpose = item) para convertir un ítem en otra moneda a la moneda del contrato en un mes. Misma moneda: 1. Sin tasa: NULL (quien llama marca missing_fx_rate).';
COMMENT ON FUNCTION public.trigger_rsm_on_invoice_change() IS
  'Trigger de invoices: al crear, cambiar o borrar una factura rehace el devengo del contrato desde ese mes (holding de la fila). No-op con sapira.writer = api.';
COMMENT ON FUNCTION public.trigger_rsm_on_contract_item_change() IS
  'Trigger de contract_items: al crear o cambiar un ítem rehace el devengo del contrato. No-op con sapira.writer = api (la API llama revenue_schedule_rebuild explícito).';
COMMENT ON FUNCTION public.trigger_pending_renewal_on_item_change() IS
  'Trigger de contract_items: recalcula la cola "por renovar" del contrato (apply_pending_renewal_tail). Si falla, avisa y no bloquea la escritura.';
COMMENT ON FUNCTION public.assign_momentum_to_revenue_schedule() IS
  'Trigger de revenue_schedule_monthly: si la fila llega sin momentum, lo deduce de la categoría, el inicio y la renovación del ítem.';
COMMENT ON FUNCTION public.prevent_end_date_update_when_active() IS
  'Invariante: impide cambiar contract_end_date de un contrato Activo. Bypass explícito solo con sapira.bypass_end_date_guard = on (la API lo usa y registra evento).';
COMMENT ON FUNCTION public.validate_contract_currency_consistency() IS
  'Invariante: la moneda del contrato debe ser coherente con la de sus ítems (salvo contrato multimoneda).';
COMMENT ON FUNCTION public.validate_contract_item_currency_consistency() IS
  'Invariante: un ítem solo puede estar en otra moneda que el contrato si el contrato requiere facturación multimoneda.';
COMMENT ON FUNCTION public.trg_validate_cutoff_company_holding_match() IS
  'Invariante de cierres de período: la compañía del registro debe pertenecer a su holding.';
COMMENT ON FUNCTION public.trg_audit_contract_item_changes() IS
  'Trigger de contract_items: registra en el historial de cambios altas, cambios y bajas de ítems de contratos Activo, Cancelado o Expirado. Para la API el usuario queda vacío; el historial v2 son los eventos.';
COMMENT ON FUNCTION public.audit_resolve_user() IS
  'Devuelve id, nombre y correo del usuario de la sesión para la auditoría; vacío si no hay sesión (API, cron).';
COMMENT ON FUNCTION public.set_lifecycle_event_holding_id() IS
  'Trigger de contract_lifecycle_events: exige contrato y copia su holding_id en el evento.';
COMMENT ON FUNCTION public.assign_invoice_group_id() IS
  'Trigger de invoices: asigna invoice_group_id si viene vacío. No-op con sapira.writer = api (la API usa el id de la factura).';
COMMENT ON FUNCTION public.auto_populate_invoice_item_fields() IS
  'Trigger de invoice_items: completa holding, contrato, monedas y estado desde la factura. No-op con sapira.writer = api.';
COMMENT ON FUNCTION public.sync_invoice_items_on_invoice_update() IS
  'Trigger de invoices: si cambia el estado o la fecha de emisión, los copia a todas las líneas de la factura.';
COMMENT ON FUNCTION public.sync_client_entity_primary_client() IS
  'Trigger de client_entity_clients: deja un solo cliente principal por razón social y lo copia a client_entities.client_id. La API depende de él.';
COMMENT ON FUNCTION public.sync_contracts_company_currency() IS
  'Trigger de companies: si cambia la moneda de la compañía, actualiza company_currency en todos sus contratos.';
COMMENT ON FUNCTION public.create_default_roles_for_holding() IS
  'Trigger de company_holdings: al crear un holding le crea los roles por defecto.';
COMMENT ON FUNCTION public.create_quote_stages_for_new_holding() IS
  'Trigger de company_holdings: al crear un holding le siembra las etapas de cotización (create_default_quote_stages_for_holding).';
COMMENT ON FUNCTION public.create_default_quote_stages_for_holding(uuid) IS
  'Crea las etapas de cotización por defecto de un holding (mismo set que quote-status.ts de la API).';
COMMENT ON FUNCTION public.sync_user_on_login() IS
  'Trigger de auth.users en cada ingreso: vincula auth_id, pasa un invitado Pendiente a Activo, guarda last_access y, sin holding, crea "Empresa de X". Única fuente de primer ingreso y último acceso (B1).';
COMMENT ON FUNCTION public.validate_email_matches_domain() IS
  'Invariante: el correo de un remitente debe ser del dominio configurado del holding.';
COMMENT ON FUNCTION public.validate_client_agent_config_email_sender() IS
  'Invariante: la configuración de un agente solo puede usar un remitente del mismo holding.';
COMMENT ON FUNCTION public.cron_invoke_edge_function(text, text) IS
  'Llama una edge function con URL y clave de Vault (sin secretos en el comando). Solo postgres (pg_cron), grants/050.';
COMMENT ON FUNCTION public.update_invoice_timestamp() IS
  'Trigger de odoo_invoices_stg: fija updated_at al actualizar.';
COMMENT ON FUNCTION public.update_invoice_line_timestamp() IS
  'Trigger de odoo_invoice_lines_stg: fija updated_at al actualizar.';
COMMENT ON FUNCTION public.get_current_user_holding_id() IS
  'Holding activo del usuario de la sesión (auth.uid()). Base de las policies RLS; la API no la usa (corre como postgres).';
COMMENT ON FUNCTION public.get_current_user_id() IS
  'Id interno (users.id) del usuario de la sesión; NULL sin sesión (API, cron).';
COMMENT ON FUNCTION public.is_holding_admin IS -- completar la firma vigente al aplicar; reemplaza el texto "no usar en RLS", que hoy es falso
  '¿El usuario de la sesión es administrador del holding? Se usa en 4 policies RLS y en cierre/reapertura de período.';
COMMENT ON FUNCTION public.user_has_permission IS -- completar la firma vigente al aplicar; ídem
  '¿El usuario de la sesión tiene el permiso indicado en su holding? Se usa en 5 policies RLS y en RPC del front viejo.';
COMMENT ON FUNCTION public.rls_is_super_admin() IS
  '¿El usuario de la sesión es super admin? Versión para policies RLS.';
COMMENT ON FUNCTION public.rls_is_holding_admin IS -- completar la firma vigente al aplicar
  '¿El usuario de la sesión es administrador del holding? Versión para policies RLS.';
COMMENT ON FUNCTION public.can_access_financial_data IS -- completar la firma vigente al aplicar
  '¿El usuario de la sesión puede ver datos financieros? Usada en una policy RLS.';
COMMENT ON FUNCTION public.can_manage_financial_data IS -- completar la firma vigente al aplicar
  '¿El usuario de la sesión puede editar datos financieros? Usada en una policy RLS.';
COMMENT ON FUNCTION public.update_updated_at_column() IS
  'Trigger genérico: fija updated_at = now() al guardar la fila.';
```

Las firmas marcadas "completar" se toman de `pg_get_function_identity_arguments` al escribir el asset (una función con comentario necesita su
firma exacta; un `COMMENT` sin firma solo vale si el nombre no está sobrecargado).
