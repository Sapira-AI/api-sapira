# Inventario de Supabase para el switch (crons, edge functions, triggers, RPC, webhooks)

> 03-10-2026 · revisión **solo lectura** (Claude, para Domi). Responde: qué corre en Supabase fuera de la API, quién lo usa
> y qué pasa con cada pieza cuando el front actual (`sapira-ai`, `app.aisapira.com`) se bloquea a los usuarios en el switch.
> Complementa [`estado-v2-y-plan-switch.md`](./estado-v2-y-plan-switch.md) §4–§5,
> [`activacion-costura-triggers.md`](./activacion-costura-triggers.md) y [`plan-coexistencia-funciones.md`](./plan-coexistencia-funciones.md);
> no repite sus tablas por objeto de Contratos, las referencia.
>
> **Fuentes:** producción (`Sapira MVP`, `hklompkypzqtglprfobu`) con `BEGIN TRANSACTION READ ONLY … ROLLBACK`
> (`cron.job`, `cron.job_run_details`, `pg_trigger`, `pg_proc`, privilegios, tablas de uso); logs de Supabase vía MCP
> (`function_logs` día por día del 04-09 al 03-10, `edge_logs` de `/rest/v1/rpc/*` del 30-09, 01-10 y 02/03-10);
> `list_edge_functions`; grep de `sapira-ai/src`, `sapira-ai/supabase/functions`, `api-sapira/src` y `front-sapira`.
> No se cambió nada.

## 0. Lo bloqueante para el switch (resumen)

| # | Qué | Por qué bloquea | Quién |
|---|---|---|---|
| B1 | **`t_sync_user_on_login` no se puede borrar al switch tal como dice §4** | Es lo único que pasa un invitado de `Pendiente` a `Activo`, vincula `auth_id` y escribe `users.last_access` (la API **no** lo hace: grep sin `UPDATE … last_access`). La API lo lee para "alguna vez entró" (reenviar/eliminar invitación) y para la última actividad del holding. Corre en **cualquier** login (los dos fronts comparten Auth). Hay 4 usuarios `Pendiente` hoy. Antes de dropearlo hay que construir en la API "primer ingreso → Activo + `last_access`" (p. ej. en `/me` o en el callback). Mientras: mantener. | Domi |
| B2 | **Carga de MRR histórico / legacy sin reemplazo v2** | El front actual lo sigue usando (30-09: `create_contract_from_mrr_legacy`, `mark_mrr_legacy_skip_activation`). Es el ítem 6 de §3 ("Onboarding y datos históricos"). Sin él, bloquear el front viejo deja a las usuarias sin ese flujo. | Domi |
| B3 | **URLs de Supabase Auth** (Site URL, Redirect URLs, plantillas) | No se ven por SQL. Si el Site URL sigue en `app.aisapira.com`, los enlaces por defecto de Auth (OAuth sin `redirectTo`, correos que aún mande Supabase) llevan al front bloqueado. Revisar en el dashboard de prod y QA antes del switch. | Domi/Leon |
| B4 | **Crear holding no tiene camino v2** | Hoy nace por la "configuración inicial" del front viejo (`useConfiguracionInicial.ts`: INSERT de usuario + `assign_admin_role_safe` + `create_user_holding_association_safe`) o por la rama "Empresa de X" de `sync_user_on_login`. La API no tiene `POST` de holding. No bloquea a los clientes actuales; sí bloquea dar de alta uno nuevo sin SQL a mano. | Domi |

No bloquean pero conviene resolver antes o en el mismo bloque:

