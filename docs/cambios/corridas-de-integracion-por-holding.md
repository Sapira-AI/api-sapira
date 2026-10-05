# Cambio: el envío automático de facturas crea una corrida por holding

> **Rama:** `leon` · 27-09-2026 · Leon + Claude
> **Repo front (par):** `front-sapira` — etiqueta de las corridas históricas en el reporte de integración.
> **Regla de tenancy:** [`docs/v2-rediseno/autorizacion-y-tenancy.md`](../v2-rediseno/autorizacion-y-tenancy.md)

## Contexto

El cron nocturno llamaba `createSystemSchedulerJob({ dryRun: false })` **sin holding**, así que creaba **un
solo job por noche** guardado como `holdingId: 'all'`, con las facturas de todos los clientes en el mismo
documento. El 26-09 eso se resolvió en la *lectura* (el reporte recorta esas corridas al holding activo);
esta tanda lo resuelve en el *origen*: una corrida por holding, individualizada.

Y con ella, el interruptor que no existía: hasta ahora no había forma de apagar la integración de un
holding. `company_holdings` no tiene columnas de estado, `holding_settings` solo guarda moneda y FX, y
`odoo_connections.is_active` gobierna otras funciones de Odoo pero **el envío de facturas nunca la
consulta**. La única salida era desmapear las razones sociales del holding.

## Qué cambia

| | Antes | Ahora |
|---|---|---|
| Jobs por noche | 1, con `holdingId: 'all'` | 1 por holding con facturas pendientes, con su `holdingId` real |
| Un holding que falla | Mataba el envío de todos (un `throw` cortaba la corrida) | Cierra su job con error y el bucle sigue con los demás |
| Apagar un holding | Imposible sin desmapear sus razones sociales | `holding_integration_settings.auto_enabled = false` |
| Correo de errores | 1 por noche, con los errores de todos los holdings juntos | 1 por holding con errores, con su nombre en el asunto |
| `progress` de cada corrida | Totales de todos los holdings | Totales del holding |
| Columna Holding del reporte | `all` | El nombre del holding; las históricas, "Todos los holdings" |

**Lo que no cambia**: el conjunto de facturas que se procesa cada noche es el mismo, y el **envío manual**
no mira el flag a propósito — queda como válvula de escape de un holding apagado.

## La tabla nueva

`holding_integration_settings` (entity `HoldingIntegrationSettings`, migración
`1790400000000-CreateHoldingIntegrationSettings`): PK compuesta `(holding_id, integration)` con
`integration` acotado por CHECK a `odoo | salesforce | bigquery`, y `auto_enabled boolean default true`.

**Fila ausente = habilitado.** Todo se lee con `COALESCE(auto_enabled, true)`, así que la tabla nace vacía,
no hizo falta backfill y **ningún holding cambia de comportamiento al aplicar la migración**. Solo se
inserta la fila al apagar o volver a prender.

`salesforce` y `bigquery` quedan declarados pero todavía no los respeta ningún cron: sus interruptores
llegan con la migración del módulo Integraciones al front nuevo, que es donde vivirá la UI
([`plan-migracion-integraciones.md`](../v2-rediseno/plan-migracion-integraciones.md)).

Solo la usa la API: RLS activo con una única policy para `service_role`
(`rls/holding_integration_settings_service_role.sql`), sin grants al Data API.

## Cómo apagar y prender un holding, mientras no haya UI

```sql
-- Apagar el envío automático de facturas de un holding
INSERT INTO holding_integration_settings (holding_id, integration, auto_enabled)
VALUES ('<holding-uuid>', 'odoo', false)
ON CONFLICT (holding_id, integration) DO UPDATE SET auto_enabled = false, updated_at = now();

-- Volver a prenderlo
UPDATE holding_integration_settings SET auto_enabled = true, updated_at = now()
WHERE holding_id = '<holding-uuid>' AND integration = 'odoo';

-- Ver el estado (los holdings sin fila están habilitados)
SELECT ch.name, COALESCE(his.auto_enabled, true) AS habilitado
FROM company_holdings ch
LEFT JOIN holding_integration_settings his ON his.holding_id = ch.id AND his.integration = 'odoo'
ORDER BY ch.name;
```

## ⚠️ Orden de despliegue

1. **La migración va primero**, antes de desplegar el código. Al revés, TypeORM seleccionaría una tabla
   inexistente en cada arranque. Procedimiento: `yarn schema:status --target qa`, migración, `schema:status`
   de nuevo; recién entonces producción.
2. Después el código de `api-sapira`.
3. El cambio de `front-sapira` (etiqueta del reporte) es independiente y puede ir en cualquier momento.

## Qué se toca

- `src/modules/invoices/invoice-scheduler.scheduler.ts`: bucle por holding con `try/catch` por iteración,
  en un privado `runForHolding`.
- `src/modules/invoices/invoice-scheduler.service.ts`: `pendingInvoicesQuery()` privado con los filtros
  compartidos; `getHoldingIdsWithPendingInvoices()` nuevo (aplica el flag); `getInvoicesToSend` sin cambios
  de comportamiento; `getHoldingName()` para el asunto del correo. El JSDoc de `getJobsReport` explica que
  sus ramas de `'all'` ahora son el camino del histórico, no el normal, y **no se pueden simplificar**
  mientras queden jobs `'all'` en Mongo.
- `src/modules/invoices/invoice-notification.service.ts`: el holding va en el asunto del correo.
- `front-sapira`: helper `holdingLabel` en la página del reporte.

## Tests

El cron **no tenía ningún spec**; ahora sí.

- `invoice-scheduler.scheduler.spec.ts` (8): una corrida por holding acotada a su holding, cada job cerrado
  con su resultado, un holding que falla no aborta los siguientes, sin pendientes no crea corridas, y el
  respeto de hora, flag de configuración y candado `isRunning`.
- `invoice-scheduler.pending-holdings.spec.ts` (5): excluye los holdings apagados, conserva los filtros de
  facturas por emitir, y **el envío manual no mira el flag**.
- `invoice-scheduler.report.spec.ts` y el resto de `src/modules/invoices` siguen en verde sin cambios.

`yarn jest` → 76 suites, 963 tests. En `front-sapira`, `yarn test` → 74 archivos, 263 tests.

## Pendientes que deja

1. **La UI del interruptor**: llega con la migración de Integraciones, junto a los de Salesforce y BigQuery.
2. **Los `'all'` históricos** quedan en Mongo y el pipeline del reporte tiene que seguir soportándolos.
3. `salesforce` y `bigquery` están declarados en la tabla pero sus crons todavía no los leen.
