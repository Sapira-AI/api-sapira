# Inventario de llamadas `supabase.rpc()` del front viejo

> Insumo para dos trabajos: (1) la **migración módulo a módulo** al front nuevo consumiendo la API
> (cada rpc debe convertirse en endpoint, absorberse en el contexto de sesión, o descartarse), y
> (2) la **limpieza del corpus**: una función rpc-eada desde el front no se puede tocar sin mirar acá.
>
> Fecha del barrido: 2026-09-14 · revisión de vigencia: 2026-09-21 (endpoints re-contados: siguen 272/40; recaptura de funciones marcada abajo).
> **Repos**: el front viejo es la carpeta local `sapira-ai` (la docu lo llama `front-sapira-vite`);
> el front nuevo es `front-sapira` (Next.js). **El front nuevo tiene cero llamadas `rpc()`** —
> verificado en `app/`, `lib/` y `components/`.

## Método

Barrido de `src/**/*.ts{,x}` del front viejo con tres patrones: `supabase.rpc('<literal>')`,
el wrapper `runRpc('<literal>')` de `useInvoiceBulkUpdate.ts`, y los dos sitios con nombre
dinámico (`invoiceAdvancedService.ts:208` resuelve a `bulk_emit_invoices_safe` |
`bulk_emit_invoices_with_scheduled_dates`; `useInvoiceBulkUpdate.ts:32` es el wrapper anterior).
No quedan sitios de llamada sin resolver.

## Resumen

| Métrica | Valor |
|---|---:|
| Funciones distintas llamadas por rpc | **79** |
| Sitios de llamada (pares archivo→función) | 168 |
| Archivos que llaman rpc | 56 |
| Funciones rpc sin archivo en `functions/` del corpus | **0** |
| Funciones huérfanas del corpus llamadas por rpc | **0** |

> La cifra "64 funciones" que circula en la docu del corpus quedó corta: son **79**. La diferencia
> son el wrapper `runRpc` (3), los 2 nombres dinámicos y llamadas agregadas después de ese conteo.

> ✅ *(Resuelto 16-09, verificado contra prod el 21-09)*: `apply_quote_downsell_to_contract` y
> `prevent_end_date_update_when_active` habían quedado desactualizadas en el corpus tras las
> migraciones de Domi del 14-09; se recapturaron desde producción (`8846d14`) y hoy son idénticas.

## Clasificación por destino en la API

### 1 · Sesión y tenancy — NO se convierten en endpoints (13 funciones)

Existen porque el front habla directo con Postgres y necesita resolver "quién soy / qué holding
veo" por RLS. Con la API en el medio, esto lo resuelve el **contexto de autenticación** (JWT →
usuario/holding/permisos) una sola vez por request. Son además las más llamadas (las dos primeras
concentran 90 de los 168 sitios).

| Función | Sitios | Se reemplaza por |
|---|---:|---|
| `get_current_user_holding_id` | 69 | contexto de sesión de la API |
| `get_user_holding_id` | 21 | idem (es la variante vieja; unificar) |
| `get_current_user_id` | 5 | idem |
| `get_current_user_permissions`, `is_super_admin`, `is_holding_admin`, `can_access_financial_data`, `can_manage_financial_data` | 6 | endpoint único `GET /me` (perfil + permisos) o claims |
| `get_user_company_id` | 2 | contexto de sesión |
| `check`-style de seguridad: `audit_user_holding_security`, `detect_orphaned_users` | 2 | módulo admin (ver §6) |
| `delete_current_user` | 1 | endpoint de cuenta (`DELETE /me`), con cuidado: hoy es autoservicio |
| `create_user_holding_association_safe`, `assign_admin_role_safe` | 2 | onboarding/admin de usuarios |

**Nota RLS**: estas funciones también las usan las policies. Que el front deje de llamarlas NO las
vuelve borrables — `get_user_holding_id()` es el corazón de las 385 policies.

### 2 · Contratos — ciclo de vida (≈27 funciones, el módulo más grande)

Todas van al módulo `contracts` de la API como endpoints de acción. Grupos naturales:

- **Movimientos comerciales**: `create_contract_renewal`, `create_contract_upsell`,
  `create_contract_downsell`, `create_contract_cross_sell`, `create_contract_churn`,
  `apply_quote_downsell_to_contract`, `apply_contract_contraction`, `register_item_non_renewal`,
  `approve_contract_amendment`.
- **Estado y flujo**: `mark_contract_signed_safe`, `bulk_activate_contracts`,
  `migrate_contracts_to_new_workflow`, `bulk_restructure_contract_start_dates`.
- **FX**: `apply_fixed_fx_to_contract`, `bulk_confirm_fx_policy`, `change_contract_currency`.
- **Cliente/entidad del contrato**: `change_contract_commercial_client`.
- **Facturas derivadas del contrato**: `generate_missing_invoices_for_contract`,
  `regenerate_contract_invoices_from_items`, `sync_invoices_for_contract_item`,
  `reset_invoice_odoo_draft`, `invoice_reschedule_items`, `invoice_bulk_update_terms`,
  `invoice_items_bulk_update_description`, `invoice_reassign_entity`.
- **Consultas**: `get_contract_reconciliation`, `recalc_revenue_for_contract`.

### 3 · Facturación (≈12 funciones)

Módulo `invoices`: `emit_invoice_safe`, `emit_invoice_manually`, `bulk_emit_invoices_safe`,
`bulk_emit_invoices_with_scheduled_dates`, `edit_pending_invoice`, `adjust_issued_invoice`,
`create_credit_note_safe`, `reschedule_invoice_safe`, `consolidate_invoices_simple`,
`unconsolidate_invoices_simple`, `unify_invoices_multi_contract`, `get_next_invoice_number`.

