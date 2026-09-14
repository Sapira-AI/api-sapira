# Notificaciones generales

El módulo expone `notifications` para eventos de aplicación persistentes y sus destinatarios. Requiere autenticación Supabase y el header `x-holding-id`, igual que los controladores de módulos existentes.

## Endpoints

- `POST /notifications`: crea un evento. Puede incluir `recipients.user_ids`, `recipients.role_ids` y `recipients.include_super_admins`. Los destinatarios se limitan a usuarios con estado `Activo` y membresía activa en el holding. También se agregan las suscripciones activas del mismo `type`.
- `GET /notifications?page=1&limit=20`: devuelve las notificaciones del usuario autenticado, su paginación y `unread_count`.
- `GET /notifications/:notificationId`: devuelve únicamente una notificación asignada al usuario autenticado.
- `PATCH /notifications/:notificationId/read`: marca como leída únicamente la asignación del usuario autenticado.
- `GET /notifications/subscriptions/salesforce-staging-blocked`: lista las suscripciones de rol de `salesforce_staging_blocked`.
- `PUT /notifications/subscriptions/salesforce-staging-blocked`: reemplaza esas suscripciones con `{ role_ids, include_super_admins }`.

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

`NotificationsGateway` expone el namespace WebSocket `/notifications`. El cliente se autentica con el token de Supabase en el handshake y queda unido a la sala `user:<id>`. Al crearse una notificación, cada destinatario recibe el evento `notification:created` con la notificación y `is_read: false`. La actualización de una notificación ya abierta por `deduplication_key` no reemite el evento.

## Dependencias de datos

El módulo mapea las tablas `app_notifications`, `app_notification_recipients` y `notification_role_subscriptions`. La migración de estas tablas se mantiene fuera de este módulo y debe aplicarse antes de usar los endpoints.
