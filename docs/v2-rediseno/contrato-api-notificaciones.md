# Contrato API · Notificaciones v2 (fase 1)

> 03-10-2026. Fuente: `spec-notificaciones-v2.md` (§5 y §6 mandan). Código: `src/modules/notifications/**` y
> `src/modules/tasks/**`. Todo endpoint va con `SupabaseAuthGuard` + `HoldingScopeGuard` (header `x-holding-id`).
> Las rutas que ya usa el front actual (`GET /notifications`, `GET /notifications/:id`, `PATCH /notifications/:id/read`,
> `GET/PUT /notifications/subscriptions/salesforce-staging-blocked`) siguen funcionando: sus respuestas son un **superconjunto** de las de hoy.

## 0. Reglas comunes

- **Holding**: solo se ve lo del holding del header y solo si el usuario es miembro activo (`user_holdings.is_active`).
  Sin header → `400 { message: 'Falta el holding activo (header x-holding-id)' }`; holding ajeno → `403 { message: 'No tienes acceso a este holding' }`.
- **Notificación ajena** (de otro usuario o de otro holding) → `404 { message: 'Notificación no encontrada' }`.
- **Validación** → `400 { message, errors: [{ field, message }] }` (pipe global), mensajes en español.
- **Fechas**: `created_at`/`updated_at`/`resolved_at`/`read_at`/`archived_at` ISO 8601. Filtros `from`/`to` = `YYYY-MM-DD` (fecha de creación, inclusivo).
- **Listas en query**: `type`, `module`, `severity` aceptan `a,b` o el parámetro repetido.
- **Gravedad**: `error` = "Bloquea", `warning` = "Atención", `info` = "Informativo".

## 1. Catálogo de tipos (`notification-catalog.ts`)

Módulos: `facturacion` (Facturación) · `contratos` (Contratos) · `cotizaciones` (Cotizaciones) · `ingresos` (Ingresos) ·
`integraciones` (Integraciones) · `sistema` (Sistema).

| Tipo | Etiqueta | Módulo | Ícono (lucide) | Gravedad | Suscribible | Destinatarios por defecto | Acción (`action_type` → botón) | Fase |
|---|---|---|---|---|---|---|---|---|
| `invoice_odoo_failure` | No se pudo enviar una factura al ERP | facturacion | `receipt-text` | error | sí | Administrador, Finanzas, Facturación y Cobranza | `open_contract` → Ver contrato | 1 |
| `salesforce_staging_blocked` | Cotización del CRM detenida | cotizaciones | `file-warning` | error | sí | Administrador, Ventas, Operaciones | `retry_salesforce_opportunity` → Reintentar importación | 1 |
| `salesforce_sync_failure` | Falló la sincronización con el CRM | integraciones | `refresh-cw-off` | error | sí | Administrador, Admin Técnico, super admins | `review_salesforce_sync_log` → Revisar sincronización | 1 |
| `contract_renewal_proposed` | Renovación por confirmar | contratos | `calendar-clock` | info | sí | Administrador, Finanzas | `review_renewal_proposal` → Revisar propuesta | 1 |
| `contract_renewal_reminder` | Vencimiento sin decisión | contratos | `calendar-x` | warning (escala a error) | sí | Administrador, Finanzas | `open_contract` → Ver contrato | 1 |
| `contract_scheduled_change_due` | Ajuste pactado por aplicar | contratos | `trending-up` | info | sí | Administrador, Finanzas | `review_scheduled_change` → Revisar ajuste | 1 |
| `bigquery_quantities_diff` | Consumo distinto en el almacén de datos | facturacion | `database` | warning | sí | Administrador, Finanzas, Facturación y Cobranza | `replace_quantity_record` → Reemplazar cantidades | 1 |
| `bigquery_quantities_unmapped` | Consumos sin producto asociado | facturacion | `database` | warning | sí | ídem | — | 1 |
| `bigquery_quantities_blocked` | Consumos que no entraron a la factura | facturacion | `database` | warning | sí | ídem | — | 1 |
| `bigquery_quantities_currency_mismatch` | Consumos en otra moneda | facturacion | `database` | warning | sí | ídem | — | 1 |
| `fx_sync_failure` | Falló la sincronización de tipos de cambio | integraciones | `circle-dollar-sign` | error | sí | Administrador, Admin Técnico, super admins | — | 2 (reservado) |
| `invoice_fx_fallback` | Factura emitida con tasa de respaldo | facturacion | `circle-dollar-sign` | warning | sí | super admins | — | 2 (reservado) |
| `invoice_fx_missing` | Factura no emitida por falta de tasa | facturacion | `circle-dollar-sign` | error | sí | super admins | — | 2 (reservado) |
| `scheduler_error_summary` | Resumen de errores de emisión | facturacion | `list-x` | error | sí | super admins | — | 2 (reservado) |
| `system_update` | Novedad del sistema | sistema | `sparkles` | info | no (todos los usuarios) | todos los miembros activos del holding (o de todos los holdings) | `open_help` `{ slug }` → Ver novedad (`/ayuda/<slug>`) | 1 (canal listo) |
| `user_mention` | Te mencionaron | sistema | `at-sign` | info | no (personal) | el usuario mencionado | `open_client` `{ client_id }` → Ver cliente | 2 (reservado) |

