# Notificaciones (v2, fase 1)

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
Tipos: los 10 de siempre, `system_update` (novedad del sistema, acción `open_help { slug }`, a todos los miembros activos; canal listo,
sin productor), y reservados de fase 2 (`user_mention`, `fx_sync_failure`, `invoice_fx_fallback`, `invoice_fx_missing`,
`scheduler_error_summary`). La semilla N3 y `create_default_roles_for_holding` son espejo de `defaultSubscriptions()` (un test lo compara).

## Endpoints (todos con `SupabaseAuthGuard` + `HoldingScopeGuard`)

| Ruta | Qué hace |
| --- | --- |
| `GET /notifications` | Lista con filtros (`status`, `read`, `archived`, `type[]`, `module[]`, `severity[]`, `from`, `to`, `search`) y paginación `{ data, total, items, currentPage, pages, limit }` + `unread_count` y `pagination` (forma vieja, front actual) |
| `GET /notifications/counts` | Sin leer: total, por módulo y por tipo (sin archivadas) |
| `GET /notifications/catalog` | Catálogo para filtros y etiquetas |
| `GET /notifications/tasks` | Tareas con algo por hacer (controlador en `TasksModule`) |
| `GET/PUT /notifications/preferences` | Por usuario y holding: `in_app` y `email` por tipo, `weekly_digest` |
| `POST /notifications/read-all` | Marca leídas las que cumplen los filtros del cuerpo |
| `POST /notifications/archive` · `/unarchive` | `{ ids }`, por usuario |
| `GET /notifications/:id` | Detalle con `texts { what_happened, what_to_do, what_we_do }` |
| `PATCH /notifications/:id/read` · `/unread` | Lectura por usuario |
| `GET/PUT /notifications/subscriptions/salesforce-staging-blocked` | Ruta vieja (front actual): solo los 3 tipos de siempre |

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
`user_notification_preferences` (N2; el resumen semanal es la fila `notification_type = 'weekly_digest'`). Migraciones N1/N2 y semilla N3
escritas **sin aplicar**; orden: N1 → N2 → N3 → `create_default_roles_for_holding` (pendiente de OK de Domi) → desplegar la API.
