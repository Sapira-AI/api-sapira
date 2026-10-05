# Inventario de tenancy: Fase 2 (controladores pendientes)

> Levantado el 26-09-2026, al cerrar la Fase 1. Regla que hay que aplicarles:
> [`autorizacion-y-tenancy.md`](./autorizacion-y-tenancy.md) · referencia técnica del guard:
> [`docs/guards/holding-scope-guard.md`](../guards/holding-scope-guard.md).

## Estado

De 49 controladores, **10 usan `HoldingScopeGuard`**: Clientes (4) y Dashboard, migrados por Domi el 24-09; y SII,
notificaciones, copiloto y `GET /invoices/scheduler/report`, migrados en la Fase 1 el 26-09 (ver
[`docs/cambios/tenancy-fase-1-sii-reporte-notificaciones-copiloto.md`](../cambios/tenancy-fase-1-sii-reporte-notificaciones-copiloto.md)). Y `agents`, migrado el 04-10 al
abrir el frente de automatizaciones.

La Fase 1 cubrió **todo lo que el front nuevo consume**. Lo que queda lo llama únicamente la app actual
(`front-sapira-vite`), así que no produce comportamiento incorrecto en `front-sapira`, pero sí deja el agujero de
autorización abierto: **RLS no filtra nada de lo que pasa por la API**, y estos endpoints reciben el holding sin
comprobar que el usuario pertenezca a él.

## Riesgo

Cualquier sesión válida puede operar sobre un holding ajeno mandando su UUID en `x-holding-id`. No hace falta ser
super admin. Aplica a los 26 controladores de la tabla.

## Los 26 pendientes

`header` = cuántos `@Headers('x-holding-id')` lee a mano; `holding_id` = cuántas veces lo toma de query o body.

| Ruta | Archivo | Cómo resuelve el holding hoy |
|---|---|---|
| ~~`agents`~~ | `agents/agents.controller.ts` | ✅ **Migrado el 04-10-2026**: `HoldingScopeGuard` + `@HoldingId()` en los 10 endpoints; `holding_id` quedó opcional `deprecated` en sus DTO. Spec de tenancy en `agents.controller.spec.ts` |
| `bigquery-connections` | `bigquery/bigquery-connection.controller.ts` | header=6 · holding_id=7 |
| `bigquery` | `bigquery/bigquery.controller.ts` | header=9 · holding_id=1 |
| `claude` | `claude/claude.controller.ts` | holding_id=3 |
| `clients` (Stripe) | `clients/stripe-clients.controller.ts` | header=1 |
| `holdings` | `holdings/holdings.controller.ts` | holding_id=2 — **no lleva guard**: es el bootstrap del header |
| `invoices` | `invoices/invoices.controller.ts` | header=2 · holding_id=2 |
| `odoo/fiscal-positions` | `odoo/fiscal-positions.controller.ts` | header=6 |
| `odoo/invoice-processing` | `odoo/invoice-processing.controller.ts` | header=8 |
| `odoo/invoices` | `odoo/invoice-tax-validator.controller.ts` | header=2 |
| `odoo/connections` | `odoo/odoo-connection.controller.ts` | header=1 |
| `odoo/invoices` | `odoo/odoo-invoices.controller.ts` | header=1 |
| `odoo-partners` | `odoo/odoo-partners.controller.ts` | header=7 |
| `odoo/webhooks` | `odoo/odoo-webhook.controller.ts` | holding_id=4 — **webhook**: holding del registro, sin guard |
| `odoo` | `odoo/odoo.controller.ts` | header=6 · holding_id=4 |
| `odoo/partners` | `odoo/partners.controller.ts` | header=3 |
| `salesforce/mappings` | `salesforce/salesforce-mapping.controller.ts` | header=16 |
| `salesforce/staging` | `salesforce/salesforce-staging.controller.ts` | header=20 · **`HoldingAccessGuard` (deprecado)** |
| `salesforce/sync-logs` | `salesforce/salesforce-sync-log.controller.ts` | header=3 · **`HoldingAccessGuard` (deprecado)** |
| `salesforce` | `salesforce/salesforce.controller.ts` | header=18 |
| `stripe/staging` | `stripe/controllers/stripe-staging.controller.ts` | header=3 |
| `stripe/sync` | `stripe/controllers/stripe-sync.controller.ts` | header=1 |
| `stripe/connections` | `stripe/stripe-connection.controller.ts` | header=5 |
| `stripe/ingestion` | `stripe/stripe-ingestion.controller.ts` | header=6 |
| `stripe` | `stripe/stripe.controller.ts` | header=2 |
| `subscriptions` | `subscriptions/subscriptions.controller.ts` | header=3 |

