# Plan de migración: módulo Integraciones al front nuevo

> Levantado el 27-09-2026 (Leon + Claude), al cerrar las corridas de facturación por holding.
> Módulo #3 de [`matriz-scope-migracion-front.md`](./matriz-scope-migracion-front.md), marcado ahí como
> prioridad 1 y "el candidato ideal para estrenar el patrón".
> **Estado: planificado, no iniciado.**

## Por qué ahora

Tres cosas empujan en la misma dirección:

1. **Los interruptores de integración automática por holding.** `holding_integration_settings` ya existe con
   `odoo`, `salesforce` y `bigquery` declarados, pero solo Odoo tiene quien lo respete y **ninguno tiene UI**:
   hoy se administra con un `UPDATE`. La configuración de cada integración en el front nuevo es su casa natural
   (ver [`docs/cambios/corridas-de-integracion-por-holding.md`](../cambios/corridas-de-integracion-por-holding.md)).
2. **La Fase 2 de tenancy.** Los ~25 controladores de [`inventario-tenancy-fase-2.md`](./inventario-tenancy-fase-2.md)
   —salesforce, stripe, odoo, bigquery, subscriptions— son exactamente los de este módulo. Hoy cualquier sesión
   puede operar sobre un holding ajeno mandando su UUID. Migrar el módulo **es** la ocasión de cerrarla.
3. **El módulo acumuló deuda**: dos generaciones de los mismos componentes conviviendo y pantallas que escriben
   directo a Supabase, algo que el front nuevo prohíbe.

## Tamaño real

| | |
|---|---|
| Páginas legacy | 5: `Integraciones`, `OdooIntegration`, `SalesforceIntegration`, `StripeIntegration`, `PeruApiIntegration` |
| Archivos | 59 (7 en la raíz de `integrations/`, 23 Odoo, 13 Salesforce, 14 Stripe) |
| Líneas | ~20.800 en componentes + 2.435 en páginas |
| Endpoints de api-sapira | ~174 |
| Componentes >1.000 líneas | 4 (`SalesforceClientMapping` 1.471, `OdooIntegrationClientes` 1.435, `OdooIntegrationFacturas` 1.222, `OdooDiagnosticTool` 1.064) |

No es un módulo: son cuatro productos distintos que comparten una pestaña.

## Paso 0 — Limpiar antes de portar

**Nada se migra sucio** (regla de la Fase 1). Antes de escribir una línea del front nuevo:

1. **Dos generaciones del mismo componente.** Existen `integrations/SalesforceClientMapping.tsx` (1.471 líneas,
   **la que usa la página**) y `integrations/salesforce/SalesforceClientMapping.tsx` (785 líneas). Lo mismo con
   `SalesforceProductMapping` (550 vs 514) y `SalesforceQuoteTypeMapping`. De la carpeta `salesforce/` solo se
   importan `SalesforceQuotesMappingDialog`, `SalesforceFlowDocumentation` y `SalesforceStagingTab`: el resto
   parece muerto. **Confirmar y borrar**, no portar por duplicado. Hay además un
   `SchedulerExecutionDialog.tsx.backup` en el repo.
2. **Escrituras directas a Supabase.** 9 archivos del módulo usan `supabase.from()` / `supabase.rpc()`. El front
   nuevo lo prohíbe (`AGENTS.md`: "Supabase solo para autenticación"), así que cada una tiene que convertirse en
   endpoint de `api-sapira` **antes** de portar la pantalla. Los focos: `OdooIntegrationClientes` (5),
   `OdooIntegrationFacturas` (2), `SalesforceClientMapping` (2), más los mapeos de Salesforce y
   `OdooDiagnosticTool`, que además llama a una edge function.
3. **Saneamiento de la familia de funciones/triggers** del módulo, como en cada migración.

## Paso 1 — Tenancy (cierra la Fase 2)

Por cada controlador que la pantalla vaya a consumir: `@UseGuards(SupabaseAuthGuard, HoldingScopeGuard)` +
`@HoldingId()`, DTOs sin `holding_id`, rutas por id con 404, y los tres tests obligatorios. El patrón y sus
trampas están en [`docs/guards/holding-scope-guard.md`](../guards/holding-scope-guard.md).

**Dos bombas ya identificadas**, que hoy darían 403 en cuanto se aplique el guard y que conviene arreglar en el
front legacy antes de tocar nada:

- **`agents`**: 8 endpoints mandan `holding_id` desde `userHoldingId` de `HoldingContext`, que **no se actualiza**
  en `setSelectedHoldingId`. Tras cambiar de holding, body y header difieren.
- **Mapeos de Salesforce**: toman el holding de `supabase.rpc('get_current_user_holding_id')` una vez al montar;
  ese RPC lee `user_holdings.selected` y solo coincide si la persistencia del selector ya ocurrió.

Ambos se arreglan en una línea cada uno. Y ojo con `POST /bigquery/quantities/:id/replace`, cuyo body es un
`action_payload.incoming` opaco: si alguna vez trae `holding_id`, el guard responde 403.