### 4 · Legacy / MRR (≈9 funciones)

Módulo `legacy` (o dentro de contratos): `activate_legacy_contract`,
`create_legacy_contract_with_items`, `create_contract_from_mrr_legacy`,
`derive_contract_items_from_legacy`, `validate_legacy_activation`, `reconcile_legacy_invoice`,
`reconcile_legacy_with_por_emitir`, `confirm_legacy_invoice_reconciliation`,
`update_legacy_reconciliation_pct`, `mark_mrr_legacy_skip_activation`, `delete_mrr_legacy_group`.
Decisión de scope ✅ (Domi 14-09): UI nueva como todo lo demás; funcionalidad mínima primero.

### 5 · Revenue / Reportes / Períodos (≈7 funciones)

- Revenue: `revenue_monthly_summary`, `revenue_monthly_journal`,
  `get_monthly_revenue_schedule_by_product`, `revenue_schedule_rebuild`,
  `populate_initial_revenue_schedule`.
- Períodos contables: `close_period_until`, `reopen_period_from`, `get_cutoff_date`.

Los hooks de MRR (`useMRR*`) hoy solo rpc-ean `get_current_user_holding_id` y consultan tablas
directo — su migración es más "query → endpoint de reporte" que "rpc → endpoint".

### 6 · Clientes y entidades (5 funciones)

Módulo `clients`: `get_entities_by_client`, `get_clients_by_entity`,
`get_commercial_clients_by_tax_id`, `assign_clients_to_entity`, `unassign_client_from_entity`.

### 7 · Utilidades e integraciones (2 funciones)

- `get_table_columns`: introspección para la UI de mapeos de integraciones. En la API esto es un
  endpoint de metadata del módulo de integraciones (o se elimina si la UI nueva no lo necesita).
- `cleanup_old_processed_records`: mantenimiento de staging Odoo, disparado desde la UI.
  **Es la hermana de las `cleanup_*` candidatas a limpieza — esta SÍ se usa, no eliminar.**

## Implicancias para la limpieza del corpus

- Ninguna de las funciones huérfanas del corpus aparecía en este inventario → se eliminaron sin
  riesgo el 21-09 (REGISTRO-DB-COMO-CODIGO punto 4).
- Toda auditoría de no-uso de una función debe cruzar contra **este archivo** además del grep en
  ambos repos: el nombre viaja como string.
- Cuando un módulo del front nuevo reemplace al viejo, las funciones de su sección quedan con un
  solo consumidor (la API) o ninguno — recién ahí se reevalúa si la lógica vive mejor en NestJS y
  la función SQL se retira (con el procedimiento de borrado del README del corpus).

## Barrido de endpoints existentes en la API (2026-09-14)

**272 endpoints en 40 controllers**, enumerados desde los decoradores `@Controller`/`@Get|Post|...`
de `src/modules/`. Distribución: salesforce 59 · odoo 50 · stripe 34 · bigquery 16 ·
banco-central 15 · agents 12 · clients 12 · invoices 12 · emails 10+4 · sii 7 · users 6 ·
sapira-copilot 6 · database 5 · devices 5 · holdings 5 · notifications 5 · utils 4 ·
subscriptions 3 · claude 1 · dashboard 1.

**El mapa de brechas contra este inventario rpc es nítido — la API es fuerte exactamente donde el
front viejo NO rpc-ea, y está vacía donde más rpc-ea:**

| Sección rpc | Endpoints hoy | Brecha |
|---|---|---|
| §1 Sesión/tenancy | `GET /users/me`, `/users/me/context`, `POST /holdings/select` ✓ | Chica: falta consolidar permisos en `/me` |
| §2 Contratos (~27 fns) | **0** — no existe módulo `contracts` | **Total** — la brecha más grande |
| §3 Facturación (12 fns) | 12, pero casi todos scheduler/odoo-logs/auto-invoice | **Alta**: no hay emitir, NC, consolidar, editar |
| §4 Legacy/MRR (~11 fns) | **0** | Total |
| §5 Revenue/Reportes/Períodos (7 fns) | `GET /dashboard/home` solamente | **Alta** |
| §6 Clientes/entidades (5 fns) | Módulo `clients` cubre entities/set-primary ✓ | Chica: falta `get_commercial_clients_by_tax_id` |
| §7 Utilidades (2 fns) | `GET /database/list-tables` afín a `get_table_columns` | Chica |
| Integraciones (0 fns rpc de negocio) | 159 endpoints (SF+Odoo+Stripe+BQ) ✓ | Ninguna — ya viven en la API |

Lectura para el plan: los módulos de integraciones se migran de front **ya** (la API los cubre
completos); contratos + facturación operativa + revenue/períodos + legacy necesitan construir el
módulo de API **antes** (o junto con) su front. Cotizaciones tampoco tiene endpoints y su front
rpc-ea poco: su brecha es más de CRUD directo que de funciones.

> Nota aparte del barrido: conviven `email/` y `emails/` con endpoints casi idénticos
> (`send-test`, `verify-domain`, `check-status`) — candidato a consolidación en la limpieza.

## Pendientes de este inventario

- [ ] Validar contra Leon la partición por módulos de API propuesta (§2–§7).
- [ ] Decidir el patrón de autorización (JWT propagado a Postgres vs autorización en NestJS) — §1
  depende de eso.
- [x] Barrido de endpoints existentes (sección anterior).