Además, dentro de un controlador ya migrado: **`/invoices/scheduler/{send,jobs,status,debug}`** siguen sin acotar (el
guard está solo en `report`). Hoy un usuario puede disparar el scheduler de otro holding, o de todos omitiendo el
header.

## Antes de migrar cualquiera de estos: lo que rompe en el front viejo

`NestJSApiClient` (`front-sapira-vite/src/lib/nestjsApi.ts`) agrega `X-Holding-Id` desde `holdingStore` en **todas** las
llamadas, así que la mayoría pasa. Los dos problemas reales:

1. **400 por holding vacío.** `holdingStore` ya se hidrata desde `sessionStorage` (Fase 1), lo que cubre las recargas.
   Falta revisar caso por caso los consumidores que no esperan al holding con `enabled`: se detectaron
   `StripeProductMapping.tsx` (`/stripe/products`) y `useSalesforceSync.ts` (`getSyncRun` al montar desde
   `localStorage`).
2. **403 por `holding_id` que no coincide con el header.** El guard compara query y body contra el header. Dos fuentes
   quedan desfasadas al cambiar de holding:
   - ✅ **`agents`** (resuelto el 04-10): `setSelectedHoldingId` ahora también actualiza `userHoldingId`
     (`front-sapira-vite/src/contexts/HoldingContext.tsx`), así que el `holding_id` del body y el header ya
     no divergen al cambiar de holding. Era el prerequisito para ponerle el guard al controlador.
   - **`agents`, el problema original**: 8 endpoints usaban `userHoldingId` de `HoldingContext`, que **no se actualizaba** en
     `setSelectedHoldingId`. Tras cambiar de holding, body y header difieren.
   - **`salesforce/mappings`**: los componentes de mapeo toman el holding de
     `supabase.rpc('get_current_user_holding_id')` una vez al montar; ese RPC lee `user_holdings.selected`, que solo
     coincide si la persistencia del selector ya ocurrió y el componente se remontó.
   - Menor: `POST /bigquery/quantities/:id/replace` manda como body un `action_payload.incoming` opaco; si el backend
     llegara a meter `holding_id` ahí, sería un 403.

Los dos arreglos que eliminan casi todo el riesgo de 403 son de una línea: actualizar `userHoldingId` dentro de
`setSelectedHoldingId`, y dejar de mandar `holding_id` en `agentApiService.ts` y en los mapeos de Salesforce.

## Nunca llevan el guard

- `holdings` y `auth/*`: son el bootstrap del header. Si `GET /holdings` lo exigiera, el front no podría arrancar.
- `odoo/webhooks`: autenticación propia por secreto; el holding sale del registro que procesa.
- Catálogos globales y `/users/me`.

## Otros pendientes de la misma familia

- **Websockets**: `NotificationsGateway` e `InvoiceSchedulerGateway` no pasan por guards HTTP y no validan holding.
  Hoy solo avisan para que el front invalide queries; si algún día emiten contenido, necesitan validación propia.
- **`SupabaseAuthGuard` duplicado**: está como `APP_GUARD` global **y** repetido en el `@UseGuards` de los 9
  controladores migrados. No hace short-circuit, así que cada request paga un `supabase.auth.getUser()` extra. Se
  quita de todos a la vez, con Domi, actualizando el ejemplo canónico del doc de la regla.
