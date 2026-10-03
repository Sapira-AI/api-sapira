# Notificaciones (v2, fases 1 y 2)

Contrato completo (endpoints, catálogo, tareas, errores): `docs/v2-rediseno/contrato-api-notificaciones.md`. Spec y decisiones:
`docs/v2-rediseno/spec-notificaciones-v2.md` (§5 y §6 mandan).

Dos conceptos en un solo centro:

- **Alertas** (`app_notifications` + `app_notification_recipients`): cosas que **pasaron**. Las crean los productores con
  `NotificationsService.create` / `createOrUpdate` (no hay endpoint de creación) y se **cierran solas** cuando se resuelve la causa.
- **Tareas** (`src/modules/tasks`): cosas que **hay que hacer hoy**, calculadas en vivo (no se guardan). `TasksService.forHolding` es la
  única fuente para `GET /notifications/tasks` y para `GET /dashboard/home`.

## Catálogo (`notification-catalog.ts`)

Un solo archivo con cada tipo: etiqueta, módulo (Facturación, Contratos, Cotizaciones, Ingresos, Integraciones, Sistema), ícono lucide,
gravedad por defecto, si se suscribe por rol, roles por defecto, acción y los textos "Qué pasó" / "Qué hacer" (+ "Qué hacemos nosotros").
Tipos: los 10 de la fase 1, `fx_sync_failure`, los correos internos de Sapira (`invoice_fx_fallback`, `invoice_fx_missing`,
`scheduler_error_summary`; `internal`: solo super admins, no se ofrecen en Roles), `month_close_pending`, `system_update` (acción
`open_help { slug }`) y `user_mention` (acción `open_client_activity`). Ninguno queda reservado. Las semillas N3 + N8 y
`create_default_roles_for_holding` son espejo de `defaultSubscriptions()` (un test lo compara). Defaults de correo y resumen semanal:
`defaultEmailFor` / `defaultWeeklyDigestFor`.

## Endpoints (todos con `SupabaseAuthGuard` + `HoldingScopeGuard`)

| Ruta | Qué hace |
| --- | --- |
| `GET /notifications` | Lista con filtros (`status`, `read`, `archived`, `type[]`, `module[]`, `severity[]`, `from`, `to`, `search`) y paginación `{ data, total, items, currentPage, pages, limit }` + `unread_count` y `pagination` (forma vieja, front actual) |
| `GET /notifications/counts` | Sin leer: total, por módulo y por tipo (sin archivadas) |
| `GET /notifications/catalog` | Catálogo para filtros y etiquetas |
| `GET /notifications/tasks` | Tareas con algo por hacer (controlador en `TasksModule`); `company_ids` o "Mis compañías"; `all=true` |
| `GET/PUT /notifications/preferences` | Por usuario y holding: `in_app` y `email` por tipo, `weekly_digest`, `company_ids` ("Mis compañías"), `defaults` |
| `POST /notifications/read-all` | Marca leídas las que cumplen los filtros del cuerpo |
| `POST /notifications/archive` · `/unarchive` | `{ ids }`, por usuario |
| `GET /notifications/:id` | Detalle con `texts { what_happened, what_to_do, what_we_do }` |
| `PATCH /notifications/:id/read` · `/unread` | Lectura por usuario |
| `GET/PUT /notifications/subscriptions/salesforce-staging-blocked` | Ruta vieja (front actual): solo los 3 tipos de siempre |
| `GET /notifications/mentionable-users` | Miembros activos del holding para `@` (Actividad del Cliente 360) |
| `POST /notifications/system-updates` | Novedad del sistema a todos los usuarios activos (solo super admin, idempotente por slug) |
| `POST /notifications/digest/preview` | HTML del resumen semanal del holding activo (solo super admin; `notification-jobs`) |