- **Seguridad (urgente, independiente del switch):** `public.cron_invoke_edge_function` es `SECURITY DEFINER`, lee la service role
  key de Vault y **tiene EXECUTE para `anon` y `authenticated`**: cualquiera con la anon key puede invocar por
  `/rest/v1/rpc/cron_invoke_edge_function` cualquier edge function con la service role. Debe quedar solo para `postgres`
  (`REVOKE … FROM PUBLIC, anon, authenticated`, asset en `grants/`). Lo mismo, con menos impacto, para `mark_overdue_invoices`,
  `manual_check_overdue_invoices`, `refresh_all_pending_renewals`, `process_auto_renewals`, `execute_auto_renewal_for_item`.
  En general **333 funciones de `public` tienen EXECUTE para `anon`** (331 para `authenticated`); 162 son `SECURITY DEFINER`.
- **Bloquear el front viejo no cierra PostgREST:** la anon key y las 411 policies siguen sirviendo `/rest/v1/*`. Los `REVOKE` de
  §4 son de seguridad, no de funcionamiento: sin ellos, lo que el front viejo podía hacer se puede seguir haciendo con su anon key.
- **`check-overdue-invoices` (edge + cron) es lo único de Supabase que hoy escribe datos de negocio a diario** y la API depende del
  estado `Vencida` que pone. Se mantiene en el switch (ver §1).

## 1. pg_cron

Producción hoy: **2 jobs activos** (`cron.job`). Historial de 30 días (`cron.job_run_details`): 4 jobids.

| Job | Cada cuánto | Qué hace | Estado 30 días | Equivalente en la API | Decisión propuesta | Riesgo |
|---|---|---|---|---|---|---|
| `check-overdue-invoices-daily` (jobid 1) | `1 4 * * *` (UTC) | `cron_invoke_edge_function('check-overdue-invoices')` → la edge pasa a `Vencida` las facturas con vencimiento pasado y registra `overdue_check_log` | 30/30 `succeeded`; `overdue_check_log`: 109 corridas `success`, **512 facturas marcadas en 30 días** (03-10: 7, todas SimpliRoute). `succeeded` en pg_cron solo dice que el POST se encoló; el resultado real está en los logs de la función (revisados: OK) | **No hay**. `billing-states.ts` deriva `Vencida` solo al registrar/anular pagos; ningún scheduler marca vencidas | **Mantener** al switch. Después: llevarlo a un job de la API (`billing.scheduler`) con `sapira.writer = 'api'` y retirar cron + edge | Alto si se apaga: cobranza, KPI y alertas dejan de ver vencidas |
| `refresh-pending-renewals` (jobid 6) | `0 6 * * *` (UTC) | `refresh_all_pending_renewals()` → `apply_pending_renewal_tail` por contrato (proyección `PENDING_RENEWAL` del RSM) | 30/30 `succeeded` | **No hay** (los jobs `contracts-*` de la API proponen renovaciones, no proyectan el RSM) | **Mantener** hasta la sesión RSM (S5, `plan-coexistencia` §2e) | Medio: Ingresos/Métricas leen esa proyección |
| `salesforce-daily-sync` (jobid 2) | — | Edge `salesforce-*` | Última corrida 23-09; **retirado** (migración `RetiraSincronizacionSalesforcePorEdgeFunction`) | `SalesforceScheduler` `30 8 * * *` | Hecho | — |
| `auto-renew-contract-items` (jobid 5) | — | `process_auto_renewals(90)` (fallaba siempre) | Última corrida 01-10; **retirado** (migración `1790700000000-MulticurrencyContract`) | Jobs `contracts-auto-renewal` (06:00) y `contracts-scheduled-changes` (05:30) de la API | Hecho. Quedan sus funciones (`process_auto_renewals`, `execute_auto_renewal_for_item`, `get_items_pending_auto_renewal`) con EXECUTE para `anon`: **retirar al switch** con `create_contract_renewal` | Bajo |

Crons de la API (NestJS, para cruzar): `salesforce` 08:30, `stripe` horario, `banco-central` horario (tipos de cambio),
`invoice-scheduler` horario (envío al ERP), `bigquery` horario (DWH → `quantities`), `contracts` 05:30/05:45/06:00/06:15,
`billing` 08:00 (recordatorios, apagado salvo `BILLING_REMINDERS_ENABLED=true`), `notification-jobs` horario y cada 15 min,
`agents` cada minuto. **No hay duplicados** con pg_cron hoy.