**Nunca llevan guard**: `holdings` y `auth/*` (son el bootstrap del header) ni `odoo/webhooks` (secreto propio,
holding del registro).

## Paso 2 — Orden por integración

De menor a mayor riesgo, para que el patrón se estrene en lo barato:

| # | Integración | Por qué ahí | Archivos |
|---|---|---|---|
| 1 | **Perú API / Banco Central** | La más chica y sin staging; sirve de piloto del patrón BFF + pantalla | 1 página |
| 2 | **Stripe** | Staging acotado, sin mapeos masivos; `holding_id` en query/body casi inexistente | 14 |
| 3 | **BigQuery** | Pocas pantallas, pero introduce su interruptor automático y el sync de cantidades | — |
| 4 | **Salesforce** | Staging, runs asíncronos y mapeos masivos; es donde están los 403 latentes | 13 |
| 5 | **Odoo** | La más grande (7.879 líneas) y la que toca facturación: va última, con todo lo aprendido | 23 |

`Integraciones.tsx` (el índice del módulo) se rehace al final, cuando se sepa qué tarjetas quedan.

## Paso 3 — Los tres interruptores

`holding_integration_settings` ya existe. Falta:

- En la **configuración de cada integración**, un switch "Integración automática habilitada" para el holding
  activo — que es como lo pidió Leon.
- Endpoints de lectura y escritura del flag, acotados con `HoldingScopeGuard`.
- Que los crons de Salesforce y BigQuery lo respeten, como ya lo hace el de facturas a Odoo.
- Dejar claro en la UI que **el flag apaga solo la corrida automática**: el disparo manual sigue disponible.

## Paso 4 — Mejoras de UX

El encargo explícito es **no portar las pantallas tal cual**. Lo que hay que relevar y rediseñar:

- **Procesos largos sin feedback honesto.** El módulo dispara corridas que tardan minutos (import de
  oportunidades, procesamiento de facturas, sync de Stripe). Hoy el feedback vive en diálogos con un socket que
  pinta cualquier evento que llegue si no hay job propio en curso. Necesita un patrón único de "trabajo en
  curso" reutilizable: progreso, cancelación, resultado y enlace al historial.
- **Tablas de staging.** Son el corazón del módulo y hoy son tablas largas sin filtros consistentes ni acciones
  masivas claras. Unificar con el estándar de tablas del front nuevo (columnas de dinero, scroll horizontal,
  orden y filtros persistentes).
- **Mapeos masivos.** Cuatro pantallas distintas (productos, clientes, tipos de cotización, campos) resuelven el
  mismo problema con cuatro UIs. Un solo componente de mapeo, parametrizado.
- **Diagnóstico de conexión.** `OdooDiagnosticTool` son 1.064 líneas de herramienta interna. Decidir si es
  producto o herramienta de soporte, y en ese caso sacarla de la pantalla del cliente.
- **Estados de carga y error.** Hoy hay componentes que consultan sin esperar al holding (`StripeProductMapping`,
  `useSalesforceSync`) y errores que se pierden en `console.error`. El front nuevo ya tiene el contrato de
  errores de la BFF (`message` estable) y `enabled` por holding.
- **El índice del módulo**: hoy `Integraciones.tsx` es una grilla de tarjetas sin estado. Debería mostrar, por
  integración, si está conectada, si la automática está habilitada y cuándo corrió por última vez.

Los mockups salen de Claude Design, como el resto de la Fase 2.

## Riesgos y cosas que romper con cuidado

- **`holdingStore` del front legacy** ya se hidrata desde `sessionStorage` (27-09), lo que cubre las recargas.
  Quedan consumidores sin `enabled`: `StripeProductMapping` y `useSalesforceSync`.
- **Bug preexistente**: `invoiceSchedulerService.getJobStatus`/`getRecentJobs` del front legacy pasan
  `{ useSupabaseAuth: true }` en la posición del argumento `params`, así que mandan `?useSupabaseAuth=true` **sin**
  `Authorization`. Hoy ya deberían fallar; con el guard fallarían más ruidosamente.
- **`GET /invoices/scheduler/jobs` está huérfano** en el front legacy: nadie lo llama. Candidato a retirar.
- **Websockets**: `InvoiceSchedulerGateway` y `NotificationsGateway` emiten a `user:<id>` y no validan holding.
  Si el rediseño del feedback de procesos largos pasa por socket, hay que endurecerlos primero.

## Qué queda en el front legacy mientras tanto

Cada integración migrada se marca `migrated: true` en `lib/app-links.ts` y deja de enlazarse al origen legacy.
Hasta entonces convive: el sidebar del front nuevo ya enlaza el módulo como externo.

## Estimación

No hay estimación en horas hasta cerrar el Paso 0, porque el tamaño real depende de cuánto código resulte
muerto y de cuántas escrituras directas a Supabase haya que convertir en endpoints. El orden de magnitud es
**semanas**, y el Paso 0 más el Paso 1 (tenancy) son la mitad del trabajo aunque no muevan un píxel.
