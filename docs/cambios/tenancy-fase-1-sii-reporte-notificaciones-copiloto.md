# Cambio: tenancy Fase 1 — SII, reporte de integración, notificaciones y copiloto con `HoldingScopeGuard`

> **Rama:** `leon` · 26-09-2026 · Leon + Claude
> **Repos front (par):** `front-sapira` (BFF y hooks) y `front-sapira-vite` (hidratación del holding).
> **Regla que se aplica:** [`docs/v2-rediseno/autorizacion-y-tenancy.md`](../v2-rediseno/autorizacion-y-tenancy.md)

## Contexto

La regla de tenancy estaba aplicada en 5 de 49 controladores (Clientes y Dashboard). De los que faltaban, **cuatro
los consume el front nuevo**, y tres daban comportamiento incorrecto: el selector de holding no gobernaba lo que el
usuario veía. Esta tanda migra esos cuatro. Los ~25 restantes solo los usa el front viejo y quedan para la Fase 2.

## Alcance

| Endpoint | Antes | Ahora |
|---|---|---|
| `GET/POST/PATCH /sii/companies*` | El holding salía de `user_holdings.selected` en la base: el selector del front nuevo no tenía efecto y cambiar de holding en una pestaña lo cambiaba en todas | Holding del header `x-holding-id`, validado contra `user_holdings` activo. Razón social de otro holding → 404 |
| `GET /invoices/scheduler/report` | Acotado a *todos* los holdings del usuario; para super admin, a ninguno (veía todo). Un usuario de cliente lo veía casi vacío | Acotado al holding activo, incluyendo las corridas cross-holding del cron recortadas (ver abajo) |
| `GET/PATCH/PUT /notifications*` | Header leído a mano con `@Headers`, **sin validar** que el usuario perteneciera a ese holding | `HoldingScopeGuard`: 400 sin header, 403 si no pertenece |
| `/sapira-copilot/*` (6 endpoints) | `holding_id` por body y query, sin ninguna validación | Holding del header. `holding_id` queda opcional `deprecated` en los 3 DTOs por compatibilidad con el front viejo; el servicio lo ignora y el guard exige que coincida |

## El reporte y las corridas `holdingId: 'all'`

El cron nocturno (`invoice-scheduler.scheduler.ts`) llama `createSystemSchedulerJob({ dryRun: false })` **sin holding**,
y el job queda con `holdingId: 'all'`. Es decir: **el 100% de las ejecuciones automáticas son cross-holding**. Filtrar
el reporte por el holding activo a secas lo habría dejado prácticamente vacío.

`getJobsReport` ahora:

1. Matchea `$or: [{ holdingId }, { holdingId: 'all' }]` — mismo patrón que ya usaba `getRecentJobs`.
2. Recorta las facturas de cada corrida con un `scopedResults`: en una corrida `'all'` deja solo las del holding
   activo; en una corrida de un solo holding no filtra nada (los registros antiguos pueden no traer `holdingId` por
   factura). **Sin este recorte, una corrida `'all'` expondría `invoiceNumber`, `clientName` y `companyName` de otros
   clientes**: sería una fuga nueva, hoy imposible porque el `$in` anterior excluía las `'all'`.
3. Recalcula `progress` y el `summary` sobre lo recortado, solo en las corridas `'all'`.

Efecto visible: una ejecución automática sigue apareciendo en el reporte, pero con menos facturas y totales distintos
según el holding activo. `holdingId`/`holdingName` se conservan en la respuesta porque esas corridas siguen siendo
cross-holding.

## Desviaciones de la regla, a propósito

- **`HoldingScopeGuard` a nivel de método en `InvoiceSchedulerController`**, no en la clase: el mismo controlador
  expone `send`, `status`, `jobs` y `debug`, que el front viejo sigue llamando. Ponerlo en la clase los rompería.
- **`holding_id` opcional `deprecated` en los DTOs del copiloto**, no eliminado: con `forbidNonWhitelisted: true`
  (`main.ts`), borrar el campo devolvería 400 a quien lo mande, y el front viejo lo manda.

## Cambios en los fronts

- `front-sapira`: las rutas BFF de SII, reporte y copiloto reenvían `x-holding-id` con `holdingHeaders()`; el hook del
  reporte incluye el holding en su `queryKey` y espera a que exista; `empresas-sii` y `FacturaCompanyContext` ya no
  consultan con el holding en `null`; el copiloto dejó de mandar `holding_id`. Se borró
  `app/api/invoices/scheduler/report/route.ts`, duplicado huérfano del reporte.
- `front-sapira-vite`: `holdingStore` se hidrata desde `sessionStorage` y los hooks de notificaciones esperan al
  holding. Sin eso, entrar directo a `/notificaciones` tras una recarga daba 400, porque el store nacía en `null`.

## Tests

Primer spec de controlador con guard del repo: `Test.createTestingModule` + `HoldingScopeGuard` real +
`UserHoldingsService` mockeado + `overrideGuard(SupabaseAuthGuard)` + supertest. Cubre los tres casos obligatorios
(sin header → 400, holding ajeno → 403, registro ajeno → 404) en `sii`, `notifications`, `sapira-copilot` e
`invoices/scheduler`.

- `src/modules/sii/sii.controller.spec.ts`, `src/modules/sii/sii.service.spec.ts`
- `src/modules/notifications/notifications.controller.spec.ts`
- `src/modules/sapira-copilot/sapira-copilot.controller.spec.ts`
- `src/modules/invoices/invoice-scheduler.controller.spec.ts` e `invoice-scheduler.report.spec.ts` (el recorte de las
  corridas `'all'`, que no tenía ni un caso)

`yarn jest` → 74 suites, 950 tests en verde. En `front-sapira`, `yarn test` → 74 archivos, 261 tests.

## Pendientes que deja abiertos

1. `/invoices/scheduler/{send,jobs,status,debug}` siguen sin acotar: hoy un usuario puede disparar el scheduler de
   otro holding, o de todos omitiendo el header.
2. `NotificationsGateway` e `InvoiceSchedulerGateway` no validan holding (los sockets solo invalidan queries, no
   transportan datos que la UI muestre).
3. `SupabaseAuthGuard` está registrado como `APP_GUARD` global **y** repetido en `@UseGuards` de los 9 controladores
   migrados: cada request paga un `supabase.auth.getUser()` de más. Se saca de todos a la vez, con Domi.
4. Los ~25 controladores de Fase 2 (salesforce, stripe, odoo, bigquery, subscriptions, agents…).