## 2. Edge functions

Desplegadas en producción: **24**. En el repo `sapira-ai/supabase/functions`: 14. Las 10 restantes solo existen desplegadas
(sin fuente en ningún repo). **Uso 30 días** (arranques en `function_logs`, revisado día por día): solo `check-overdue-invoices`
(diario, cron) y la vieja `salesforce-*` (hasta el 22-09). **Ninguna otra función se invocó en 30 días.**

| Función | En repo | Qué hace | Quién la llama | Uso 30 d | ¿La necesita v2? | Decisión propuesta | Riesgo |
|---|---|---|---|---|---|---|---|
| `check-overdue-invoices` | sí | Marca `Vencida` (service role) + `overdue_check_log` | pg_cron | diario | **Sí** (indirecto) | **Mantener**; migrar a la API después | Alto si se borra |
| `send-proforma` | sí | Envía proforma por Resend; registra `invoice_emails` | Front viejo (`facturacion/services/invoiceAdvancedService.ts`) | 0 · `invoice_emails` **vacía** (nunca registró un envío) | No (decisión de Domi: proformas = Automatizaciones, después del switch) | **Retirar después del período de pruebas** (queda sin llamador al bloquear el front). No rotar `RESEND_API_KEY` mientras exista | Bajo |
| `send-collection` | sí | Envía cobranza por Resend | Front viejo (mismo servicio) | 0 · ídem | No (Automatizaciones / `billing` reminders) | Ídem | Bajo |
| `send-invitation` | sí | Crea usuario en Auth, link y correo de invitación | Front viejo (`UserFormModal.tsx`, `UsuariosList.tsx`) | 0 | No (la API invita con Resend propio) | **Retirar al switch** (ya decidido en §4) | Bajo |
| `delete-user` | sí | Borra usuario de Auth y tablas (service role) | Front viejo (`UsuariosList.tsx`) | 0 | No | **Retirar al switch** (ya decidido) | Bajo |
| `sync-exchange-rates` | sí | Sincroniza tipos de cambio (`exchange_rates`, `fx_api_sync_log`) | Front viejo, botón manual (`FxSyncStatusCard.tsx`) | 0 · último registro 02-01-2026 | No: duplicado del `ExchangeRatesScheduler` de la API (Banco Central + Perú, al día al 03-10) | **Retirar al switch** | Nulo |
| `diagnose-odoo-model` | sí | Diagnóstico de modelos de Odoo | Front viejo (`OdooDiagnosticTool.tsx`, `fetch` directo) | 0 | No (Integraciones v2 tiene su diagnóstico/historial) | **Retirar al switch** (avisar a Leon) | Nulo |
| `diagnose-odoo-invoices`, `get-odoo-companies` | sí | Diagnóstico / compañías de Odoo | nadie (sin llamador en ningún repo) | 0 | No | **Retirar ya o al switch** (Leon) | Nulo |
| `chargebee-proxy` | sí | Proxy a Chargebee | nadie (la página `chargebee-test` usa otra ruta) | 0 | No | Retirar al switch | Nulo |
| `data-gateway`, `rag-chat`, `rag-ingest`, `rag-ingest-semantic-catalog` | sí | Copiloto/RAG viejo (`rag_documents` vacía) | nadie | 0 | No (la API tiene `claude` / `sapira-copilot`) | Retirar al switch | Nulo |
| `agents-run`, `agents-approve`, `agents-render-email`, `agents-webhook` | **no** | Agentes viejos (v. 12/2025); `agents-webhook` acepta subidas a `reference_files` con un token que **no valida** ("asumimos que el token es válido") usando service role | nadie (ni repo ni front); webhooks de correo/CRM si alguno quedó configurado | 0 | No (módulo `agents` de la API) | **Retirar ya** (huérfanas y con hueco de seguridad) — revisar con Leon | Bajo |
| `sync-odoo-invoices`, `sync-odoo-partners`, `approve-odoo-invoices`, `process-odoo-invoices`, `process-odoo-lines`, `test-odoo-connection` | **no** | Integración Odoo antigua | nadie | 0 | No (módulo `odoo` de la API) | **Revisar con Leon** y retirar | Bajo |

