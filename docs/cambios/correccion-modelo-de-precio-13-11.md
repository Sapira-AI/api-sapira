# Corregir el modelo de precio mal cargado y Expansión sin ítem base (13-11)

Caso: SimpliRoute, CTR-2026-425Bolivia (Ransa Bolivia). Único ítem PATHFINDER+ 8 × 19 USD, categoría UPSELL (Expansión) **sin**
`related_item_id` y sin modelo de precio, creado el 13-11 con cantidad fija cuando era por consumo. Sus 12 facturas están Por Emitir.

## Bug 1 · el front ocultaba una Expansión sin ítem base

`priceModelItems` (front) descartaba todo UPSELL / DOWNSELL / CHURN por categoría: "Cambiar el modelo de precio" y "Cambió cuándo se
factura" decían que el contrato no tenía productos. Regla nueva (`isAdjustmentItem`), igual a la de la API (`DELTA_CATEGORIES` +
`related_item_id`): solo se ocultan los ajustes que cuelgan de otro ítem y las bajas. `planItemAdd` usa el mismo criterio al buscar el
ítem relacionado del mismo producto (antes ignoraba un UPSELL sin ítem base).

## Bug 2 · no se podía corregir el modelo desde el inicio del ítem

`price_model_change` corta en `nextPeriodStart` (> inicio del ítem): con fecha efectiva igual al inicio, el primer período quedaba con el
modelo anterior. Ahora `item_update` acepta `price` (`planPriceModelCorrection`):

`{ type: 'item_update', items: [{ item_id, price, billing_method?, quantity?, discount_value? }] }` (un ítem, sin otros datos en el mismo paso).

| Qué | Cómo |
|---|---|
| Ítem | Se reescribe en su lugar (`update_item`: cantidad, unitario, mensual, valor, `billing_method`): sin RENEWAL, misma `categoria` y `booking_date` |
| Precio | `set_item_price`: fila nueva en `prices` (owner contract), versión 1 o la siguiente con `supersedes_price_id` |
| Por Emitir | Se quitan todas las líneas del ítem (también las editadas a mano: aviso `manual_edit_replaced`) y el generador las rehace con el modelo nuevo y el consumo ya registrado, fundidas en la misma factura aunque su fecha de emisión ya pasó (`mergeIntoPast`) |
| MRR / RSM | MRR = modelo nuevo a la cantidad base; devengo reconstruido desde el inicio del ítem |
| Evento | `ITEM_CORRECTED` subtipo `price_model`, `metadata.price_model` |

Pasar a consumo exige cobro Vencido, salvo asiento. Bloqueos: `issued_invoices_for_item` (ya hay emitidas: decisión por defecto, lo
emitido no se corrige así; va `price_model_change` desde el período siguiente), `item_with_adjustments`, `partial_billing_invoice`,
consumos registrados con modelo de cantidad fija, `period_closed`, ítem con baja o ya renovado.

## Impacto

1. **Quién más lo usa.** `planItemUpdate` deriva al camino nuevo solo si un ítem del pedido trae `price`; el resto de las correcciones no
   cambia. `loadContext` ahora carga las métricas del pedido también en `item_update`. `mergeTarget` conserva su regla salvo con
   `mergeIntoPast` (solo la corrección). `update_item` acepta `billing_method`. `planItemAdd`: cambia qué ítem cuenta como relacionado
   cuando el producto existe solo como UPSELL sin ítem base.
2. **Registros reales** (producción, solo lectura, 13-11). Simulación del plan sobre CTR-2026-425Bolivia a consumo estándar (Vehículos, 19):
   sin bloqueos, 12 líneas quitadas y 12 rehechas en sus mismas facturas (marzo 2026 a febrero 2027, "consumo por informar"), ninguna
   factura cancelada ni creada, MRR 152. No se migran datos: la corrección la aplica la usuaria desde el front tras el despliegue.
3. **Qué lo verifica.** `contract-price-model-correction.spec.ts` (Bolivia, vencido, emitidas, bloqueos), `contract-changes.service.spec.ts`
   (escritura y métrica), front `intenciones.test.ts` y `ModeloPrecioForm.test.tsx`.
4. **Doc.** Ayuda: `contratos/cambiar-el-modelo-de-precio.md` y `contratos/modificar-un-contrato.md`; README del módulo de contratos del front.

## Pendiente de decidir

- Con períodos ya emitidos hoy se bloquea. Alternativa: repartir la diferencia entre las Por Emitir, como las correcciones de valor.
- `planItemAdd` con el criterio nuevo no tiene test propio (lo cubre la suite existente sin regresiones).
