# Revisión de seguridad de la API · insumo del bloque de seguridad

> **Estado: solo documentado (02-10-2026).** Nada corregido. El bloque de seguridad se hace aparte, con OK de Domi
> y coordinado con Leon. **Urgentes: #1, #2, #3, #11 y #16.** No bloquea el módulo Configuración.
> Origen: revisión de solo lectura de los controladores sin `HoldingScopeGuard` (40 de 57 no validan el holding);
> la sesión anterior confirmó contra el código #1, #3, #11 y #16. Resumen para Leon en
> [`cambios-integracion-para-leon.md`](./cambios-integracion-para-leon.md) §13.

## Contexto

- La API solo exige un token válido de Supabase (`SupabaseAuthGuard` global). El registro libre está cerrado en
  Supabase, así que el atacante realista es **un usuario existente de un cliente** que entra a datos de otro. Las
  rutas `@Public` no exigen ni eso.
- La API escribe en la base como `postgres` (dueño de las tablas): las políticas RLS no la frenan. El aislamiento
  depende solo de `HoldingScopeGuard`, que se aplica controlador por controlador.
- Swagger está público en producción (`/api`).
- El modelo de autorización para cerrar estas rutas queda definido en
  [`spec-configuracion-v2.md`](./spec-configuracion-v2.md) §10 (holding validado + permiso por rol + super admin).

Columna "Qué puede romperse": consecuencia de cerrarlo para el **front actual** (Vite, hasta el switch), el **front
nuevo** (BFF de Next), el **webhook de Odoo** o los **procesos automáticos** (schedulers, crons, syncs).

## A. De integraciones (Leon)