Notas:

- Las 24 tienen `verify_jwt = true`: basta la anon key para invocarlas. Con `cron_invoke_edge_function` abierta a `anon`, además se
  pueden invocar **con service role** (ver §0).
- `send-proforma` / `send-collection` usan `RESEND_API_KEY` de los secretos de Supabase: no rotarlo ni borrarlo hasta retirarlas.
- `send-invitation` lee `SITE_URL` (secreto de Supabase) para el enlace: confirmar que nadie dependa de él tras el switch.

## 3. Triggers y funciones de trigger en tablas de negocio

> **Lista vigente:** [`catalogo-funciones-y-triggers.md`](./catalogo-funciones-y-triggers.md) (04-10) es la fuente de qué trigger se mantiene,
> cuál se retira y cuál ya se retiró. Esta sección conserva el análisis del 03-10 y el porqué.

Estado en producción (03-10): **la costura está aplicada** (24 funciones con `current_setting('sapira.writer')`, U9 aplicado: los
`trg_rsm_on_*` ya no dependen de la sesión) y `generate_invoices_on_contract_active` ya no existe (generación unificada). Total:
128 triggers de usuario en `public` (incluye ~55 de `updated_at`) + 1 en `auth.users`. Sin webhooks de base (`supabase_functions.hooks`
no existe), sin tablas en `supabase_realtime`, y la única función que hace HTTP es `cron_invoke_edge_function`.

### 3a · Con la costura (no-op cuando escribe la API; completos para el front viejo y para escrituras sin marca)

| Tabla | Triggers (función) |
|---|---|
| `contracts` | `trg_audit_contract_changes`, `trg_set_booking_date_on_activate`, `trigger_auto_calculate_contract_fx`, `trigger_revenue_schedule_on_contract_activation`, `trigger_set_contract_company_currency`, `unified_generate_invoices_on_contract_signed`, `validate_fx_before_firmado` |
| `contract_items` | `trg_calculate_contract_categoria`, `trg_contract_items_calculate_pricing`, `trg_inherit_auto_renew_from_quote_item`, `trg_rsm_on_contract_item_change`, `trg_set_contract_item_end_date`, `trigger_update_contract_term` |
| `invoices` | `invoices_fill_terms_from_contract_trigger`, `trg_assign_invoice_group_id`, `trg_rsm_on_invoice_change`, `trigger_auto_populate_invoice_fx_to_system`, `trigger_auto_populate_invoice_tax_rate` |
| `invoice_items` | `standardize_invoice_items_trigger`, `trigger_auto_populate_invoice_item_fields`, `trigger_sync_invoice_item_contract_id` |
| `invoice_payments` | `trg_recalc_after_{insert,update,delete}` (`after_invoice_payment_change`) |
| `quantities`, `quote_items` | ~~`trg_rsm_on_quantity_change`~~ (retirado 04-10, ver fila de `quantities` abajo); `trg_quote_items_calculate_pricing` |

**Qué pasa cuando el front viejo deja de escribir:** para la API no cambia nada (ya los salta). **Pero no todos quedan sin
escritor**: escriben sin la marca, y por lo tanto los disparan completos,

- la edge `check-overdue-invoices` (UPDATE de `invoices.status` con service role) → `trg_rsm_on_invoice_change`,
  `trigger_auto_populate_invoice_fx_to_system`, `trigger_sync_invoice_items_on_invoice_update`;
