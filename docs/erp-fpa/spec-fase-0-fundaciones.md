# Spec corta · Fase 0 — Fundaciones del ERP (nov-2026, 3 semanas)

> Para OK de Domi antes de construir. Formato HOY → DELTA, verificado contra el código el 19-10-2026. Sigue las [decisiones del 19-10](roadmap-erp-fpa.md#7-decisiones-tomadas-por-domi-el-19-10-2026-fase-0): prefijos en `public`, nombres Tesorería / Contabilidad / Planificación, solo Chile. Índice: [README](README.md). Base de datos: [estrategia](estrategia-base-de-datos.md).

## Alcance

La Fase 0 no entrega nada visible a usuarias finales. Deja listas seis piezas sobre las que se construyen Caja (Fase 1) y Libro (Fase 2), **apagadas** en producción: plan de cuentas, períodos por mes, log de eventos tipado, contrapartes, permisos y laboratorio con flag por holding. Todo se mergea a `qa` y `main` detrás de permisos que nadie tiene y de un flag que solo super admin activa.

**Fuera de alcance**: asientos, bancos, facturas recibidas, impuestos, cualquier pantalla de Tesorería o Contabilidad con datos (Fase 1 y 2).

## 1. Plan de cuentas

**HOY.** La única noción de cuenta es `company_account_mappings` (`entities/clientes/company-account-mapping.entity.ts`): una fila por compañía con 5 cuentas (ingreso, por facturar, diferido, por cobrar, diferencia de cambio) como pares `*_account_code` / `*_account_name` + `external_*_code` del ERP. `src/core/utils/account-mappings.ts` define las 5 claves, etiquetas y el criterio "cuentas completas" que usan Administración (árbol y Compañía 360) e Ingresos (excepción `no_account_mapping`). El asiento de devengo (`GET /metrics/revenue/journal`) se arma al vuelo con esos 5 códigos.

**DELTA.**
- `gl_chart_templates` (`country`, `regime`, `name`, `version`, `is_active`) y `gl_chart_template_accounts` (`template_id`, `code`, `name`, `parent_code`, `level`, `type`, `normal_balance`, `cash_flow_category`, `tax_tags jsonb`, `default_role`). Una plantilla **"Chile · pyme"** de 3 niveles (~120 cuentas: Activo, Pasivo, Patrimonio, Ingresos, Costos y gastos, Cuentas de orden) con etiquetas tributarias para F29 (IVA débito, IVA crédito, PPM, retenciones) y categoría de flujo de caja. Chile no impone un plan: la plantilla es de Sapira y se versiona como seed (`seed/009-gl-chart-template-cl.sql`).
- `gl_accounts`: por compañía. `company_id`, `holding_id`, `code`, `name`, `parent_id`, `level`, `type` (CHECK: asset, liability, equity, revenue, expense, memo), `normal_balance` (debit, credit), `cash_flow_category`, `tax_tags jsonb`, `is_reconcilable`, `is_bank`, `is_postable` (solo hojas), `external_codes jsonb` (código en el ERP anterior por sistema), `is_active`, `template_account_code`. Único `(company_id, code)`. Una compañía nueva recibe la plantilla de su país al crearse (hoy la compañía nace sin cuentas); las existentes la reciben con el botón "Aplicar plantilla".
- `gl_account_roles`: `company_id`, `role` (CHECK: receivable, deferred_revenue, unbilled_revenue, revenue, fx_gain, fx_loss, payable, vat_debit, vat_credit, retained_earnings, bank, cash, suspense), `account_id`, `external_code`. Único `(company_id, role)` salvo `bank` (una por cuenta bancaria, Fase 1). Es `company_account_mappings` generalizada.
- **Compatibilidad**: `company_account_mappings` se **congela**. Al final de la Fase 0 un script migra sus filas a `gl_accounts` (creando las cuentas que no estén en la plantilla) y `gl_account_roles`, con conteo previo en prod en solo lectura, OK de Domi y respaldo en `sapira_backups.company_account_mappings_fase0_<fecha>`; la tabla se reemplaza por una **vista** del mismo nombre y columnas sobre `gl_account_roles`, así `accountsCompleteSql`, Ingresos y el árbol de Administración siguen leyendo igual. Las escrituras de Compañía 360 › Cuentas pasan al endpoint nuevo.
- **API** (`src/modules/accounting`, `HoldingScopeGuard`, `withApiWriter`): `GET /accounting/companies/:id/accounts` (árbol), `POST …/accounts` y `PATCH …/accounts/:accountId` (alta y edición; borrar solo si nunca se usó, si no `is_active = false`), `POST …/accounts/apply-template`, `GET/PUT …/account-roles`, `GET /accounting/chart-templates`. Permiso: `VIEW_/EDIT_CONTABILIDAD`.
- **Front**: en Administración › Compañía 360, la pestaña "Cuentas" pasa a mostrar el plan (árbol con búsqueda, alta, edición, roles) **solo si el holding tiene el flag de Contabilidad**; sin flag, sigue el formulario actual de 5 cuentas leyendo la vista. BFF `app/api/configuracion/companias/[id]/cuentas/*` → `PERMISOS_BFF`.

## 2. Períodos contables por mes y libro

**HOY.** `accounting_period_cutoff` (una fila por holding × compañía, `cutoff_date`: todo ≤ cerrado), `accounting_period_events` (auditoría), `AccountingPeriodsService` (`settings/accounting-periods.service.ts`: `get`, `close`, `reopen` con `FOR NO KEY UPDATE`), endpoints `GET /settings/companies/:id/periods`, `POST …/close`, `POST …/reopen`, permiso `CLOSE_PERIODS`. Triggers de invariante `trg_00_period_guard_contracts` y `_contract_items` bloquean ediciones antes del corte según `sapira.period_guard_mode`. Alerta de cierre de mes en `notification-jobs`.

**DELTA.**
- `gl_periods`: `company_id`, `holding_id`, `book` (CHECK: statutory, ifrs, management; default statutory), `period_month date` (día 1), `status` (CHECK: open, soft_closed, closed), `closed_at`, `closed_by`, `reopened_at`, `reason`. Único `(company_id, book, period_month)`. `soft_closed` = cerrado para operación (facturas, pagos) pero abierto para ajustes de cierre con `CLOSE_PERIODS`; `closed` = inmutable. Se crean los 12 meses del año en curso al activar el flag, y los siguientes al pasar el año (job mensual existente de notificaciones).
- `accounting_period_cutoff` se mantiene como **proyección**: el servicio escribe `cutoff_date` = fin del último mes `closed` del libro `statutory` en la misma transacción que cambia `gl_periods`. Los triggers de contratos y el guard siguen leyendo el cutoff sin cambios. En Fase 2 el trigger de inmutabilidad de asientos lee `gl_periods` directamente.
- **API**: `GET /settings/companies/:id/periods` devuelve además `months[]` por libro; `POST …/periods/:month/close`, `…/soft-close`, `…/reopen` (mismo permiso `CLOSE_PERIODS`, mismo registro en `accounting_period_events` con `book` y `period_month` nuevos). `close` y `reopen` actuales se conservan y operan sobre el libro `statutory`.
- **Front**: Compañía 360 › Períodos pasa de una fecha de corte a una grilla de 12 meses por libro (con flag); sin flag, igual que hoy.

## 3. Log de eventos tipado (`document_events`)

**HOY.** No hay un log único de "qué pasó". Existen logs por tabla (`contract_lifecycle_events`, `contract_change_log`, `quote_events`, `invoice_restructure_log`, `accounting_period_events`, `onboarding_events`), auditoría genérica en Mongo (`AuditInterceptor`) y un `EventDispatcherService` en proceso sin persistencia. `app_notifications` y los agentes (`spec-agentes-ia.md`, F1) necesitan eventos como trigger; `spec-tablas-por-modulo.md` §6 lo planeó como `document_events`.

**DELTA.**
- `document_events`: `id`, `holding_id`, `company_id` (nullable), `document_type` (CHECK: invoice, credit_note, payment, bank_transaction, contract, contract_item, quote, client_entity, journal_entry, bill, period, budget, import), `document_id uuid`, `event_type text` (catálogo en código: `invoice.issued`, `invoice.sent`, `invoice.paid`, `invoice.voided`, `credit_note.applied`, `payment.registered`, `payment.voided`, `bank_transaction.imported`, `bank_transaction.matched`, `contract.activated`, `contract.churned`, `period.closed`, `period.reopened`, `account.created`…), `occurred_at`, `actor_kind` (CHECK: user, agent, system, integration), `actor_id`, `actor_label`, `payload jsonb` (diff mínimo, montos, moneda), `correlation_id` (une los eventos de una misma operación), `dedup_key` (único parcial, para no duplicar al reintentar), `created_at`. Índices `(holding_id, occurred_at desc)`, `(document_type, document_id)`, `(holding_id, event_type, occurred_at)`. Sin `updated_at`: es append-only (trigger de invariante que rechaza UPDATE y DELETE).
- **Emisión**: `DocumentEventsService.record(runner, event)` dentro de la transacción del servicio que hace el cambio (misma regla que `withApiWriter`), más `EventDispatcherService` para los suscriptores en proceso. Primeros emisores en Fase 0: facturas (emitir, enviar, pagar, anular, NC), pagos, períodos, cuentas y roles. Los logs por tabla **no se migran ni se borran**: siguen; `document_events` es la fuente nueva hacia adelante.
- **Consumidores**: ninguno nuevo en Fase 0. Fase 1 (agentes de alerta, Tesorero) y Fase 2 (asientos automáticos) se suscriben.
- **API**: `GET /documents/:type/:id/events` (línea de tiempo), permiso del módulo dueño del documento.

## 4. Contrapartes (clientes y proveedores en la misma entidad legal)

**HOY.** `client_entities` es la razón social (`tax_id`, `legal_name`, `country_code`, `commune`, `payment_terms jsonb`, `odoo_partner_id`, `odoo_fiscal_position_*`), siempre colgada de un `client_id`. No hay proveedores ni unicidad de RUT (la alerta de RUT duplicado está en las mejoras cortas de octubre).

**DELTA.**
- Columnas nuevas en `client_entities`: `is_customer boolean NOT NULL DEFAULT true`, `is_vendor boolean NOT NULL DEFAULT false`, `vendor_payment_terms jsonb` (misma forma y CHECK que `payment_terms`), `vendor_default_account_id uuid` (FK `gl_accounts`, cuenta de gasto por defecto, nullable), `vendor_since date`. `client_id` pasa a **nullable** (un proveedor puro no tiene cliente comercial); el CHECK `client_entities_role_check` exige `is_customer OR is_vendor` y `client_id IS NOT NULL` cuando `is_customer`.
- **RUT genéricos (Domi, 19-10)**: los clientes de exportación comparten el RUT 55.555.555-5 en el DTE, y consumidor final usa 66.666.666-6; el catálogo `generic_export_vats` y la constante `GENERIC_EXPORT_VATS` (`modules/odoo/constants`, usados por el import de partners) ya los conocen. Por eso la unicidad **no puede ser sobre `tax_id` a secas**:
  - columna nueva `tax_id_kind text NOT NULL DEFAULT 'national'` (CHECK: national, generic_export, generic_consumer, foreign), que la API fija al crear o editar a partir del catálogo (un predicado de índice no puede leer una tabla, así que el tipo vive en la fila);
  - columna nueva `foreign_tax_id text` (RFC, NIT, CUIT, EIN, CNPJ… del cliente extranjero) junto a `country_code`: el `tax_id` sigue siendo el genérico que exige el DTE, la identidad real va aquí;
  - índice único parcial `uq_client_entities_holding_tax_id ON (holding_id, upper(tax_id)) WHERE tax_id IS NOT NULL AND tax_id_kind = 'national'` **solo si el conteo en prod de duplicados nacionales es cero**; si hay, índice no único + aviso en la API hasta limpiarlos con la mejora corta de octubre, y el único se agrega después;
  - segundo índice único parcial `uq_client_entities_holding_foreign ON (holding_id, country_code, upper(foreign_tax_id)) WHERE foreign_tax_id IS NOT NULL`;
  - la **alerta de RUT duplicado** de las mejoras cortas de octubre debe usar la misma regla: nunca avisar por un RUT genérico. Script de la Fase 0: marcar `tax_id_kind` en las filas existentes según el catálogo (solo lectura primero, OK, respaldo).
- Ningún cambio en los flujos de Clientes: el filtro por defecto de las listas actuales es `is_customer = true`. Un proveedor que también es cliente es la **misma fila** con ambos flags.
- **API**: `GET /counterparties?role=vendor|customer&q=` (lectura unificada para Tesorería y Contabilidad), `POST /counterparties` (alta de proveedor sin cliente), `PATCH /client-entities/:id/roles`. Permiso: `VIEW_/EDIT_CONTABILIDAD` para proveedores; Clientes sigue con los suyos. Nombre en la interfaz: "Razón social" sigue en Clientes; "Proveedores" aparece en Tesorería y Contabilidad (Fase 1).

## 5. Permisos

**HOY.** `PERMISSION_MODULES` (`settings/permissions-catalog.ts`) con VIEW_/EDIT_ por módulo, `SPECIAL_PERMISSIONS` = `CLOSE_PERIODS`, etiquetas en `guards/permission-codes.ts`, seeds `seed/00N-*.sql`, roles por defecto en `functions/create_default_roles_for_holding.sql`, y en el front `MODULOS_V2` + `PERMISOS_BFF` (`lib/rutas-modulos.ts`) con test que recorre rutas y literales.

**DELTA.**
- Códigos nuevos: `VIEW_TESORERIA`, `EDIT_TESORERIA`, `VIEW_CONTABILIDAD`, `EDIT_CONTABILIDAD`, `VIEW_PLANIFICACION`, `EDIT_PLANIFICACION`; especial `POST_JOURNAL` (postear y revertir asientos, se usa desde Fase 2 pero se crea ahora para que los roles ya lo tengan). `CLOSE_PERIODS` se conserva.
- Seed `seed/010-erp-permissions.sql` (INSERT en `permissions`), tres filas nuevas en `PERMISSION_MODULES` (Tesorería, Contabilidad, Planificación; aparecen en la matriz de Roles y permisos aunque el flag esté apagado: así el admin prepara roles antes de activar), etiquetas y frases 403 en `permission-codes.ts` (`ACTION_LABELS`: "ver la tesorería", "editar la contabilidad"…), `create_default_roles_for_holding.sql`: Administrador y Finanzas reciben los 6 VIEW/EDIT + `POST_JOURNAL`; los demás roles nada; seed `011` para holdings existentes (mismo patrón que `005-finanzas-view-configuracion.sql`).
- Front: `MODULOS_V2` suma `tesoreria`, `contabilidad`, `planificacion` con `ruta` final (`/tesoreria`, `/contabilidad`, `/planificacion`) y `rutaLab` (`/lab/tesoreria`, …); `PERMISOS_BFF` para `app/api/tesoreria/*`, `app/api/contabilidad/*`, `app/api/planificacion/*`; `lib/rutas-modulos.test.ts` se actualiza con las páginas nuevas del lab. `permiso-codes` del front en `lib/permisos.ts` (o donde viven las constantes `VIEW_*`).

## 6. Laboratorio y flag por holding

**HOY.** `/lab` (`app/(protected)/lab/layout.tsx` con `DESIGN_LAB_ENABLED` + `VIEW_LAB`) muestra solo Automatizaciones; `RUTAS_EN_CONSTRUCCION = ['/lab', '/lab/automatizaciones']`. No existe un flag por holding para módulos: los módulos del laboratorio son visibles para todo holding si la usuaria tiene `VIEW_LAB`.

**DELTA.**
- Columna `holding_settings.erp_modules jsonb NOT NULL DEFAULT '{}'` con forma `{ "tesoreria": true, "contabilidad": false, "planificacion": false }` (CHECK de claves conocidas). Solo super admin la cambia: `PATCH /holdings/:id/erp-modules` (`@SuperAdminOnly`) y un bloque "Módulos en piloto" en Administración › Holding 360 visible solo para super admin.
- Guard `RequireErpModuleGuard` + decorador `@RequireErpModule('contabilidad')` en los controladores nuevos: con el flag apagado responde 404 `module_not_enabled` (el módulo no existe para ese holding), antes del chequeo de permiso. `GET /users/me/context` agrega `erp_modules` para que el front decida qué mostrar sin otra llamada.
- Front: páginas `app/(protected)/lab/tesoreria/page.tsx` y `app/(protected)/lab/contabilidad/page.tsx` (en Fase 0 solo el esqueleto: título, pestañas vacías y el aviso "en construcción" del laboratorio), tarjetas en el índice `/lab`, `RUTAS_EN_CONSTRUCCION` ampliado. Cada página exige `VIEW_LAB` **y** el flag del holding **y** el `VIEW_` del módulo (`AccesoModulo` + flag leído en el `layout.tsx` del módulo, patrón de `modulos-en-construccion.md` › "Las capas", punto 4). Lo que un módulo del lab agregue a módulos publicados (pestaña "Cuentas" y "Períodos" de Compañía 360) llega apagado con el mismo flag.

## 7. Transversal de la Fase 0

- Rotar la API key de Odoo de producción expuesta en `src/modules/odoo/README.md` y borrarla del archivo (Leon). Prerequisito, no opcional.
- `yarn schema:status` en QA y prod para confirmar `1790750000000-Budgets` y `1790740000000-BankReconciliationV2`; si no están, aplicarlas primero (son prerequisito de Fase 1).
- Conteos en prod en solo lectura antes de la migración de cuentas y del índice de RUT: filas de `company_account_mappings`, compañías sin fila, duplicados de `(holding_id, upper(tax_id))` en `client_entities` **excluyendo** los RUT del catálogo `generic_export_vats` y 66.666.666-6, y cuántas razones sociales usan un genérico (candidatas a `foreign_tax_id`).
- CI mínima: workflow de GitHub Actions que corre `jest` en api-sapira y `vitest` + `tsc --noEmit` en front-sapira en cada PR (transversal ya acordado el 18-10; la Fase 0 es el momento porque suma 6 tablas y 3 módulos).
- Migraciones: una por pieza (`CreateGlChartAndAccounts`, `CreateGlPeriods`, `CreateDocumentEvents`, `ClientEntitiesCounterpartyRoles`, `HoldingErpModules`), aditivas, con RLS habilitada y policies como assets, aplicadas en QA y prod al mergear aunque el flag esté apagado.

## 8. Verificación (regla dura del repo)

| Punto | Fase 0 |
|---|---|
| Doc funcional | No aplica aún al centro de ayuda (nada visible para usuarias finales); se agrega una nota en `docs/documentacion-funcional/administracion/` solo cuando la pestaña Cuentas cambie para holdings con flag. |
| Doc técnica | Este documento + `estrategia-base-de-datos.md` actualizados con lo construido; `contrato-api-*` nuevo para `/accounting`, `/counterparties`, `/documents/:type/:id/events`; `spec-tablas-por-modulo.md` marca `document_events` como construida. |
| Reglas | `AGENTS.md` de ambos repos: módulo nuevo = permisos + `MODULOS_V2` + `PERMISOS_BFF` + flag `erp_modules`; `logica-en-api-triggers.md` registra los dos triggers de invariante nuevos (append-only de `document_events`; más adelante inmutabilidad de asientos). |
| Tests | Entities contra snapshot (`*.entities.spec.ts`); `accounting-periods.service.spec` (proyección del cutoff, soft_closed); `document-events.service.spec` (dedup, append-only, misma transacción); `counterparties` (CHECK de roles, filtro por defecto de Clientes intacto); `permissions-catalog.spec` y `rutas-modulos.test.ts`; `RequireErpModuleGuard` (404 con flag apagado). |

## 9. Decisiones tomadas por Domi el 19-10-2026

| # | Decisión | Resuelto |
|---|---|---|
| 1 | Plantilla de plan de cuentas Chile | **Plantilla propia de Sapira** (~120 cuentas, 3 niveles, etiquetas F29 y categoría de flujo), versionada como seed; no se parte del plan de un cliente |
| 2 | Estado `soft_closed` | **Sí, desde la Fase 0**: el modelo nace con `open` / `soft_closed` / `closed`; el efecto sobre asientos llega en Fase 2 |
| 3 | Rol por defecto "Contador" | **No**: solo Administrador y Finanzas reciben los 6 VIEW/EDIT y `POST_JOURNAL`; un rol Contador se crea a mano por holding cuando un piloto lo pida |
| 4 | `company_account_mappings` | **Vista de compatibilidad** al cerrar la Fase 0: conteo en prod, OK, respaldo en `sapira_backups.*`, migración a `gl_accounts` + `gl_account_roles`, vista con el mismo nombre y columnas |
| 5 | Unicidad de RUT | **Índice único parcial solo sobre RUT nacionales (`tax_id_kind = 'national'`) y solo si el conteo en prod da cero duplicados**; los genéricos de exportación (55.555.555-5) y consumidor final (66.666.666-6) quedan fuera, y los clientes extranjeros se identifican por `country_code` + `foreign_tax_id` con su propio índice único. Si hay duplicados nacionales, índice normal + aviso hasta limpiarlos. Precisión de Domi del 19-10 |

La spec queda **lista para construir** cuando Domi dé el OK de arranque de la Fase 0 (noviembre). Orden sugerido de las piezas: permisos y flag (§5, §6) → `document_events` (§3) → plan de cuentas (§1) → períodos (§2) → contrapartes (§4) → migración de cuentas y vista (§1, al final).