- **Administrador recibe todo** salvo los correos internos de Sapira (`invoice_fx_fallback`, `invoice_fx_missing`,
  `scheduler_error_summary`), que son solo de super admins (Domi y Leon), como hoy.
- **Super admins** = suscripción con `role_id NULL`; igual necesitan membresía activa en el holding.
- Cada entrada trae el texto "Qué pasó" / "Qué hacer" (+ "Qué hacemos nosotros") por defecto; el detalle usa el
  `message` y la `recommendation` del productor cuando existen y cae a la plantilla si no.
- Los reservados (fase 2) ya están en el catálogo, la semilla y las preferencias, pero **no** se ofrecen todavía en
  Configuración › Roles (no hay productor).

## 2. Recursos

### `NotificationView` (lista y detalle)

```jsonc
{
  "id": "uuid", "holding_id": "uuid", "type": "invoice_odoo_failure", "source": "invoices",
  "label": "No se pudo enviar una factura al ERP", "module": "facturacion", "module_label": "Facturación", "icon": "receipt-text",
  "severity": "error", "severity_label": "Bloquea", "status": "open", // open | resolved
  "title": "No se pudo enviar la factura 1234 de Acme", "message": "…", "recommendation": "…",
  "action_type": "open_contract", "action_payload": { "contract_id": "uuid" },
  "action": { "type": "open_contract", "label": "Ver contrato", "payload": { "contract_id": "uuid" } }, // null sin acción
  "resource_type": "invoice", "resource_id": "uuid", "metadata": {}, "deduplication_key": "…",
  "created_at": "…", "updated_at": "…", "resolved_at": null,
  "is_read": false, "read_at": null, "is_archived": false, "archived_at": null
}
```

Detalle (`GET /notifications/:id`) agrega `texts: { what_happened, what_to_do, what_we_do | null }`.

### `Task`

```jsonc
{
  "key": "invoices_blocked", "module": "facturacion", "module_label": "Facturación",
  "title": "Facturas por emitir bloqueadas", "count": 12, "amount": 45210.5, "currency": "USD", // amount null si no aplica
  "severity": "error", // error | warning | info
  "href": "/lab/facturacion?estado=Por+Emitir&grupo=blocked&periodo=todo",
  "breakdown": [{ "key": "fx_rate_missing", "label": "Falta el tipo de cambio", "count": 7, "href": "/lab/facturacion?…&motivo=fx_rate_missing" }] // opcional
}
```