- el webhook de Odoo de la API (`odoo-webhook.service.ts`, sin `setApiWriter`) y el sync del DWH (`bigquery.service.ts` → `quantities`)
  → los `trg_rsm_on_*` (U9: es lo buscado) y los de relleno de `invoices` (el DWH ya no: desde el 04-10 llama `revenue_schedule_rebuild` explícito);
- el envío al ERP y los syncs de Stripe/Salesforce de la API que actualizan facturas sin la marca (no verificado uno por uno).

Por eso el **drop "después del período de pruebas"** de §5 del estado no puede ser en bloque: antes, cada escritor sin marca debe
fijar `sapira.writer = 'api'` y hacer explícito lo que hoy le rellena el trigger (como hizo `billing`), o el trigger se conserva.
Candidatos claros a drop tras la baja (solo los usa el front viejo): `unified_generate_invoices_on_contract_signed`,
`validate_fx_before_firmado`, `standardize_invoice_items_trigger`, `trigger_sync_invoice_item_contract_id`,
`trg_inherit_auto_renew_from_quote_item`, `trg_set_contract_item_end_date`, `trg_calculate_contract_categoria`,
`trg_audit_contract_changes`. Los de relleno de `invoices` y los `trg_rsm_on_*`: **revisar con Leon** (escritores de integración).

### 3b · Invariantes y los que la API necesita (mantener siempre)

| Objeto | Por qué se mantiene |
|---|---|
| `trg_00_period_guard_contracts`, `trg_00_period_guard_contract_items`, `trg_cutoff_validate_company_holding`, `trg_events_validate_company_holding` | Guard de período (invariante) |
| `validate_contract_currency_trigger`, `validate_contract_item_currency_trigger`, `validate_holding_fx_period_rates_trigger` | Validadores de moneda (invariante) |
| `trg_prevent_end_date_update_when_active` | Invariante con bypass explícito de la API |
| `trg_audit_contract_item_changes`, `trg_z_fix_renewal_annual`, `trg_zzz_pending_renewal_on_item_change`, `trigger_sync_invoice_items_on_invoice_update` | Siguen corriendo para la API por decisión (activación §Construido); `trg_z_fix_renewal_annual` anotado para la próxima tanda |
| `trg_set_invoice_payment_defaults` | Inocuo para la API (manda todo explícito) |
| `trg_sync_client_entity_primary_client` (`client_entity_clients`) | La API inserta y marca primario: depende de él |
| `trigger_sync_contracts_company_currency` (`companies`) | Propaga la moneda de compañía a contratos; Configuración v2 edita compañías |
| `trigger_create_default_roles`, `trigger_create_quote_stages_on_holding_creation`, `trigger_create_standard_agents` (`company_holdings`) | Siembra del holding nuevo (ver B4) |
| `trigger_validate_email_matches_domain`, `trigger_validate_client_agent_config_email_sender` | Validan remitentes (Comunicaciones v2) |
| `trg_assign_momentum` (`revenue_schedule_monthly`), `update_invoice*_timestamp_trigger` (staging Odoo), `trg_set_lifecycle_event_holding_id_*` | RSM, staging de integración y eventos v2 |
| `updated_at` (~55) | Inocuos |

### 3c · Solo sirven al front viejo (sin costura)

