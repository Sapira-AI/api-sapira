# Lógica de negocio en la API; triggers solo invariantes

> Regla de Domi (30-09-2026). Aplica a todo lo que v2 escribe en el esquema compartido con el front viejo (`sapira-ai`):
> Contratos, Facturas, Cotizaciones, Pricing v2 y Consumos. Construcción y prueba: [`activacion-costura-triggers.md`](../v2-rediseno/activacion-costura-triggers.md).

## La regla

1. **La lógica de negocio vive en la API.** Todo valor que v2 guarda lo calcula y lo escribe la API, explícito, en la misma
   transacción: precios derivados, fechas, categorías, monedas y tipos de cambio, grupo y condiciones de factura, plazo del
   contrato, RSM (`revenue_schedule_rebuild` explícito) e historial (eventos en `contract_lifecycle_events`).
2. **Postgres conserva solo invariantes**: reglas que ningún escritor puede violar, con su propio bypass explícito y auditado si
   existe. Hoy: el guard de período (`trg_00_period_guard_contracts`, `trg_00_period_guard_contract_items`), los validadores de
   moneda (`validate_contract_currency_trigger`, `validate_contract_item_currency_trigger`) y el fin de un contrato activo
   (`prevent_end_date_update_when_active`, bypass `sapira.bypass_end_date_guard` + evento). Un invariante **no** lee la marca.
3. **Toda transacción v2 que escribe fija `sapira.writer = 'api'` como primera sentencia**, con `setApiWriter(runner)` (o
   `withApiWriter(dataSource, work)` para una escritura suelta) de `src/modules/contracts/api-writer.ts`. Nunca `set_config`
   a mano y nunca una escritura v2 en autocommit: la marca es local a la transacción.
4. **Cada trigger legacy que rellena o pisa datos empieza con el guard**, como primera sentencia de su función:
   ```sql
   IF current_setting('sapira.writer', true) = 'api' THEN
     RETURN NEW;   -- BEFORE; en AFTER: RETURN NULL (el valor se ignora)
   END IF;
   ```
   El front viejo nunca fija la marca: para él el trigger sigue igual. Así conviven los dos fronts sin tocar su comportamiento.

## Al escribir código v2

- Si una columna la rellenaba un trigger, la API la escribe explícita (`api-written-fields.ts`: `pricingFields`,
  `refreshInvoiceSystemAmounts`, `refreshContractSystemFx`, `mirrorInvoiceSystemAmounts`, `syncContractTerm`, `itemCategoriaSql`,
  `invoiceTermsSql`) con la **regla correcta**: la del trigger cuando no tiene bugs, la regla v2 decidida cuando el trigger tenía un
  bug documentado. **Nunca se replica un bug "por paridad"** (Domi 30-09): los fronts no conviven por módulo (el viejo se retira
  con redirect al salir el nuevo); la diferencia se anota en "Cambia respecto del front viejo" de
  [`activacion-campos-api.md`](../v2-rediseno/activacion-campos-api.md), y si los docs no fijan la regla va a "Pendientes" ahí.
  La aritmética de dinero puede ir en SQL (`ROUND` numérico), pero la decisión (qué tasa, en qué sentido, cuándo) es de la API.
- Nada de "patrón B" (insertar sin la FK y corregir con un UPDATE para esquivar un trigger): con la marca el trigger no corre.
- Un trigger nuevo solo si es un invariante. Si hace falta lógica al escribir, va en la API.
- Si aparece un trigger legacy que todavía corre para la API y pisa datos, se le agrega el guard (asset editado en su lugar,
  `postgres:assets --apply --only …`) y la API escribe el campo; se anota en `activacion-costura-triggers.md`.

## Cómo se verifica

- `src/modules/contracts/api-written-fields.spec.ts`: después de cada `startTransaction()` de un `*.service.ts` de `contracts` y
  `quotes`, la primera sentencia es `setApiWriter(runner)`; ningún servicio escribe por `this.dataSource.query` ni fija la marca a mano;
  cálculos de cada campo (réplicas y reglas v2, con la regla v2 nombrada en el test).
- `src/databases/postgresql/costura-sapira-writer.spec.ts`: el guard es la primera sentencia de cada función de la lista (NEW en
  BEFORE, NULL en AFTER), aparece solo en ellas y los invariantes no lo tienen.

## Retiro

Cuando el front viejo se apague, los triggers con el guard se eliminan (migración con `DROP` + borrar el asset, doble
confirmación); los invariantes quedan.

Un trigger puede salir antes si Domi lo ordena, siempre que todo escritor que dependía de él lo haga explícito en la API:

- **04-10-2026 · devengo sobre `quantities`** (`trg_rsm_on_quantity_change`, `trg_restore_rsm_on_quantity_delete` y sus
  funciones; migración `1791300000000-RetiraTriggersDevengoQuantities`). Motivo: corrección de datos sin que lógica en desuso la
  pise. El único escritor de la API sin la marca (sync del DWH, `bigquery.service.ts`) llama ahora `revenue_schedule_rebuild`;
  los consumos v2 ya lo hacían. El front viejo deja de mover el devengo al editar cantidades. Los otros 4 triggers de
  `quantities` siguen (ninguno escribe devengo).