## 3. Endpoints

| Método y ruta | Body / query | Respuesta | Errores |
|---|---|---|---|
| `GET /notifications` | `status` (open\|resolved) · `read` (true\|false) · `archived` (false por defecto; true = solo archivadas) · `type[]` · `module[]` · `severity[]` · `from` · `to` · `search` (título y mensaje, ≤ 120) · `page` (1) · `limit` (20, ≤ 100) | `{ data: NotificationView[], total, items, currentPage, pages, limit, unread_count, pagination: { page, limit, total, total_pages } }` (orden: más nueva primero; `pagination` = forma vieja) | 400 filtro inválido |
| `GET /notifications/counts` | — | `{ unread, by_module: [{ module, label, unread }], by_type: [{ type, label, unread }] }` (sin archivadas) | — |
| `GET /notifications/catalog` | — | `{ modules: [{ key, label }], types: [{ type, label, module, icon, severity, subscribable, reserved, action_label }] }` | — |
| `GET /notifications/tasks` | `as_of?` (YYYY-MM-DD; por defecto hoy del holding) | `{ holding_id, as_of, currency, tasks: Task[] }` — solo tareas con conteo > 0, ordenadas por gravedad | 400 fecha inválida |
| `GET /notifications/preferences` | — | `{ weekly_digest: boolean, types: [{ type, label, module, in_app, email }] }` (tipos configurables: todos menos `system_update`; defaults `in_app: true`, `email: false`, `weekly_digest: false`) | — |
| `PUT /notifications/preferences` | `{ weekly_digest?: boolean, types?: [{ type, in_app?: boolean, email?: boolean }] }` (≤ 50) | igual a GET | 400 `Tipo de aviso no válido: …` |
| `GET /notifications/:id` | — | `NotificationView & { texts }` | 404 |
| `PATCH /notifications/:id/read` | — | `NotificationView` | 404 |
| `PATCH /notifications/:id/unread` | — | `NotificationView` | 404 |
| `POST /notifications/read-all` | mismos filtros de la lista en el body (sin `page`/`limit`; `read` se ignora) | `{ updated: number }` | 400 |
| `POST /notifications/archive` | `{ ids: uuid[] }` (1–200) | `{ updated: number }` (solo las propias del holding; las ajenas se ignoran) | 400 |
| `POST /notifications/unarchive` | `{ ids: uuid[] }` (1–200) | `{ updated: number }` | 400 |
| `GET /settings/roles/:id/alerts` | — | `{ role_id, alerts: [{ type, label, module, module_label, icon, enabled }] }` — todos los tipos suscribibles no reservados | 404 rol ajeno |
| `PUT /settings/roles/:id/alerts` | `{ types: string[] }` | igual a GET | 400 `Tipo de alerta no válido: …` · 404 |

Rutas viejas que siguen: `GET/PUT /notifications/subscriptions/salesforce-staging-blocked` (solo los 3 tipos de
siempre; no tocan las suscripciones nuevas).

**Archivar** es por usuario (no cambia la alerta para los demás). Una alerta archivada que **escala** vuelve a la bandeja
sin leer. **Resolver** no es manual: las alertas se cierran solas (§5).

## 4. Tareas (`GET /notifications/tasks`; misma función que `GET /dashboard/home`)