| Objeto | Tabla | Decisión propuesta |
|---|---|---|
| `trg_cancel_schedule_on_contract_cancelled` | `contracts` → `contract_invoices` | Retirar con `contract_invoices` tras la baja (`plan-coexistencia` §6.1) |
| `trigger_log_contract_workflow_transition` | `contracts` | Congelar al switch, drop tras la baja |
| `trg_set_amendment_holding`, `trg_set_amendment_item_holding` | `contract_amendments*` | Drop con las tablas tras la baja |
| 4 triggers de `quantities` (`trg_quantities_set_holding`, `trg_validate_quantity_invoice_status`, `trg_sync_invoice_items_from_quantities`, `trg_restore_invoice_items_on_quantity_delete`) | `quantities` | **Ojo:** el DWH de la API **sigue escribiendo `quantities`**: no son solo del front viejo. Mantener hasta que `bigquery.service.ts` escriba `consumption_entries` (decisión #11, Leon). **Retirados el 04-10** (Domi, corrección de datos): `trg_rsm_on_quantity_change` y `trg_restore_rsm_on_quantity_delete` con sus funciones (`1791300000000-RetiraTriggersDevengoQuantities`); el DWH recalcula el devengo con `revenue_schedule_rebuild` y el front viejo deja de moverlo al editar cantidades. `revenue_schedule_update_period_quantities` quedó sin llamadores (candidata a retiro) |
| 4 de `invoice_items_legacy_match`, 3 de `mrr_legacy`, 1 de `invoices_legacy` | legacy | Mantener hasta que exista el módulo de datos históricos v2 (B2) |
| `t_sync_user_on_login` | `auth.users` | **Mantener** hasta B1; al dropearlo se va también la rama "Empresa de X" |

## 4. RPC y permisos que solo usa el front viejo

> **Lista vigente:** [`catalogo-funciones-y-triggers.md`](./catalogo-funciones-y-triggers.md) §2 (con el estado de `REVOKE` tras `grants/030`,
> `grants/050` y `grants/060`, y las 70 funciones sin uso detectado). Esta sección conserva el uso medido el 03-10.

El front viejo llama **61 funciones** por `rpc()` (grep 03-10); todas existen y todas tienen EXECUTE para `anon` y `authenticated`.
La API llama directamente solo `revenue_schedule_rebuild`, `get_cutoff_date`, `contract_item_fx_rate` y `calculate_system_fx_rate`
(más las que corren dentro de triggers); el front nuevo, ninguna. Uso real (edge_logs, referer `app.aisapira.com`):

- **Sesión/tenancy** (a diario, miles): `get_entities_by_client` (29.627 llamadas el 30-09), `get_current_user_holding_id`,
  `get_user_holding_id`, `get_current_user_permissions`, `get_current_user_id`, `get_cutoff_date`. Quedan hasta la baja: son el
  corazón de las RLS (no se tocan al switch).
- **Negocio usadas 30-09 / 01-10:** `reset_invoice_odoo_draft`, `sync_invoices_for_contract_item`, `apply_quote_downsell_to_contract`,
  `invoice_items_bulk_update_description`, `assign_clients_to_entity`, `apply_fixed_fx_to_contract`, `create_credit_note_safe`,
  `bulk_activate_contracts`, `invoice_reschedule_items`, `apply_contract_contraction`, `unify_invoices_multi_contract`,
  `create_contract_from_mrr_legacy`, `mark_mrr_legacy_skip_activation`. Todas tienen destino en `plan-coexistencia` §4/§5 salvo las de
  legacy (B2) y `assign_clients_to_entity` (cubierta por Clientes v2).

| Función | Llamador (front viejo) | Grants hoy | Decisión propuesta | Riesgo |
|---|---|---|---|---|
| `invite_user_safe` | `UserFormModal.tsx:151` | anon+auth, DEFINER | **REVOKE al switch** (§4 del estado) → DROP tras pruebas | Bajo |
| `update_user_role_safe` | `EditRoleModal.tsx:67` | anon+auth, DEFINER | Ídem | Bajo |
| `delete_current_user` | `pages/Auth.tsx:28` | anon+auth, DEFINER | Ídem (#23 de `revision-seguridad-api.md`) | Bajo |
| `delete_user_complete` | ninguno (ni front ni edge); solo la nombra `delete_current_user` | anon+auth, DEFINER | Ídem; verificar que `delete_current_user` no la necesite antes del DROP | Bajo |
| `assign_admin_role_safe`, `create_user_holding_association_safe` | `useConfiguracionInicial.ts` (alta de holding) | anon+auth | **Revisar** con B4: si se revocan, no hay forma de crear holding sin SQL | Medio |
| `cron_invoke_edge_function` | pg_cron | **anon+auth**, DEFINER, lee Vault | **REVOKE ya** a PUBLIC/anon/authenticated (§0) | Alto hoy |
| `generate_missing_invoices_for_contract` | `LegacyContractActivationModal.tsx`, `useContractInvoiceGeneration.ts` | anon+auth | `grants/030` sigue **sin aplicar**: REVOKE al switch, DROP tras la baja | Bajo |
| `approve_contract_amendment` | vía `create_contract_cross_sell` (DEFINER) | anon+auth | REVOKE al switch (`plan-coexistencia` §2b) | Bajo |
| Resto de RPC de Contratos y Facturación | ver `plan-coexistencia` §2 y §4 | anon+auth | REVOKE `authenticated` al switch, DROP tras pruebas | Según tabla del plan |
| `audit_user_holding_security`, `detect_orphaned_users`, `get_table_columns`, `revenue_monthly_journal`/`_summary`, `populate_initial_revenue_schedule`, `cleanup_old_processed_records` | pantallas admin/revenue viejas | anon+auth | Retirar después del período de pruebas | Bajo |

## 5. Webhooks externos

| Origen | Destino hoy | ¿Depende del front viejo o de una edge? | Decisión |
|---|---|---|---|
| Odoo (facturas) | API `POST /odoo/webhooks` (`odoo-webhook.controller.ts`) | No | Mantener. Escribe sin `sapira.writer` (ver §3a) |
| Stripe | Sin webhook: `StripeScheduler` horario consulta la API de Stripe | No | Mantener (pendiente de Leon: sync atrasado, §4 del estado) |
| Salesforce | Sin webhook: `SalesforceScheduler` 08:30 | No | Mantener |
| Correo/CRM de los agentes viejos | Edge `agents-webhook` (si quedó configurado en algún proveedor) | Edge huérfana | 0 invocaciones en 30 días → retirar (§2) |
| Supabase Auth (Site URL / redirects) | probablemente `app.aisapira.com` | Sí | **B3**: revisar en el dashboard |
| reCAPTCHA / CORS de la API | lista con `app.aisapira.com` (`recaptcha.service.ts`, `FRONTEND_ORIGINS`) | Sí, como origen permitido | Quitar `app.aisapira.com` al retirar el front viejo (después) |

No se encontró ningún webhook externo que apunte a `app.aisapira.com` ni a una edge function en uso. No se verificó la
configuración del lado de Odoo, Stripe ni Resend (solo el código y la base).

## 6. Orden propuesto

1. **Ya (sin esperar el switch, con OK):** REVOKE de `cron_invoke_edge_function` y de las funciones de cron a `anon`/`authenticated`;
   borrar las edge huérfanas `agents-*` (con Leon) y las Odoo sin fuente.
2. **Antes del switch:** B1 (API marca primer ingreso y `last_access`), B2 (históricos), B3 (URLs de Auth), decidir B4.
3. **Al switch:** REVOKE de las RPC de usuarios (§4) y de las de Contratos/Facturación que el plan marca; borrar `send-invitation`,
   `delete-user`, `sync-exchange-rates`, `diagnose-odoo-model`, `diagnose-odoo-invoices`, `get-odoo-companies`, `chargebee-proxy`,
   `data-gateway`, `rag-*`; `grants/030`. **No** tocar `check-overdue-invoices`, `refresh-pending-renewals` ni `t_sync_user_on_login`.
4. **Después del período de pruebas:** `send-proforma` y `send-collection` (y recién entonces rotar `RESEND_API_KEY`); drop de los
   triggers de §3a que solo usa el front viejo y de §3c; migrar `check-overdue-invoices` a la API; tenancy y policies al final.
