# Cambio: el scheduler de agentes vuelve a existir, y el módulo pasa a `HoldingScopeGuard`

> **Rama:** `leon` · 04-10-2026 · Leon + Claude
> **Repo front (par):** `front-sapira-vite` — `userHoldingId` del `HoldingContext` y el BCC de dos edge functions.
> **Roadmap:** [`docs/v2-rediseno/roadmap-cuatro-frentes.md`](../v2-rediseno/roadmap-cuatro-frentes.md), frente 2.

## Contexto

Primer paso del frente de automatizaciones. Antes de construir el flujo de proforma y cobranza había que
hacer que lo ya escrito pudiera correr: los processors de `proforma` y `collections` existen desde hace
meses y **nunca se ejecutaron**, y el módulo tomaba el holding sin validar pertenencia.

## El bug que impedía toda ejecución automática

```
agents.service.ts      runAgent(agentId, mode, holdingId)
agents.scheduler.ts    runAgent(agent.id, agent.holding_id, 'execute')   ← argumentos invertidos
agents.controller.ts   runAgent(agentId, dto.mode, holdingId)            ← correcto
```

El scheduler pasaba el holding en la posición del modo. Eso llegaba a `getAgent(agentId, 'execute')` →
`WHERE holding_id = 'execute'` → Postgres rechaza el UUID → el `catch` del bucle se lo comía. **Fallaba en
silencio cada minuto desde que existe el scheduler.**

TypeScript no lo detectaba porque la consulta devolvía `Promise<any[]>`: `agent.holding_id` era `any` y por
lo tanto asignable al union `'preview' | 'execute'`. Ahora la fila está tipada (`ScheduledAgentRow`), así que
el compilador lo habría impedido — se verificó introduciendo el tipo antes de corregir el orden, y el error
apareció solo.

Lo corroboraba la base: `ai_runs` y `ai_messages` con **0 filas**.

## Qué cambia al desplegar: nada todavía ✔

Medido en producción el 04-10: hay **14 agentes** (`proforma` y `collections` por holding, 7 holdings), todos
con `is_enabled = true` pero **`auto_execute = false`**, y todos con `require_approval = true`.

```sql
SELECT count(*) FROM ai_agents WHERE is_enabled = true AND auto_execute = true AND schedule IS NOT NULL;
-- 0
```

Así que **ningún agente arranca solo al desplegar esto**. Prender `auto_execute` en uno queda como acto
deliberado, y además la aprobación manual sigue de por medio. Es la forma segura de estrenarlo: encender uno
en un holding, en modo preview, y mirar su `ai_run`.

## Tenancy del módulo

| Antes | Ahora |
|---|---|
| `@UseGuards(SupabaseAuthGuard)` y el holding desde `dto.holding_id`, `@Query('holding_id')` o `user.holding_id` | `@UseGuards(SupabaseAuthGuard, HoldingScopeGuard)` y `@HoldingId()` en los 10 endpoints |
| Cualquier sesión podía operar sobre los agentes de otro holding | 400 sin header, 403 si no pertenece, 403 si el body o la query traen otro holding |

`holding_id` quedó **opcional y `deprecated`** en `ApproveRunDto`, `RunAgentDto`, `CreateClientAgentConfigDto`
y `UpdateClientAgentConfigDto`: el front actual todavía lo manda, el guard exige que coincida con el header y
el servicio lo ignora. No se puede borrar el campo porque `forbidNonWhitelisted: true` lo convertiría en 400.

De paso salieron dos `console.log` de depuración de `approveRun`.

## El prerequisito en el front actual

El guard habría respondido **403 a los 8 endpoints de agentes** en cuanto alguien cambiara de holding:
`userHoldingId` del `HoldingContext` solo se asignaba en la carga inicial y `setSelectedHoldingId` no lo
tocaba, así que el `holding_id` del body quedaba con el holding viejo mientras el header ya tenía el nuevo.

Arreglado en `front-sapira-vite/src/contexts/HoldingContext.tsx`: `setSelectedHoldingId` ahora también
actualiza `userHoldingId`. Era el riesgo que anticipaba el inventario de la Fase 2.

## El BCC que nunca se aplicó

`send-proforma` y `send-collection` leían `settings?.email_bcc`, pero la columna de
`invoice_collection_settings` se llama **`bcc`**. Como el `select` trae `*`, el campo llegaba siempre
`undefined` y **el BCC configurado no se aplicaba a ningún correo**. Corregido en las dos.

## Tests

El módulo `agents` **no tenía ninguno**. Ahora:

- `agents.scheduler.spec.ts` (6): el primero fija el **orden de los argumentos** —es la regresión de este
  bug—, y el resto cubre sin agentes programados, cron que no corresponde, cron mal formado, aislamiento de
  fallos entre agentes, y los filtros de la consulta.
- `agents.controller.spec.ts` (8): los tres casos obligatorios de tenancy más el `holding_id` deprecado que
  coincide, el que no coincide (body y query), y que las consultas de configuración también usen el header.

`yarn jest` → 82 suites, 1031 tests en verde cuando se escribió esto. Tras el merge de `qa` del 05-10 (que trae la fase 2 de notificaciones y el módulo `integrations`): **214 suites, 3301 tests**, también en verde.

## Lo que sigue en este frente

Del roadmap, lo que no depende de decisiones: cerrar el puente entre "factura vencida" y el primer correo de
cobranza (el cron ya corre y marca vencidas, pero nada dispara el aviso). **La decisión del proveedor ya se tomó
(Leon, 04-10): solo API — processors y SendGrid, y las edge functions se retiran.** Y `deal_validation` sigue ofreciéndose en la
UI sin processor: hoy un agente de ese tipo se crea, se "ejecuta" y no hace nada.
