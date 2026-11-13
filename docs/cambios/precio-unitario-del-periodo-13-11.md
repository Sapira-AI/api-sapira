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
