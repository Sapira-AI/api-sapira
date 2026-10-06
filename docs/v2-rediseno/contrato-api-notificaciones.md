# Contrato API · Notificaciones v2 (fases 1 y 2)

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
| `fx_sync_failure` | Falló la sincronización de tipos de cambio | integraciones | `circle-dollar-sign` | error | sí | Administrador, Admin Técnico, super admins | `review_fx_rates` → Revisar tipos de cambio | 2 |
| `invoice_fx_fallback` | Factura emitida con tasa de respaldo | facturacion | `circle-dollar-sign` | warning | sí (interno) | super admins | `open_invoice` → Ver factura | 2 |
| `invoice_fx_missing` | Factura no emitida por falta de tasa | facturacion | `circle-dollar-sign` | error | sí (interno) | super admins | `open_invoice` → Ver factura | 2 |
| `scheduler_error_summary` | Resumen de errores de emisión | facturacion | `list-x` | error | sí (interno) | super admins | `open_billing_queue` → Ver facturas por emitir | 2 |
| `month_close_pending` | Facturas del mes sin emitir | facturacion | `calendar-check` | warning | sí | Administrador, Finanzas, Facturación y Cobranza | `open_billing_queue` → Ver facturas por emitir (+ secundaria `move_to_next_month`) | 2 |
| `system_update` | Novedad del sistema | sistema | `sparkles` | info | no (todos los usuarios) | todos los miembros activos del holding (o de todos los holdings) | `open_help` `{ slug }` → Ver novedad (`/ayuda/<slug>`) | 1 (canal listo) |
| `user_mention` | Te mencionaron | sistema | `at-sign` | info | no (personal) | el usuario mencionado | `open_client_activity` `{ client_id, note_id }` → Ver comentario | 2 |

- **Administrador recibe todo** salvo los correos internos de Sapira (`invoice_fx_fallback`, `invoice_fx_missing`,
  `scheduler_error_summary`), que son solo de super admins (Domi y Leon), como hoy.
- **Super admins** = suscripción con `role_id NULL`; igual necesitan membresía activa en el holding.
- Cada entrada trae el texto "Qué pasó" / "Qué hacer" (+ "Qué hacemos nosotros") por defecto; el detalle usa el
  `message` y la `recommendation` del productor cuando existen y cae a la plantilla si no.