| # | Gravedad | Ruta | Problema | Evidencia | Arreglo sugerido | Qué puede romperse al cerrarlo |
|---|---|---|---|---|---|---|
| 3 | **Crítico · urgente** | `POST /odoo/webhooks` (`@Public`, sin firma) | Sin sesión se marcan facturas como Pagadas/Enviadas y se cambian monto, IVA, número y fecha | `odoo-webhook.controller.ts:15,51-70`; `odoo-webhook.service.ts:305-385` | Secreto por conexión (header o token en la URL) + validar que la factura sea del holding de esa conexión | **Webhook de Odoo**: hay que reconfigurar la acción automatizada en cada Odoo de cliente al mismo tiempo; si no, deja de llegar el estado de pago/emisión (las facturas quedan en Enviada). Coordinar ventana con Leon |
| 1 | **Crítico · urgente** | `GET /odoo/connections` (sin header → todas), `GET/PUT/DELETE /odoo/connections/:id`, `PATCH /:id/toggle-active`, `POST` | Expone `api_key` de Odoo de todos los clientes; permite cambiar la URL o borrar la conexión de otro | `odoo-connection.controller.ts:28-32`; `odoo-connection.service.ts:16-20`; `odoo-connection.entity.ts:31` | `HoldingScopeGuard`; quitar la rama "todas"; nunca devolver `api_key` (enmascarar) | **Front actual**: la pantalla de Integraciones › Odoo si muestra o reenvía la `api_key` (al editar habría que pedirla de nuevo). Front nuevo: no la usa todavía. Procesos automáticos: no (leen la conexión por servicio, no por la ruta) |
| 2 | **Crítico · urgente** | `GET /stripe/connections`, `GET /:id` (+ `POST/PUT/DELETE/PATCH`) | Devuelve `secret_key` de Stripe del holding del header, sin validar | `stripe-connection.controller.ts:29,48`; `stripe-connection.entity.ts:22` | `HoldingScopeGuard`; nunca devolver `secret_key` | **Front actual**: Integraciones › Stripe al editar (pedir la clave de nuevo). Procesos automáticos: no |
| 5 | Crítico | `POST /invoices/scheduler/send` | Sin header y con `dryRun:false` emite las facturas vencidas de **todos** los holdings | `invoice-scheduler.controller.ts:41-55` | Solo super admin, o holding validado obligatorio | **Front actual**: el botón de envío masivo pierde el modo "todos los holdings" (solo super admin lo usa). Procesos automáticos: no (el scheduler llama al servicio) |
| 6 | Crítico | `POST /odoo/invoices/create-draft` | Crea y publica facturas en el Odoo de otro holding | `odoo-invoices.controller.ts:147-156` | Eliminar la ruta (el servicio se sigue usando por dentro) | Nada: sin uso en ningún front. Confirmar con Leon que no la usa desde Postman/scripts |
| 7 | Crítico | `POST /bigquery/query`, `POST /salesforce/query` | Consulta libre (SQL/SOQL) contra el BigQuery o el Salesforce del cliente | `bigquery.controller.ts:116`; `bigquery.service.ts:182-194`; `salesforce.controller.ts:199-218` | Eliminar `/bigquery/query`; `/salesforce/query` con `HoldingScopeGuard` o eliminar | **Front actual**: la pestaña de consultas de Salesforce (solo super admin). Front nuevo: nada |
| 4 | Alto | `GET /odoo/webhooks` | Payloads e ids de facturas de todos los holdings (alimenta el #3) | `odoo-webhook.controller.ts` | Eliminar o solo super admin | Nada: sin uso |
| 8 | Alto | `/salesforce/mappings/*`, `/salesforce/staging/*` (`HoldingAccessGuard` obsoleto), `/salesforce/*` (auth, credenciales, sync, preview), `/salesforce/sync-logs` (`allHoldings=true`) | Header sin validar: leer y escribir mapeos, credenciales y syncs de otro holding; logs de todos | `salesforce-mapping.controller.ts:39-286`; `salesforce-staging.controller.ts`; `salesforce.controller.ts` | `HoldingScopeGuard` en todos; `allHoldings` solo super admin | **Front nuevo**: la BFF de mapeos/staging ya manda `x-holding-id` (verificar en cada ruta). **Front actual**: manda el header siempre. **Procesos automáticos**: el sync programado de Salesforce no pasa por estas rutas; confirmar con Leon |
| 9 | Alto | `/stripe/invoices|customers|subscriptions` (clave global de la plataforma), `/stripe/products*`, `/stripe/ingestion/*`, `/stripe/sync`, `/stripe/staging/*` (PATCH por id sin dueño) | Datos de la cuenta Stripe de la plataforma; staging ajeno | `stripe.controller.ts:25-162`; `stripe.provider.ts:10` | Eliminar los de clave global (sin uso); `HoldingScopeGuard` + dueño en el resto | **Front actual**: Integraciones › Stripe (manda header). **Procesos automáticos**: la ingestión programada de Stripe, si llama estas rutas en vez del servicio (confirmar con Leon) |
| 10 | Alto | `/odoo/companies*`, `/odoo/products*`, `/odoo/count-records`, `/odoo/invoices/start-async`, `/odoo/sync-invoices`, partners, invoice-processing, fiscal-positions, invoice-tax-validator, `/bigquery/*` (resto), `/bigquery/connections`, `POST /clients/sync-stripe-ids` | Usar credenciales de otro cliente; escribir mapeos, staging y consumos | `odoo.controller.ts`; `bigquery.controller.ts`; `stripe-clients.controller.ts` | `HoldingScopeGuard` (+ dueño de la conexión) | **Front actual**: Integraciones (manda header). **Procesos automáticos**: importaciones en curso de partners/facturas legacy si se disparan por ruta |

## B. Comunes (Domi y Claude)

| # | Gravedad | Ruta | Problema | Evidencia | Arreglo sugerido | Qué puede romperse al cerrarlo |
|---|---|---|---|---|---|---|
| 11 | **Crítico · urgente** | `POST /holdings/assign-to-all-holdings/:userId` | Cualquier usuario con sesión se agrega a todos los holdings y pasa todo `HoldingScopeGuard` | `holdings.controller.ts:78-106`; `holdings.service.ts:81-115` | Solo super admin | Nada para usuarios: ningún front la usa. Leon la usa para asignar super admins (seguirá pudiendo) |
| 16 | **Crítico · urgente** | `/database/*` (5 rutas `@Public`), `/security/*` (22), `/audit/*` (5), `/devices/*` (5) | Sin sesión: esquema completo de la base (incluye `auth`, triggers, políticas RLS) y escritura de archivos en el servidor; con sesión: **bloquear la IP del front o de la BFF** (caída de toda la plataforma), ponerse en lista blanca; auditoría con headers guardados | `database-analyzer.controller.ts:55-241`; `database-generator.service.ts:181`; `security.controller.ts`; `app.module.ts:140` | Eliminar los cuatro módulos o dejarlos solo para super admin y sin `@Public` | Nada: sin uso en ningún front ni proceso. Confirmar que nadie usa `/database/*` para generar entities en desarrollo |
| 13 | Crítico | `POST /copilot/chat`, `/copilot/sessions*`, `POST /claude/message` | Datos de cualquier holding vía el copiloto (filtra por el `holding_id` del body); proxy libre a Claude con costo; `group_by` concatenado al SQL | `sapira-copilot.controller.ts:31-38`; `claude.controller.ts:30-48`; `skill-executor.ts:171-175`; `query-builder.ts:75` | `HoldingScopeGuard` + `@HoldingId()`; eliminar `/claude/message`; lista blanca para `group_by` | **Front nuevo**: la BFF del copiloto (`app/api/copilot/chat/route.ts`) manda el holding en el body y no reenvía `x-holding-id`: hay que cambiarla a la vez. Front actual: manda header |
| 14 | Crítico | `POST /agents/:id/run` (`mode=execute`), `POST /agents/runs/:id/approve`, `client-config(s)`, `holding-config`, `email-senders` | Enviar correos de cobranza o proforma a clientes de otro holding; leer y cambiar configuración de agentes ajena | `agents.controller.ts:35-63`; `agents.service.ts:55-85` | `HoldingScopeGuard` + dueño del agente/corrida | **Front actual**: Automatizaciones (manda header). **Procesos automáticos**: los procesadores de cobranza/proforma corren por cola, no por ruta. Además arregla `PUT /agents/:id/config`, hoy roto (404) |
| 12 | Alto | `GET /users`, `/users/:id`, `/users/by-email`, `/users/by-auth-id`, `/holdings/user/:id`, `/holdings/:id` | Datos de todos los usuarios de la plataforma (incluye super admins); fichas de cualquier holding | `users.controller.ts:70-132`; `holdings.controller.ts:51,74` | Eliminar las sin uso; `/holdings/:id` con membresía | Nada: el front nuevo solo usa `/users/me/context` y `/holdings/select`; el actual define `getHoldingById` pero no lo usa |
| 15 | Alto | `/emails/*` (10 rutas), `/email/*` (4, viejo) | Ver, editar y borrar dominios y remitentes de otro holding por id (borra también en SendGrid); correo de prueba desde el dominio de otro cliente | `emails.controller.ts:36-207`; `emails.service.ts:353-606` | `HoldingScopeGuard` + filtro por dueño en cada id; eliminar `/email/*` | **Front actual**: Configuración › Correo (manda header y el mismo holding en el body). Nadie tiene dominio propio hoy (0 filas) |
| 17 | Alto | `POST /invoices/bulk-update-currency`, `PATCH /invoices/:id/auto-invoice`, `PATCH /invoices/contract/:id/bulk-auto-invoice`, `GET /invoices/odoo-sended-logs*` | Cambiar moneda o autoemisión de facturas ajenas por id; logs de envío de otros | `invoices.controller.ts` | `HoldingScopeGuard` + `where holding_id` | **Front actual**: las usa (manda header). Front nuevo: no |
| 18 | Alto | `/subscriptions/*` | Suscripciones de otro holding | `subscriptions.controller.ts` | `HoldingScopeGuard` | **Front actual**: manda header |
| 19 | Medio | `/banco-central/*` y `/peru-api/*` (sync, sync-historical, calculate-monthly, test-notification-*) | Disparar sincronizaciones pesadas y alertas internas | `banco-central.controller.ts`; `peru-api.controller.ts` | Solo super admin para sync/test; lecturas abiertas | **Front actual**: "Datos económicos" pierde el botón sincronizar para no super admin. **Procesos automáticos**: no (scheduler propio) |
| 20 | Medio | `PATCH /cities/regions/:code`, `POST /events/client-error` | Renombrar regiones globales; inyección en logs | `cities.controller.ts`; `events.controller.ts` | Quitar o solo super admin | Nada: sin uso |
| 21 | Bajo | `/notifications/*` | Correcto (filtra por destinatario); falta el guard por consistencia | `notifications.controller.ts` | `HoldingScopeGuard` | Nada: ambos fronts mandan header |

## C. Plataforma (Domi decide)

- Guard de super admin reutilizable (no existe) y guard de permiso por rol: definidos en el modelo de autorización
  de Configuración (§10 de la spec); este bloque solo los aplica a las rutas de arriba.
- Swagger solo fuera de producción.
- Al switch: eliminar la edge function `send-invitation`/`delete-user` y la ejecución pública de `invite_user_safe`.
- Código sin uso que se puede eliminar en el mismo bloque: módulos `database`, `security`, `audit`, `events`,
  `devices`, `email` (singular), ruta `/claude/message`, `bigquery-connections`, `fiscal-positions`,
  `invoice-tax-validator`, `odoo/partners` (controller), `salesforce/sync-logs`, `clients/sync-stripe-ids`, y rutas
  sueltas de `users`, `holdings`, `invoices`, `odoo`, `stripe`, `bigquery`, `salesforce`, `banco-central` y
  `agents` (lista completa en la revisión del 02-10). Antes de borrar algo de integraciones, confirmar con Leon.

## Orden sugerido del bloque

1. Urgentes comunes sin riesgo de romper: #11, #16.
2. Urgentes de Leon: #1, #2 (sin riesgo para procesos) y #3 (con ventana coordinada para reconfigurar cada Odoo).
3. Críticos restantes: #5, #6, #7 (Leon); #13 (junto con la BFF del copiloto), #14 (común).
4. Altos y medios por controlador, usando el guard de permisos de Configuración.
5. Eliminación del código sin uso y Swagger fuera de producción.

Límite: solo se buscaron llamadas literales en los dos fronts, edge functions y scripts del repo; no se ven usos
desde Postman, scripts locales ni otras acciones de Odoo.
