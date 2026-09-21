# Notificaciones generales

El módulo expone `notifications` para eventos de aplicación persistentes y sus destinatarios. Requiere autenticación Supabase y el header `x-holding-id`, igual que los controladores de módulos existentes.

## Endpoints

No hay endpoint HTTP de creación: las notificaciones se crean desde el backend con `NotificationsService.create` / `createOrUpdate`. Los destinatarios (`recipients.user_ids`, `recipients.role_ids`, `recipients.include_super_admins` más las suscripciones activas del mismo `type`) se limitan a usuarios con estado `Activo` y membresía activa en el holding.

- `GET /notifications?page=1&limit=20`: devuelve las notificaciones del usuario autenticado, su paginación y `unread_count`.
- `GET /notifications/:notificationId`: devuelve únicamente una notificación asignada al usuario autenticado.
- `PATCH /notifications/:notificationId/read`: marca como leída únicamente la asignación del usuario autenticado.
- `GET /notifications/subscriptions/salesforce-staging-blocked`: lista las suscripciones de rol de todos los tipos suscribibles (ver tabla), pese al nombre de la ruta.
- `PUT /notifications/subscriptions/salesforce-staging-blocked`: reemplaza esas suscripciones, para los tres tipos, con `{ role_ids, include_super_admins }`.

La gestión de suscripciones requiere una membresía activa en el holding y puede ser realizada por Super Admin o por usuarios con rol `Administrador` en ese holding.

`include_super_admins` se representa con una suscripción cuyo `role_id` es `NULL`, coherente con el esquema de base de datos. Las notificaciones usan `deduplication_key` para impedir la creación de más de un evento abierto para la misma clave y holding.

## Tipos suscribibles por rol

Los endpoints de suscripción operan sobre todos los tipos de `ROLE_SUBSCRIPTION_NOTIFICATION_TYPES`, de modo que una sola configuración de destinatarios cubre los tres:

| Tipo | Origen | Acción asociada |
| --- | --- | --- |
| `salesforce_staging_blocked` | Una oportunidad Salesforce queda bloqueada en staging | `retry_salesforce_opportunity` |
| `salesforce_sync_failure` | Falla la corrida diaria de sincronización de Salesforce para un holding | `review_salesforce_sync_log` |
| `invoice_odoo_failure` | Falla la emisión de una factura en Odoo | — |

## Entrega en tiempo real

`NotificationsGateway` expone el namespace Socket.IO `/notifications` en el mismo servidor HTTP. Lo consumen `front-sapira` (Next) y `front-sapira-vite`.

- **Handshake**: token de Supabase en `auth.token` (o header `Authorization: Bearer`). El cliente queda en la sala `user:<users.id>`, de modo que recibe eventos de todos sus holdings y **debe filtrar por `holdingId`**.
- **CORS**: mismos orígenes que HTTP (`src/core/config/cors-origins.ts`: `FRONT_BASE_URL` + previews `*.vercel.app`). En producción `FRONT_BASE_URL` debe incluir `https://app.aisapira.com` y `https://www.aisapira.com`.

| Evento (servidor → cliente) | Payload | Cuándo |
| --- | --- | --- |
| `connected` | `{ userId }` (id de Supabase Auth) | handshake válido |
| `unauthorized` | `{ message }` | token ausente, inválido o usuario inexistente; el servidor desconecta a continuación y el cliente debe reconectar con un token nuevo |
| `notification:created` | `{ holdingId, notification }` (con `is_read: false`) | `create` inserta una notificación con destinatarios |
| `notification:read` | `{ holdingId, notificationId, read_at }` | `PATCH /notifications/:id/read` marca una pendiente (solo a la sala del usuario, para sincronizar sus otras pestañas y el otro front) |
| `notification:updated` | `{ holdingId, notificationId }` | `createOrUpdate` actualiza una notificación abierta por `deduplication_key`, o `resolveByDeduplicationKey` la resuelve |

El gateway no escucha eventos del cliente. Los fronts usan los eventos como **señal para recargar** por REST (`GET /notifications`), que sigue siendo la fuente de verdad; así una reconexión no pierde cambios.

## Dependencias de datos

El módulo mapea las tablas `app_notifications`, `app_notification_recipients` y `notification_role_subscriptions`. La migración de estas tablas se mantiene fuera de este módulo y debe aplicarse antes de usar los endpoints.