- Fase 2 (03-10): ya no quedan reservados. Configuración › Roles ofrece los suscribibles **menos los internos** (`invoice_fx_*`,
  `scheduler_error_summary`: solo super admins); las preferencias del usuario solo muestran los internos a un super admin.
  `open_invoice` `{ invoice_id }` abre `/lab/facturacion?invoice=<id>`.

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
  "is_read": false, "read_at": null, "is_archived": false, "archived_at": null,
  "actor": { "id": "uuid", "name": "Domi", "avatar": { "kind": "preset", "preset_id": "preset-04" } } // null si no hay actor
}
```

Detalle (`GET /notifications/:id`) agrega `texts: { what_happened, what_to_do, what_we_do | null }`.

`actor` (03-10, lista y detalle): quien provocó la alerta, con nombre (`name`, o el correo si no tiene) y `avatar` (forma de Mi perfil §3:
`initials` | `preset` | `upload`). Sale de `metadata.actor_user_id`; las `user_mention` creadas antes guardaron al autor en
`metadata.author_id` y también se resuelven. Una sola consulta de usuarios por página. `null` si la alerta no tiene actor o la persona ya no
existe.

### `Task`

```jsonc
{
  "key": "invoices_blocked", "module": "facturacion", "module_label": "Facturación",
  "title": "Facturas por emitir bloqueadas", "count": 12, "amount": 45210.5, "currency": "USD", // amount null si no aplica
  "severity": "error", // error | warning | info
  "href": "/lab/facturacion?estado=Por+Emitir&grupo=blocked&desde=2026-08&hasta=2026-10",
  "breakdown": [{ "key": "fx_rate_missing", "label": "Falta el tipo de cambio", "count": 7, "href": "/lab/facturacion?…&desde=2026-09&hasta=2026-10&motivo=fx_rate_missing" }] // opcional
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
| `invoices_blocked` | facturacion | Facturas por emitir bloqueadas (+ `breakdown` por motivo; **sin** `no_contract`) | sí | error | `/lab/facturacion?estado=Por+Emitir&grupo=blocked&desde=<primer mes>&hasta=<mes en curso>` (+ `&motivo=<código>`, con el primer mes de ese motivo) |
| `invoices_late` | facturacion | Facturas por emitir atrasadas (+ `breakdown` por antigüedad con `amount` y `hint`: `this_month` Este mes, `previous_month` Mes anterior, `older` Más antiguas; + `hint` de la tarea) | sí | warning | `/facturacion?estado=Por+Emitir&grupo=late&desde=<primer mes>&hasta=<mes en curso>` (cada tramo, su rango de meses) |
| `invoices_overdue` | facturacion | Facturas vencidas | sí (saldo) | warning | `/lab/facturacion?pago=overdue&periodo=todo` |
| `credit_notes_to_issue` | facturacion | Notas de crédito por emitir | no | warning | `/lab/facturacion?tab=notas-credito&dte=pending_emission&periodo=todo` |
| `renewals_to_decide` | contratos | Renovaciones por confirmar | no | warning | `/lab/contratos?f=estado:pending_renewal` (1 contrato → su 360) |
| `expirations_without_decision` | contratos | Vencidos sin decisión | no | error | `/lab/contratos?f=estado:expired` (1 contrato → su 360) |
| `scheduled_changes_due` | contratos | Ajustes pactados por aplicar | no | warning | `/lab/contratos` (1 contrato → su 360) |
| `consumptions_to_report` | contratos | Consumos por informar | no | warning | `/lab/contratos` (1 contrato → `/lab/contratos/<id>?tab=consumos`) |
| `contracts_without_invoices` | contratos | Contratos activos sin facturas programadas: algún ítem recurrente vigente (sin CHURN/DOWNSELL) sin línea que lo cubra — ni Por Emitir (de cualquier fecha; las atrasadas van en `invoices_late`) ni factura vigente cuyo período llegue a hoy (anual, semestral o trimestral ya cobrada) — (05-10) | no | warning | `/contratos?f=estado:active` (1 contrato → su 360) |
| `service_starts_this_month` | contratos | Inicios de servicio del mes | no | info | `/lab/contratos?f=inicio_desde:<1.º del mes>;inicio_hasta:<fin de mes>` |
| `quotes_waiting_mapping` | cotizaciones | Cotizaciones del CRM en espera de mapeo | no | warning | `/lab/cotizaciones` (el aviso "Revisar" abre el panel) |
| `quotes_unprocessed_this_month` | cotizaciones | Cotizaciones firmadas del mes sin contrato | sí (por moneda: null si hay varias) | warning | `/lab/cotizaciones?f=booking_desde:<1.º>;booking_hasta:<fin>;con_contrato:no;estado:signed` |
| `revenue_exceptions` | ingresos | Excepciones de Ingresos | no | warning | `/lab/revenue?tab=excepciones` |

**Atrasadas (05-10)**: una sola tarea para las Por Emitir **no bloqueadas** cuya fecha ya pasó (grupo `late` de la cola o fecha de un
mes pasado); una bloqueada cuenta solo en `invoices_blocked`, así el resumen por gravedad no suma dos veces la misma factura. `hint`
(tooltip) dice cómo cerrarlas: emitir, reprogramar o, si el cliente se fue o redujo, registrarlo en el contrato (Modificar contrato).

Montos en moneda del sistema del holding (`currency`). Fuentes: cola Por emitir de Facturación (`BillingReadService.queue`,
mismos motivos que la pantalla), `invoicesCte` (vencidas y NC), consumos por informar (`ConsumptionService.pending`),
excepciones (`RevenueMetricsService.exceptions`) y SQL agregadas para el resto.

**Cola Por emitir (03-10):** las tareas cuentan la cola **hasta hoy** (`until: today`), así que sus enlaces abren
`desde=<primer mes YYYY-MM de las facturas de esa tarea>&hasta=<mes en curso>` (para el desglose, el primer mes de ese motivo) en vez de
`periodo=todo`, que mostraba también las futuras; sin fecha conocida, `periodo=todo`. Fecha de la factura: `COALESCE(issue_date, scheduled_at)`.
**`no_contract` no es tarea:** las facturas sin contrato (solo lectura: restos del modelo viejo de suscripciones) son **datos a sanear antes
del switch**, no una tarea del usuario. La tarea `invoices_blocked` excluye ese motivo del conteo, el monto y el desglose; una factura cuyo
único motivo es `no_contract` no cuenta como bloqueada (con otro motivo, cuenta por ese otro). La cola de Facturación y el conteo
`invoices_to_emit` del Dashboard no cambian.

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

## 8. Fase 2 (cierre) · contrato

> 03-10-2026. Todo con `SupabaseAuthGuard` + `HoldingScopeGuard` salvo donde se indica. Migraciones escritas **sin aplicar** (§8.9).

### 8.1 Mis compañías (filtro por compañía)

- `app_notifications.company_id uuid NULL` (FK `companies`, ON DELETE SET NULL). Lo pone el productor (`CreateAppNotificationDto.company_id`) y,
  si no lo trae, `NotificationsService` lo deriva del recurso: `resource_type = 'invoice'` → `invoices.company_id`; `'contract'` →
  `contracts.company_id`; `metadata.contract_item_id` (consumos del almacén de datos) → compañía del contrato. CRM, sincronizaciones,
  novedades y menciones quedan sin compañía (las ve todo destinatario).
- Preferencia por usuario y holding: fila reservada `user_notification_preferences.notification_type = 'my_companies'` con la columna nueva
  `company_ids uuid[]` (vacío o sin fila = **todas**). Mismo patrón que `weekly_digest`.
- **Regla de visibilidad**: lista, conteos, marcar todas, detalle, campana, socket y correo muestran a cada usuario solo
  `company_id IS NULL OR company_id = ANY(mis compañías)` (si su lista no está vacía). El destinatario igual queda guardado: si amplía sus
  compañías, ve las alertas que ya tenía.
- `GET /notifications/preferences` agrega `company_ids: uuid[]` y `companies: [{ id, name, country }]` (las del holding, para el selector).
  `PUT /notifications/preferences` acepta `company_ids?: uuid[]` (≤ 100; `[]` = todas) → 400 `Compañía no válida: …` si alguna no es del holding.
- `GET /notifications/tasks` acepta `company_ids` (`a,b` o repetido) y `all=true`. Sin `company_ids` usa los de la preferencia del usuario;
  `all=true` ignora la preferencia. Respuesta: igual + `company_ids: uuid[]` (los aplicados; `[]` = todas). Las tareas sin compañía
  (cotizaciones del CRM, excepciones de Ingresos) no se filtran.

### 8.2 Preferencias: correo y resumen semanal (defaults)

- `types[].email` por defecto (sin fila): **true** si el tipo es de gravedad `error` en el catálogo y el usuario es **Administrador**, o si el
  usuario es **super admin** y el tipo va a super admins por defecto (correos internos: `fx_sync_failure`, `invoice_fx_fallback`,
  `invoice_fx_missing`, `scheduler_error_summary`, `salesforce_sync_failure`); **false** en el resto.
- `weekly_digest` por defecto: **true** para Administrador y Finanzas; false para los demás.
- `GET` agrega `defaults: { weekly_digest, types: [{ type, in_app, email }] }` para que el front pueda mostrar "por defecto".

### 8.3 Correo inmediato (alerta)

- Al **crear** una alerta (a los destinatarios nuevos) o al **escalarla** (sube la gravedad o cambia el escalón: a todos), se **reserva** un
  correo (Resend, `AuthMailer`, plantilla de marca "alerta") solo para quien tiene `email = true` para el tipo (efectivo: preferencia o
  default), ve la compañía de la alerta y sigue activo. Asunto `[<Bloquea|Atención|Informativo>] <título>`; cuerpo: gravedad, **Qué pasó**,
  **Qué hacer** (+ Qué hacemos nosotros), compañía si la hay, botón **Ver alerta** → `${INVITE_LANDING_URL}/lab/notificaciones?alerta=<id>`.
  Todo texto variable va escapado.
- **Ventana de espera** (`NOTIFICATION_EMAIL_DELAY_MINUTES`, default **15** minutos; 03-10): la reserva es una fila `pending` en
  `notification_email_log` (sin enviar). Un job **cada 15 minutos** (`NotificationJobsScheduler.alertEmails` → `NotificationEmailService.sendDueAlerts`)
  envía las filas `pending` de kind `alert` con `created_at <= now() - ventana` cuya alerta siga `open`. Si la alerta se resolvió (o se borró)
  dentro de la ventana, la fila queda `failed` con `error = 'resuelta antes de enviar'` y no sale nada (sin estado nuevo: el CHECK de la
  tabla no cambia, **sin migración**). Usuario inactivo o sin correo al momento de enviar: `failed`, `error = 'usuario inactivo o sin correo'`.
- **Escalamiento dentro de la ventana:** se reserva la nueva clave con el `created_at` de la reserva pendiente, y esta queda `failed` con
  `error = 'reemplazada por escalamiento'`: sale **un solo correo**, a la hora original, con el asunto de escalamiento
  (`[<gravedad>] Sigue pendiente: <título>`). El asunto de escalamiento se usa cuando el usuario ya tenía otra fila de la misma alerta.
- **Varias réplicas:** antes de enviar, cada fila se toma con `UPDATE … SET sent_at = now() WHERE status = 'pending' AND sent_at IS NULL`
  (`pending` + `sent_at` = en envío); al terminar queda `sent` (con `sent_at`) o `failed` (sin `sent_at`). Una fila tomada que no termina
  (caída a mitad de envío) no se reintenta: se prefiere perder un correo a duplicarlo.
- **Deduplicación** (`notification_email_log`, UNIQUE `(user_id, dedup_key)`): clave `alert:<id>:<gravedad>:<escalón>`; no se reenvía por la
  misma alerta salvo escalamiento. Alertas "globales" (falla de tipos de cambio en todos los holdings) usan `metadata.email_group` como clave
  (`alert-group:<grupo>`): un solo correo por usuario aunque llegue a varios holdings.
- Llave general `NOTIFICATION_EMAILS_ENABLED` (default **activo**; `false` apaga todos los correos de este módulo: ni reserva ni envía; las
  filas ya reservadas esperan). El job de 15 minutos **no** depende de `NOTIFICATION_JOBS_ENABLED`. Si existe `INVITE_TEST_ALLOWLIST` (QA),
  solo salen a correos de la lista. Un fallo de correo nunca rompe al productor.

### 8.4 Resumen semanal

- Cron cada hora (UTC): por holding, si en su zona (`holding_settings.timezone`) es **lunes 08:xx**, envía el resumen a los usuarios activos
  con `weekly_digest` efectivo true. Idempotente por semana: `notification_email_log` con clave `digest:<holding>:<lunes YYYY-MM-DD>`
  (se reserva la fila antes de enviar: dos réplicas no duplican).
- Contenido (plantilla de marca compacta), respetando Mis compañías del usuario: tareas abiertas por módulo (conteo + enlace),
  alertas abiertas creadas en los últimos 7 días (hasta 8, más el total), MRR del mes vs el anterior (`MrrMetricsService.overview`) con los
  3 mayores aumentos y las 3 mayores pérdidas por cliente (`MrrMetricsService.movementDetail`, `groupBy=client`) y renovaciones ejecutadas en
  los 7 días (eventos `RENEWAL` completados). Secciones vacías se omiten.
- **Por compañía** (03-10): si el usuario ve más de una compañía (Mis compañías vacío = todas las del holding, o varias elegidas), una
  sección compacta con, por compañía: **tareas abiertas** (suma de conteos de `TasksService.pending(holding, hoy, [compañía])`, sin las
  tareas que no distinguen compañía: `quotes_waiting_mapping`, `quotes_unprocessed_this_month`, `revenue_exceptions`), **alertas abiertas
  de la semana** del usuario (`app_notifications.company_id`; las de todo el holding no se atribuyen) y el **MRR del mes**
  (`MrrMetricsService.byDimension`, `dimension=company`: la misma fuente del MRR del correo, sin recalcular; si falla, se omite). Solo
  compañías con datos; con menos de dos, la sección no aparece. Las tareas se calculan una compañía a la vez.
- `POST /notifications/digest/preview` (**solo super admin**, `@SuperAdminOnlyRoute`): `{ html, subject, text }` del resumen del holding
  activo para el usuario que llama (no envía nada ni registra). Incluye "Por compañía" con la misma regla.

### 8.5 Correos internos al catálogo

| Origen | Tipo | Holding / compañía | Dedup | Cierre |
|---|---|---|---|---|
| Factura emitida con tasa de respaldo | `invoice_fx_fallback` | de la factura | `invoice-fx-fallback:<factura>:<par>` | — (informativa; se archiva) |
| Factura no emitida por falta de tasa | `invoice_fx_missing` | de la factura | `invoice-fx-missing:<factura>:<par>` | al enviarse bien la factura |
| Resumen de errores del scheduler | `scheduler_error_summary` | del job | `scheduler-errors:<holding>:<día>` | con la siguiente corrida real sin errores |
| Falla de sincronización de tipos de cambio | `fx_sync_failure` | **todos los holdings** (sin compañía) | `fx-sync-failure` (+ `email_group` por día) | con la siguiente sincronización buena |

- Destinatarios: suscripciones del catálogo (super admins; `fx_sync_failure` también Administrador y Admin Técnico). Correo por el canal
  nuevo (§8.3). **Respaldo**: si una alerta no tiene destinatarios (semilla sin aplicar), el mismo correo de marca va a
  `INVOICE_ADMIN_EMAILS` / `BANCO_CENTRAL_ADMIN_EMAILS` (variables viejas, solo respaldo).
- El **reporte diario de sincronización exitosa** deja de enviarse por correo (se ve en Configuración › Monedas);
  `BANCO_CENTRAL_SEND_SUCCESS_REPORT` queda sin efecto.
- `POST /banco-central/exchange-rates/test-notification-error` y `…-success` pasan a **solo super admin** (#19). `-error` envía el correo de
  marca de prueba a quien llama (no crea alertas); `-success` responde que el reporte ya no se envía por correo.

### 8.6 Cierre de mes (`month_close_pending`)

- Catálogo nuevo: "Facturas del mes sin emitir", módulo Facturación, ícono `calendar-check`, gravedad `warning`, suscribible; por defecto
  Administrador, Finanzas, Facturación y Cobranza. Acción `open_billing_queue` → "Ver facturas por emitir".
- Ventana: **último día hábil del mes M** (lunes a viernes, sin feriados) y **3 primeros días hábiles de M+1**; el mes a cerrar es M.
- **Tarea**: desde el 05-10 no hay tarea aparte; el mes a cerrar es el tramo "Mes anterior" de `invoices_late` (Domi: las tareas
  `invoices_late`, `invoices_past_months` y `month_close_pending` contaban las mismas facturas y el resumen sumaba tres veces).
- **Alerta** (cron horario, a las 07:xx de la zona del holding, en la ventana): una por compañía con facturas pendientes
  (dedup `month-close:<M>:<compañía>`, escalón = día de la ventana → vuelve a "sin leer" cada día); se resuelve sola cuando la compañía
  queda en 0 o al salir de la ventana. `action_payload`: `{ month, company_id, href, invoice_ids (≤ 200), secondary: { type:
  'move_to_next_month', label: 'Mover al mes siguiente', method: 'POST', endpoint: '/billing/to-issue/reschedule', preview_endpoint:
  '/billing/to-issue/reschedule/preview', body: { invoice_ids, shift_months: 1 } } }` (endpoint masivo existente de Facturación; si hay más
  de 200, el front recarga la cola filtrada).

### 8.7 Menciones y referencias en la Actividad del Cliente 360

- **Tokens en el texto** (`body`): mención `@[user:<uuid>]`; referencia `#[<tipo>:<uuid>]` con tipo `contract`, `invoice`, `credit_note`,
  `quote`, `client_entity` (razón social) o `document`. La API deriva de los tokens las columnas nuevas
  `client_activity_notes.mentioned_user_ids uuid[]` y `references jsonb` (`[{ type, id }]`).
- `POST /clients/:id/activity/notes` (mismo body `{ body }`): valida cada mención (miembro activo del holding) → 400
  `{ message, errors: [{ field: 'body', message: 'La persona mencionada no es parte de este holding' }] }`, y cada referencia (pertenece a ESE
  cliente y holding) → 400 `… 'La referencia no pertenece a este cliente: <tipo>'`. Máx. 20 menciones y 20 referencias. Respuesta:
  `{ id, created_at, mentioned_user_ids, references }`.
- `GET /clients/:id/references?search=&type=&limit=` (`type` uno de los 6; `limit` ≤ 50, default 20): `{ data: [{ type, id, label, sublabel,
  href }] }`. Etiquetas: "Factura FAC-123 · USD 1.200 · Pagada", "Nota de crédito NC-12 · …", "Contrato CTR-2026-226", "Cotización
  COT-2026-0012", "Razón social Acme SpA", "Documento contrato.pdf". `href` al front nuevo (`/lab/...`).
- `GET /notifications/mentionable-users?search=&limit=` (≤ 50): miembros activos del holding `{ data: [{ id, name, email, avatar }] }`
  (`avatar` con la forma de Mi perfil §3).
- `GET /clients/:id/activity`: cada nota trae `body` (texto con tokens, para editar o pintar enlaces), `detail` **legible** (`@Nombre`,
  `#Etiqueta`), `author_avatar` (avatar del autor; `initials` si no tiene o la nota no tiene autor), `mentions: [{ id, name, avatar,
  exists }]` y `references: [{ type, id, label, sublabel, href, exists }]` (etiqueta actual;
  `exists: false` y "<Tipo> ya no disponible" si se borró o ya no es del cliente).
- **Textos de la Actividad en español de negocio** (corrección autorizada 03-10, `src/modules/clients/activity-labels.ts`, diccionario único):
  los cambios del contrato dicen campo y antes → después ("Estado: Borrador → Activo · Valor total: USD 100 → USD 120 · Fecha de término:
  31-12-2026 → 31-01-2027"; referencias y textos largos: "actualizado"; campos sin traducción: "N datos más actualizados"); eventos sin
  título usan su nombre en español; medios de pago y canales de cobranza traducidos; textos guardados con términos en inglés o decimales de
  más se limpian ("NC cancellation" → "NC de anulación", "9999.9999999999999996" → "10.000"); NC y ND emitidas se titulan como tales.
- Al guardar: alerta `user_mention` a los mencionados (sin el autor), título "{Autor} te mencionó en {Cliente}", mensaje = fragmento de la nota
  (tokens convertidos a texto: `@Nombre`, `#Etiqueta`; ≤ 280 caracteres), acción `open_client_activity { client_id, note_id }`
  ("Ver comentario"), dedup `client-note-mention:<nota>`, sin compañía. `metadata: { client_id, note_id, author_id, actor_user_id }`
  (`actor_user_id` = autor, 03-10): la bandeja lo devuelve como `actor` con nombre y avatar (§2).

### 8.8 Novedades del sistema

- `POST /notifications/system-updates` (**solo super admin**): `{ slug (a-z0-9-, ≤ 80), title (≤ 120), summary (≤ 500) }` → alerta
  `system_update` (acción `open_help { slug }`) para todos los usuarios activos de **todos** los holdings. Idempotente por `slug`
  (dedup `system-update:<slug>`: repetir actualiza el texto y suma usuarios nuevos, no duplica). Respuesta `{ slug, holdings, recipients }`.
- El banner de versión del front no toca la API.

### 8.9 Base de datos (escrito, sin aplicar)

| # | Cambio | Archivo |
|---|---|---|
| N4 | `app_notifications.company_id uuid NULL` + FK `companies` ON DELETE SET NULL + índice `(holding_id, company_id)` | `migrations/1790900000000-NotificationsPhase2.ts` |
| N5 | `user_notification_preferences.company_ids uuid[] NULL` (fila `my_companies`) | ídem |
| N6 | `notification_email_log` (id, holding_id, user_id, kind `alert\|digest`, dedup_key, notification_id, status `pending\|sent\|failed`, provider_id, error, created_at, sent_at; UNIQUE `(user_id, dedup_key)`; RLS sin políticas) | ídem |
| N7 | `client_activity_notes.mentioned_user_ids uuid[] NOT NULL DEFAULT '{}'` + `references jsonb NOT NULL DEFAULT '[]'` + índice GIN de menciones | ídem |
| N8 | Semilla `month_close_pending` para Administrador, Finanzas y Facturación y Cobranza (idempotente) | `seed/008-notification-month-close-subscriptions.sql` |
| — | `create_default_roles_for_holding` suma `month_close_pending` (volver a aplicar la función) | `functions/create_default_roles_for_holding.sql` |

Orden: N4–N7 (una migración) → N8 → función → desplegar la API (la API escribe `company_id` y lee las columnas nuevas).

### 8.10 Variables de entorno

| Variable | Default | Efecto |
|---|---|---|
| `NOTIFICATION_EMAILS_ENABLED` | activo | `false` apaga todos los correos de Notificaciones (inmediatos, resumen, respaldo) |
| `NOTIFICATION_EMAIL_DELAY_MINUTES` | `15` | ventana de espera de la alerta inmediata por correo (minutos, `>= 0`; inválido → 15) |
| `NOTIFICATION_JOBS_ENABLED` | activo | `false` apaga el job horario (cierre de mes y resumen semanal); no el envío de alertas por correo |
| `INVITE_LANDING_URL` | `https://www.aisapira.com` si falta | base de los enlaces de los correos |
| `INVITE_TEST_ALLOWLIST` | — | en QA, solo salen correos a la lista (también los de Notificaciones) |
| `INVOICE_ADMIN_EMAILS` / `BANCO_CENTRAL_ADMIN_EMAILS` | — | **solo respaldo**: si la alerta interna no tiene destinatarios |
| `BANCO_CENTRAL_SEND_SUCCESS_REPORT` | — | sin efecto (el reporte de éxito ya no va por correo) |

### 8.11 Cambios en otros módulos (autorizados)

- **Configuración › Roles** (`GET/PUT /settings/roles/:id/alerts`): ofrece 12 tipos (suma `fx_sync_failure` y `month_close_pending`; los
  internos de Sapira no).
- **Métricas**: exporta `MrrMetricsService` (el resumen reusa `overview`, `movementDetail` y `byDimension` por compañía, sin recalcular).
- **Facturación / Banco Central**: `InvoiceNotificationService` y `ExchangeRatesNotificationService` ya no usan SendGrid; `InvoiceSchedulerService`
  llama al resumen también sin errores (para cerrar la alerta) y cierra `invoice_fx_missing` al enviar bien la factura.
- **Clientes**: notas con menciones y referencias, `GET /clients/:id/references`, textos de la Actividad en español (§8.7).
- **Módulo nuevo** `src/modules/notification-jobs/` (resumen semanal, cierre de mes, job horario y `POST /notifications/digest/preview`).

