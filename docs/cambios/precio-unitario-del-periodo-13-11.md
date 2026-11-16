# Precio unitario del período en el consumo (Ransa / SimpliRoute, 13-11)

Pedido de soporte del 09 al 11-11 (Carelis, Ransa) y decisión de Domi del 13-11. Es el punto A del pedido; el reparto de una
cotización entre varios contratos (B) y el precio regional por tramos (C) quedan pendientes.

## Qué pasaba

Ransa tiene cuatro contratos por país bajo el mismo cliente comercial (CTR-2026-412 Guatemala, CTR-2026-82 Perú,
CTR-2026-82-CHILE y CTR-2026-Salvador), todos con PATHFINDER+ en precio **Estándar por consumo** (cantidad × precio). El precio
unitario cambia cada mes (may 19,9162 · jun 21,2202 · jul 21,6849 · ago 20,1412) y no sigue una regla de tramos.

-   El consumo aceptaba solo la cantidad: el unitario salía siempre del precio del contrato.
-   Para cambiarlo había que editar la factura a mano. La línea quedaba como editada a mano y, si después se corregía el
    consumo, el precio no se recalculaba junto con la cantidad.
-   Hasta el 10-10 se usaba el monto final (`amount_override`), retirado el 12-10. En el front anterior la tabla `quantities`
    tenía precio unitario; la copia a `consumption_entries` del 05-10 lo convirtió a monto final.

## Cómo queda

En un ítem de precio Estándar por consumo, el consumo del período lleva **cantidad y, opcionalmente, precio unitario**.

-   Sin unitario: cantidad × el unitario del precio del ítem, como siempre.
-   Con unitario: la línea del período queda en cantidad × ese unitario. Unidades gratis, descuento del ítem, mínimo y tope
    siguen aplicando. La línea muestra el unitario que se escribió (20,1412), no subtotal ÷ cantidad.
-   Corregir: se pueden cambiar los dos. Si la corrección trae solo la cantidad, el unitario del período se conserva. Con
    `unit_price: null` el período vuelve al unitario del precio. El motivo sigue siendo obligatorio desde la revisión 2.
-   Un unitario igual al del precio se guarda como NULL: no es un precio propio del período y sigue al precio del ítem.
-   Con la factura emitida aplican los mismos modos de siempre (`additional` o `reissue`).
-   Carga masiva: la fila acepta `unit_price`. El almacén de datos sigue informando solo la cantidad y no pisa un unitario
    puesto a mano; su comparación usa el unitario informado.
-   Otros modelos (tramos, volumen, paquete, asiento): `unit_price` con valor responde 400 en ese campo.
-   Un cambio de contrato (precio nuevo, corregir un dato mal cargado) no reescribe el unitario informado de un período.
-   El plan esperado de "Editar factura" incluye el unitario informado: no aparece un desvío falso.
-   Devengo y MRR no cambian de regla: el devengo del mes con consumo es lo facturado; el MRR es el del contrato.

No hay modelo de precio nuevo, ni cambios en el envío al ERP, ni en el cálculo del MRR.

## Esquema

Migración `1792520000000-ConsumptionUnitPrice`:

-   `consumption_entries.unit_price numeric(18,6)` nula, con CHECK `consumption_entries_unit_price_check` (NULL o ≥ 0).
-   `consumption_entry_revisions.unit_price numeric(18,6)` nula.

Sin datos: todas las filas existentes quedan en NULL. Asset: `functions/revenue_schedule_rebuild_contract_ccy.sql` (el
respaldo sin línea viva usa `COALESCE(e.unit_price, v_item.unit_price)`).

**Orden de despliegue:** migración, después el asset, después el código. El código lee `e.unit_price` en cada consulta de
consumos.

## Archivos

-   `pricing-engine.ts`: `ConsumptionInput.unit_price`, `ResolvedQuantity.unit_price`, `PriceLineOptions.unit_price`; el caso
    `standard` de `priceLine` usa el unitario del período.
-   `consumption.service.ts`: `periodUnitPrice` (regla de conservar, limpiar y normalizar), escritura de la entry y su revisión,
    `priceFor`, lecturas, carga masiva, evento (`unit_price`, `previous_unit_price`) y vista del almacén de datos.
-   `dtos/consumption.dto.ts`: `unit_price` en el registro individual y en la fila masiva.
-   `billing-engine.ts`, `contract-activation.service.ts`, `contract-drafts.service.ts`, `contract-invoice-edit.service.ts`,
    `contract-changes.service.ts`, `contract-changes.ts`, `contract-360.ts`: el unitario viaja con el consumo.

## Impacto

-   **Quién más lo usa:** todo lo que lee `consumption_entries` (lista de arriba). El motor de precios lo ignora fuera del
    modelo `standard`.
-   **Registros reales (prod, solo lectura, 13-11):** 138 precios Estándar por consumo activos, 1 por tramos y 1 por volumen.
    434 consumos, 83 con monto final antiguo. Ninguno cambia: la columna nace en NULL.