`:id` solo acepta UUID (así `/notifications/tasks` y las rutas fijas nunca se confunden con un id). La lista solo trae lo del holding activo
y solo si el usuario es miembro activo (cierra #21). Configuración › Roles (`GET/PUT /settings/roles/:id/alerts`) ofrece todos los tipos
suscribibles con productor, con etiqueta y módulo.

## Reglas del servicio

- **Destinatarios**: suscripciones del tipo (`notification_role_subscriptions`; `role_id NULL` = super admins) + explícitos (`user_ids`,
  `role_ids`, `include_super_admins`, `all_members`); solo usuarios `Activo` con membresía activa; se excluye a quien apagó el tipo
  (`in_app = false`). Sin la tabla de preferencias (N2 sin aplicar) no se silencia a nadie.
- **`create` sin destinatarios no inserta**: `warn` en el log y `{ notification: null, recipient_count: 0 }`.
- **`createOrUpdate`**: con la clave abierta actualiza el contenido y suma destinatarios nuevos; si sube la gravedad o cambia
  `escalation_step` (guardado en `metadata.escalation_step`), vuelve a "sin leer" y desarchiva para todos.
- **Cierre automático**: `resolveOpen(holding, { type?, resourceId?, deduplicationKeys?, ids? })` (sin criterios no cierra nada) y
  `resolveByDeduplicationKey`. Productores:
  - `invoice_odoo_failure`: `InvoiceSchedulerService.sendInvoiceToOdoo` al quedar `sent` (todas las etapas de esa factura).
  - `salesforce_sync_failure`: la siguiente corrida diaria buena del holding.
  - `contract_renewal_proposed`, `contract_renewal_reminder`, `contract_scheduled_change_due`: `contracts/contract-alerts.ts`
    después de cada cambio del contrato (`ContractChangesService.apply`: confirmar renovación, renovar, dar de baja, terminar, aplicar
    pacto) y al omitir o cancelar un pacto. Omitir una propuesta ya la cerraba.
  - `bigquery_quantities_*` y `salesforce_staging_blocked`: como antes (por clave).

## Fase 2: compañías, correo y jobs

- **Mis compañías**: `app_notifications.company_id` (del productor o derivado de `resource_type` invoice/contract o
  `metadata.contract_item_id`) y la fila `my_companies` de `user_notification_preferences` (`company_ids`, vacío = todas). `MY_COMPANIES_SQL`
  filtra lista, conteos y marcar todas; `visibleTo` filtra socket y correo. Las alertas sin compañía las ve todo destinatario.
- **Correo** (`notification-email.service.ts`): un solo canal (Resend por `AuthMailer`, plantillas `auth/accounts/email-templates/alert.ts` y
  `digest.ts`). `create` reserva para los destinatarios nuevos; `createOrUpdate` para los nuevos y, si escala, para todos. Solo a quien
  quiere correo para el tipo (preferencia o default). Dedup en `notification_email_log` (`alert:<id>:<gravedad>:<escalón>`, o
  `alert-group:<grupo>` con `metadata.email_group`). `NOTIFICATION_EMAILS_ENABLED=false` apaga; en QA respeta `INVITE_TEST_ALLOWLIST`.
  Nunca lanza.
- **Ventana de espera de la alerta** (`NOTIFICATION_EMAIL_DELAY_MINUTES`, default 15): `queueAlert` solo reserva la fila `pending`;
  `sendDueAlerts` (job cada 5 minutos) envía las que cumplieron la ventana con la alerta aún `open`. Resuelta en la ventana → `failed`
  con `error = 'resuelta antes de enviar'` (sin correo). Escalada en la ventana → la reserva anterior queda `failed` ("reemplazada por
  escalamiento") y la nueva hereda su `created_at`: un solo correo, con asunto "Sigue pendiente". Cada fila se toma con `sent_at` antes de
  enviar (réplicas sin duplicados). Sin migración: usa los estados `pending|sent|failed` existentes.
- **Jobs** (`src/modules/notification-jobs/`): job horario (`NOTIFICATION_JOBS_ENABLED`); en la zona de cada holding, 07:xx cierre de mes
  (`MonthCloseService`, una alerta por compañía) y lunes 08:xx resumen semanal (`NotificationDigestService`, idempotente por semana; con
  varias compañías con datos agrega "Por compañía": tareas, alertas de la semana y MRR del mes). Aparte, cada 5 minutos, el envío de
  alertas por correo (no depende de `NOTIFICATION_JOBS_ENABLED`).
- **Correos internos** (facturas y tipos de cambio) son alertas del catálogo; las variables `INVOICE_ADMIN_EMAILS` /
  `BANCO_CENTRAL_ADMIN_EMAILS` quedan solo como respaldo si no hay destinatarios. El reporte de éxito de tipos de cambio ya no se envía.
- **Menciones**: `ClientActivityService.addNote` crea `user_mention` (`client-note-mention:<nota>`) con el fragmento legible.

## Tiempo real

Namespace Socket.IO `/notifications`, sala `user:<users.id>`. El handshake rechaza al usuario sin ninguna membresía activa
(`unauthorized`). Los eventos de actualización solo se emiten a quienes siguen siendo miembros activos del holding de la notificación.

| Evento | Payload | Cuándo |
| --- | --- | --- |
| `connected` | `{ userId }` | handshake válido |
| `unauthorized` | `{ message }` | token inválido, usuario inexistente o sin membresía activa |
| `notification:created` | `{ holdingId, notification }` | alerta nueva o destinatario sumado a una abierta |
| `notification:read` | `{ holdingId, notificationId, read_at }` | el usuario la marcó leída (otras pestañas) |
| `notification:updated` | `{ holdingId, notificationId }` | cambió, escaló, se resolvió o se marcó no leída; `notificationId = '*'` = cambiaron varias (marcar todas, archivar): recargar |

Los fronts usan los eventos como señal para recargar por REST.

## Base de datos

`app_notifications`, `app_notification_recipients` (N1: `archived_at`), `notification_role_subscriptions`,
`user_notification_preferences` (N2; el resumen semanal es la fila `weekly_digest` y "Mis compañías" la fila `my_companies` con
`company_ids`), `notification_email_log` (N6). Fase 1 aplicada en producción. Fase 2 **escrita sin aplicar**:
`1790900000000-NotificationsPhase2` (N4 `company_id`, N5 `company_ids`, N6 registro de correos, N7 menciones/referencias de notas) →
`seed/008-notification-month-close-subscriptions.sql` → volver a aplicar `create_default_roles_for_holding` → desplegar la API.