| `key` | Módulo | Título | Monto | Gravedad | Enlace |
|---|---|---|---|---|---|
| `invoices_to_issue_today` | facturacion | Facturas por emitir hoy | sí | info | `/lab/facturacion?estado=Por+Emitir&grupo=ready` |
| `invoices_blocked` | facturacion | Facturas por emitir bloqueadas (+ `breakdown` por motivo) | sí | error | `/lab/facturacion?estado=Por+Emitir&grupo=blocked&periodo=todo` (+ `&motivo=<código>`) |
| `invoices_late` | facturacion | Facturas por emitir atrasadas | sí | warning | `/lab/facturacion?estado=Por+Emitir&grupo=late&periodo=todo` |
| `invoices_past_months` | facturacion | Por emitir de meses pasados | sí | warning | `/lab/facturacion?estado=Por+Emitir&desde=<mes más antiguo>&hasta=<mes anterior>` |
| `invoices_overdue` | facturacion | Facturas vencidas | sí (saldo) | warning | `/lab/facturacion?pago=overdue&periodo=todo` |
| `credit_notes_to_issue` | facturacion | Notas de crédito por emitir | no | warning | `/lab/facturacion?tab=notas-credito&dte=pending_emission&periodo=todo` |
| `renewals_to_decide` | contratos | Renovaciones por confirmar | no | warning | `/lab/contratos?f=estado:pending_renewal` (1 contrato → su 360) |
| `expirations_without_decision` | contratos | Vencidos sin decisión | no | error | `/lab/contratos?f=estado:expired` (1 contrato → su 360) |
| `scheduled_changes_due` | contratos | Ajustes pactados por aplicar | no | warning | `/lab/contratos` (1 contrato → su 360) |
| `consumptions_to_report` | contratos | Consumos por informar | no | warning | `/lab/contratos` (1 contrato → `/lab/contratos/<id>?tab=consumos`) |
| `contracts_without_invoices` | contratos | Contratos activos sin facturas programadas | no | warning | `/lab/contratos?f=estado:active` (1 contrato → su 360) |
| `service_starts_this_month` | contratos | Inicios de servicio del mes | no | info | `/lab/contratos?f=inicio_desde:<1.º del mes>;inicio_hasta:<fin de mes>` |
| `quotes_waiting_mapping` | cotizaciones | Cotizaciones del CRM en espera de mapeo | no | warning | `/lab/cotizaciones` (el aviso "Revisar" abre el panel) |
| `quotes_unprocessed_this_month` | cotizaciones | Cotizaciones firmadas del mes sin contrato | sí (por moneda: null si hay varias) | warning | `/lab/cotizaciones?f=booking_desde:<1.º>;booking_hasta:<fin>;con_contrato:no;estado:signed` |
| `revenue_exceptions` | ingresos | Excepciones de Ingresos | no | warning | `/lab/revenue?tab=excepciones` |

Montos en moneda del sistema del holding (`currency`). Fuentes: cola Por emitir de Facturación (`BillingReadService.queue`,
mismos motivos que la pantalla), `invoicesCte` (vencidas y NC), consumos por informar (`ConsumptionService.pending`),
excepciones (`RevenueMetricsService.exceptions`) y SQL agregadas para el resto.

## 5. Cierre automático, escalamiento y destinatarios

- **Cierres**: `invoice_odoo_failure` al enviar bien la factura (todas las etapas de esa factura); `salesforce_sync_failure`
  con la siguiente corrida buena del holding; `contract_renewal_proposed` al confirmar u omitir la propuesta;
  `contract_renewal_reminder` cuando ya no queda ningún ítem sin decisión con ese fin (renovar, dar de baja o terminar);
  `contract_scheduled_change_due` al aplicar, omitir o cancelar el pacto (o si su próxima fecha ya avanzó).
- **`createOrUpdate`**: con la misma `deduplication_key` abierta actualiza título, mensaje, recomendación, acción y
  metadata; **suma destinatarios nuevos** (p. ej. un rol suscrito después); si **sube la gravedad** o cambia el
  **escalón** (`escalation_step`, p. ej. días al vencimiento) vuelve a "sin leer" y desarchiva para todos.
- **`create` sin destinatarios no inserta**: deja un log (`warn`) y devuelve `{ notification: null, recipient_count: 0 }`.
  Una alerta que nadie ve no sirve y bloquearía la deduplicación; la próxima corrida la vuelve a intentar.