-   **Tests:** `pricing-engine.spec`, `consumption.service.spec` (registrar, conservar, corregir ambos, limpiar, normalizar,
    rechazo en tramos, masiva, almacén de datos), `contract-changes.spec` (`repriceConsumptionLine`),
    `contract-activation.service.spec` (`consumptionOf`), `pricing-v2.entity.spec`, `contract-modifications-block2.spec`.
-   **Docs:** `spec-pricing-v2.md` §2.3 y §6; en el front, ayuda de Consumos y una novedad.

## Después del deploy (soporte)

Los datos de Ransa no se tocan desde el código. Soporte registra cada mes cantidad y unitario regional en los cuatro
contratos. Chile deja de usar cantidad 1 con el monto como precio. Los borradores de septiembre y octubre de CTR-2026-412 ya
están en el ERP a cantidad base: al registrar el consumo, la factura queda marcada con el aviso de borrador desactualizado.

## Pendiente: B y C del pedido de Ransa (solo esquema, sin plan por archivo ni OK)

Estado en [`ROADMAP-OPERATIVO.md`](../ROADMAP-OPERATIVO.md) → "Pendientes del sistema nuevo" (R1 a R4).

**Contexto verificado en producción (solo lectura, 11-11 y 13-11).** Los cuatro contratos están bajo el cliente "Ransa PE", todos
PATHFINDER+ estándar por consumo, métrica `vehiculos`, Vencido mensual: CTR-2026-412 (GT), CTR-2026-82 (PE), CTR-2026-82-CHILE (CL) y
CTR-2026-Salvador (SV). Consumos al 13-11: 412 tiene 1; 82 tiene 8 (6 con el monto final antiguo); Chile 6 (6); Salvador 5 (4). Chile
registraba cantidad 1 con el monto como precio; Perú septiembre tenía 190 con la factura editada a mano a 19,6709. La cotización de
despliegue (006RO00000czmEjYAI) trae cuatro líneas por tramo (102 a 15, 58 a 22, 150 a 20, 200 a 17) y `price_list_type: Progresiva`.
El scheduler corre todos los días a las 9 y envía toda Por Emitir del mes con fecha cumplida, sin mirar si el consumo está pendiente
(`quantity_source = 'pending'` existe en la línea y nadie lo lee).

**Fuera de A por decisión de Domi (13-11), no reabrir sin pedido:** modelo nuevo `per_period`, retención en el scheduler de facturas con
consumo pendiente, cambio de la regla de MRR, bloqueo del unitario en Editar factura.

### B · Repartir una cotización entre varios contratos del mismo cliente

- API: `POST /quotes/:id/apply-split` con `[{contract_id, lines:[{quote_item_id, quantity}]}]`. `quote-contract-targets.ts` deja de
  bloquear por `contract_created` cuando queda cantidad pendiente. `contract-changes.service.ts` registra `quote_items` con la cantidad
  asignada en el evento de cada contrato y los enlaza entre sí (`metadata.split_group`). Vista previa que corre `planChanges` por
  contrato y un solo apply transaccional (un `lockContract` por contrato, en orden de id).
- Esquema (migración, según la guía): `quotes.salesforce_account_id` y `quotes.salesforce_account_country`. Hoy el SOQL de
  oportunidades no trae `Cuenta_SR__c` ni `Country__c` (trae `Account.BillingCountry` y `DemoCountry__c`) y las cotizaciones no guardan
  la cuenta. Campo configurable en `salesforce-field-mapping-defaults.ts`; el reparto por país queda manual en el front.
- Front: paso "Repartir" en `AsociarAContratoDrawer` (varios contratos, cantidad por línea; el flujo se llama **Asociar a contrato**),
  estado "Aplicada parcialmente" en Cotización 360, ayuda `cotizaciones/de-la-cotizacion-al-contrato.md`.
- Tests: 47 licencias en 30 + 17, bloqueo por contrato, cotización parcialmente aplicada.
- Base que ya existe (Brightcell 6): cotización aplicada por línea (`applied_quote_item_ids`, `quote_partially_applied`).

### C · Grupo de precio regional por tramos sobre varios contratos

- Tablas `price_groups` (holding, cliente, métrica, modelo `graduated`/`volume`, tramos, moneda; RLS y policies desde el inicio) y
  `price_group_items` (`contract_item_id`). Al informar la cantidad de cualquier ítem del grupo, `consumption.service` suma el período
  del grupo, calcula el monto regional con `priceLine` y el unitario efectivo, y recalcula las Por Emitir de todos los contratos
  (emitidas: aviso y `additional`/`reissue`). El desglose va en `pricing_breakdown` (total regional, tramo, unitario efectivo, cantidad
  propia).
- Front: Precios › grupo de precio, desglose en Consumos y en la vista rápida de la factura, ayuda `contratos/precio-regional.md`.
- Tests: grupo de tres contratos, recálculo cruzado, caso con una emitida.