- **Preferencias**: un usuario con `in_app: false` para un tipo no queda como destinatario de las nuevas (las viejas
  siguen visibles). `email` y `weekly_digest` se guardan desde ya; los envíos son fase 2.
- **Socket** (`/notifications`): rechaza la conexión si el usuario no tiene ninguna membresía activa; antes de emitir
  `notification:updated`/`created` descarta a quien ya no es miembro activo del holding de la notificación.

## 6. Base de datos (escrito, sin aplicar)

| # | Cambio | Archivo |
|---|---|---|
| N1 | `app_notification_recipients.archived_at timestamptz NULL` + índice `(user_id, archived_at)` | `migrations/1790880000000-NotificationRecipientsArchivedAt.ts` |
| N2 | `user_notification_preferences` (id, user_id, holding_id, notification_type, in_app bool default true, email bool default false, timestamps; UNIQUE (user_id, holding_id, notification_type); RLS activada sin políticas). El resumen semanal es la fila reservada `notification_type = 'weekly_digest'` (usa `email`) | `migrations/1790890000000-UserNotificationPreferences.ts` |
| N3 | Semilla de suscripciones por defecto por rol (roles `is_default` por nombre + `role_id NULL` para super admins); idempotente | `seed/007-notification-default-subscriptions.sql` |
| — | `create_default_roles_for_holding` crea las mismas suscripciones para holdings nuevos (**pendiente OK de Domi**) | `functions/create_default_roles_for_holding.sql` |

Orden: N1 → N2 → N3 → función → desplegar la API.

## 7. Cambios en otros módulos (autorizados)

- **Dashboard** (`GET /dashboard/home`): las tareas salen de `TasksService` (misma función que el centro). Las claves de siempre se
  mantienen (`overdue_invoices`, `expired_contracts`, `contracts_to_renew_30/90`, `invoices_to_emit`, `items_starting_this_month`) y se
  suma `tasks.items: Task[]` (las con conteo). `overdue_invoices` pasa a la regla de Facturación (`is_overdue`: emitida, no pagada, con
  saldo y vencimiento anterior a hoy); antes contaba cualquier factura activa no pagada con vencimiento pasado (incluía Por Emitir y
  Canceladas).
  - **`user_holdings.selected`**: verificado: `GET /dashboard/home` ya usa el holding del header (`HoldingScopeGuard`, v0.0.31) y la BFF
    lo reenvía; no queda lectura de `selected` en el Dashboard. Sin cambio.
  - **Doble conteo de `mrr_legacy`** (verificado con SELECT en producción, SimpliRoute): el MRR del mes sumaba el legacy de filas ya
    migradas a un contrato que tiene devengo ese mes: +2.860 USD en oct-2026, +368 USD en sep-2026, +16.269 USD en ago-2026. Se aplica el
    **corte U14** (misma regla que Métricas v2): el legacy migrado deja de contar desde el primer mes con MRR de su contrato y solo cuenta
    el recurrente. `HoldingMetricsService.monthMetrics(…, { legacyCut: true })` solo en el Dashboard; **Clientes y Contratos siguen sin el
    corte hasta el OK de Domi** (módulos cerrados): con el OK, el default pasa a `true` y se corrigen las tres vistas.
- **Facturación / Ingresos / Contratos**: solo exportan `BillingReadService`, `RevenueMetricsService` y `ConsumptionService` para Tareas.
- **Configuración › Roles**: `GET/PUT /settings/roles/:id/alerts` ofrece el catálogo (10 tipos con productor, con `label`, `module`,
  `module_label`, `icon`).
- **Textos de los productores** en español de negocio, sin marcas: CRM detenido (mensaje por motivo; el detalle técnico queda en
  `metadata.error_message`), falla de sincronización, consumos del almacén de datos, vencimiento (con el efecto en el devengo) y pactos
  (tipo de pacto legible). Los mensajes del ERP siguen saliendo de `translateErpError` (Leon).
