# Rebaja con fecha anterior a facturas emitidas: compensar en las próximas facturas (16-11)

Pedido de soporte del 13-11 (SimpliRoute, contrato S07212, México, MXN). Decisiones de Domi del 16-11. Construido en `domi` (API y front),
sin push ni deploy a la fecha de esta nota.

**Regla de fondo (Domi 16-11): no hay descuento.** Lo facturado de más en los períodos ya emitidos cubre parte de los períodos siguientes.
La factura que compensa sale con **menos cantidad** (baja de cantidad) o con **menor precio unitario** (baja de precio), y esa factura más
las ya emitidas suman el total con el ajuste. La primera versión del mismo día expresaba el ajuste como descuento de la línea (68,85 %):
se rehízo antes de subirla.

## El problema

- Una rebaja (`item_change` DOWNSELL) con fecha efectiva anterior a facturas ya emitidas bloqueaba con `issued_after_effective_date`: lo
  emitido se corregía con nota de crédito. Las usuarias no pueden anular facturas pagadas, sobre todo en México.
- Corregir un registro de baja (`item_update` sobre un ítem DOWNSELL) fallaba con "es el registro de una baja: su valor no se corrige".
- El aumento retroactivo ya funcionaba (`upsell_within_issued_period`) y **no se tocó**.

Caso real: PATHFINDER+ 76 × 627 desde el 01-08; el 02-09 se registró una baja de **1** licencia desde el 01-09 y eran **15**. Septiembre,
octubre y noviembre se emitieron con 75. Debe quedar en 61 desde el 01-09: se facturaron 14 licencias de más durante 3 meses = **42**
(26.334). Diciembre (única Por Emitir, el contrato termina el 31-12): 61 del período − 42 ya facturadas = **19 × 627 = 11.913**, sin
descuento; factura 11.913 + 3.800 + 4.500 = **20.213** más IVA. Comprobación: 3 × 75 × 627 + 19 × 627 = 4 meses × 61 × 627.

## Qué se construyó

### 1. Modo explícito en el pedido

`change.issued_overcharge`: `credit_note` (por defecto, **todo sigue como antes**: bloquea) o `compensate_next`. Vale en `item_change` y en
`item_update` sobre un registro de baja. La vista previa trae `issued_compensation_available: true` cuando la opción existe (rebaja sin
modelo de precio con fecha ≤ último día emitido del ítem madre), para que el front la ofrezca.

### 2. `compensate_next` en `item_change` (`planItemChange`)

- La baja nace con `start_date` = la **fecha efectiva real** (también a mitad de período, sin correr al próximo): contrato, ítems, MRR e
  historial quedan correctos desde ese día; `booking_date` = hoy; el devengo se reconstruye desde ese mes. Mes cerrado → `period_closed`.
- Las Por Emitir del producto desde esa fecha pasan a la línea neta nueva, como siempre.
- `compensateIssuedOvercharge` mide el cobro en exceso **por período emitido del ítem madre**:
  `min(ΔMRR × meses del tramo, emitido del grupo − lo que debió emitirse)`, nunca negativo. Los meses salen de `monthsBetween` (mismo
  prorrateo por días del motor); "emitido" descuenta las NC de descuento vigentes (`previously_credited`). Así un período que ya se emitió
  con la cantidad correcta (editado a mano antes de emitir) no se compensa dos veces.
- Cuenta como emitida una factura emitida vigente (no la unificada: sus líneas son copia) y el **origen de una unificada ya emitida**
  (`countsAsIssuedLine`). En este modo las unificadas se revisan desde el día siguiente a lo emitido (`unified_resync` si la Por Emitir
  destino está en una unificada editable; `unified_invoice_in_erp` si tiene borrador en el ERP).
- Destinos: las Por Emitir del **mismo producto** (el ítem y su cadena de renovación), en orden de período. Fuera: facturadas por OC,
  líneas por consumo, editadas a mano y las que ya llevan un descuento puntual. Reparto en orden: la línea absorbe hasta su neto; si no
  alcanza queda en 0 (cantidad 0) y el saldo pasa a la siguiente. Saldo que no cabe → bloqueo `compensation_exceeds_pending` con el monto y el
  paso siguiente (nota de crédito, o renovar/extender el contrato). **Nunca se reparte a otros productos.**
- Consumo registrado en un período emitido → bloqueo `compensation_not_supported`. Ítems con modelo de precio: no se ofrece el modo.
- Por factura destino: `invoice_adjustments` tipo `downsell` (monto negativo en moneda de contrato) y aviso
  `issued_overcharge_compensated`; línea que queda en 0 → aviso `compensation_line_zero`.
- Trazabilidad: `preview.issued_compensation[]` y `event.metadata.issued_compensation[]` con `{ item_id, product_name, currency, amount,
  issued[{ invoice_id, invoice_number, issue_date, period_start, period_end, issued, expected, overcharge }], compensated[{ invoice_id,
  …, line_before, amount, line_after, quantity_before, quantity_after, unit_price_before, unit_price_after }], pending_balance, mode }`.
  `mode` = `quantity` o `unit_price`.

### 3. Corregir la cantidad de una baja ya registrada (`planDownsellRecordCorrection`)

`item_update` con `quantity` sobre un ítem DOWNSELL: se reescribe **el mismo registro** (cantidad, `price`, `final_price`, mensual; misma
fecha de inicio y `booking_date`), el producto queda con la cantidad correcta desde la fecha de la baja y las Por Emitir del ítem madre
pasan a esa cantidad. Solo la cantidad, un registro por cambio y solo bajas de cantidad (el unitario del registro es el neto del ítem
madre). Con emitidas: baja mayor → mismo modo `compensate_next` (sin él, bloqueo `issued_after_effective_date` con el monto); baja menor →
bloqueo `issued_undercharge` (se registra como aumento, que factura su diferencia). Evento `ITEM_CORRECTED` subtipo `downsell_quantity`.

### 4. Cómo queda la línea que compensa (`overcharge-compensation.ts`)

Es una línea normal: `cantidad × unitario × (1 − descuento del ítem) = neto`. No se toca `discount_pct` y no hay líneas negativas.

| Rebaja | La línea que compensa | Ejemplo |
|---|---|---|
| De cantidad, al mismo precio (`mode: quantity`) | Menos cantidad, mismo unitario | 61 − 42 = 19 × 627 = 11.913 |
| De precio, o de cantidad y precio a la vez (`mode: unit_price`) | Misma cantidad, menor unitario | 10 × (70 − 30) = 400 |

`applyCompensation` reduce la cantidad (4 decimales, la precisión de `invoice_items.quantity`) o el unitario (6 decimales) en la
proporción `monto / neto de la línea`, y **el neto nuevo sale de la cantidad o el unitario ya redondeados**: Sapira y el ERP calculan lo
mismo. Con cuentas redondas es exacto; con prorrateo por días la cantidad queda con decimales (61 − 7,9333 = 53,0667) y la diferencia con
el monto medido es de centavos. Tope: el neto de la línea (cantidad 0, nunca negativa).

La línea lleva una **marca** en su `pricing_breakdown`, que vale 0 (no suma ni resta en ningún lector del desglose):

```json
{ "kind": "compensation", "quantity": 0, "amount": 0,
  "label": "61 del período menos 42 ya facturados en sep-nov 2026 (14 x 3)",
  "compensation": { "item_id": "…", "mode": "quantity", "base_quantity": 61, "base_unit_price": 627,
    "units": 42, "amount": 26334, "count": { "quantity": 14, "months": 3 },
    "periods": [{ "invoice_id": "…", "invoice_number": "A9986",
      "period_start": "2026-09-01", "period_end": "2026-09-30", "amount": 8778 }] } }
```

`base_quantity` / `base_unit_price` = lo que la línea valdría sin el ajuste; `units` = lo restado; `amount` = neto que deja de facturar.
La glosa cierra con ese texto sin tildes ("61 del periodo menos 42 ya facturados en sep-nov 2026 (14 x 3)", `DescriptionContext.note`;
se conserva al regenerar y al ajustar al límite del documento). En precio: "Precio del período 70 menos lo ya facturado de más en …".
La vista de la factura expone `lines[].compensation` (la marca con su `label`).

`withoutOneOff` quita del desglose las dos marcas de la línea (descuento puntual y compensación): lo que queda es lo que describe el precio.
Una línea nunca lleva las dos a la vez.

### 5. Protección: ningún cambio pisa el ajuste ni el descuento de una línea

`Planner` retira de las Por Emitir, mientras planifica, la compensación (`holdCompensation`: la línea vuelve en memoria a la cantidad y el
unitario del período) y el descuento puntual (`holdOneOff`), y los vuelve a aplicar al cierre sobre el valor final (`settleOneOffs` →
`settleCompensations`). La línea que nadie tocó queda igual, sin operación. Si el producto cambia después (por ejemplo baja a 5), la línea
queda en 5 − 3 ya facturadas = 2. Esto además corrige un error latente: una rebaja o un aumento posterior pisaba el neto de una línea con
descuento puntual sin reaplicarlo.

- La línea se quita → aviso `compensation_lost` con el monto.
- El valor nuevo no alcanza → se compensa lo que cabe y aviso `compensation_reduced` con el saldo (descuento puntual:
  `one_off_discount_reduced`).
- **Editar factura** (`invoice-edit.ts`): en la línea que compensa solo se edita la glosa. Cambiar cantidad, precio, descuento, período,
  agregarle un descuento puntual o quitarla bloquea con `compensation_line_protected` (paso siguiente: corregir la baja desde Modificar
  contrato). No pide tratamiento de devengo: no es un descuento.
- **Reorganizar**: la línea se puede mover, pero no se divide ni se re-monta (candado `compensation`, aviso `compensation_kept`).
- **Facturar por OC**: una factura con una línea que compensa no se factura por OC (`compensation_line_protected`).
- **Unificadas y NC espejo**: la copia lleva la misma cantidad y la misma marca que su origen.

### 6. Devengo

La baja desde su fecha real baja el ingreso de los meses emitidos; el mes de la factura que compensa devenga su valor completo (plan).
`revenue_schedule_rebuild_contract_ccy` (v3.9), en un mes con desvío (D2-c), suma de vuelta `compensation.amount` de la marca: la línea
salió con menos cantidad por lo facturado de más en **otros** períodos, no es menor ingreso del mes. `nc_discount_revenue_adjustment` no
cambia (la marca no es un descuento puntual).

Límite conocido: si un mes **emitido** tiene desvío (línea editada a mano o consumo), su devengo sigue siendo lo facturado de ese período
(no baja por la rebaja retroactiva). No hay casos hoy; anotado en el roadmap.

### 7. Envío al ERP

- La línea que compensa viaja **como cualquier otra**: cantidad × unitario, con el descuento del ítem si lo tiene. S07212: 19 × 627. No
  hay descuento alto ni unitario ajustado; la lógica de envío no cambia.
- Lo ya facturado cubre el período completo → la línea queda en cantidad 0 y no viaja, como toda línea en 0 (`itemsSentToErp`). Si
  compensa por precio queda con unitario 0 y tampoco viaja. Si es la única línea de la factura, viaja igual (regla de siempre).
- **Para Leon:** con prorrateo por días la cantidad lleva hasta 4 decimales (53,0667). Confirmar cuántos decimales de cantidad acepta el
  ERP; si redondea a menos, esa línea diferiría en centavos.

## Archivos

- `src/modules/contracts/overcharge-compensation.ts` (nuevo): `applyCompensation`, `compensationMarker`, `compensationOf`,
  `withoutCompensation`, `compensationLabel`, `compensationRange`, `compensationNote`.
- `src/modules/contracts/contract-changes.ts`: `Planner.holdCompensation/heldCompensation/addCompensation/settleCompensations`,
  `holdOneOff/heldOneOff/settleOneOffs`, `compensateIssuedOvercharge`, `countsAsIssuedLine`, `issuedFrontierOf`, `planItemChange`
  (modo), `planDownsellRecordCorrection`.
- `src/modules/contracts/one-off-discount.ts` (`withoutOneOff` quita las dos marcas), `pricing-engine.ts` (`BreakdownKind` suma
  `compensation`), `invoice-description.ts` (`note`), `contract-invoice-descriptions.service.ts`, `invoice-edit.ts`,
  `invoice-reorganize.ts`, `invoice-partial-po.ts`, `contracts.service.ts` (`lines[].compensation` en la vista de factura),
  `dtos/contract-changes.dto.ts` (`issued_overcharge`).
- `src/modules/invoices/invoice-scheduler.service.ts`: `isCompensatedLine`, `itemsSentToErp`.
- `src/databases/postgresql/functions/revenue_schedule_rebuild_contract_ccy.sql` (sin migración de tablas: se aplica como asset).

## Tests

`contract-issued-compensation.spec.ts` (24): anticipado, vencido, ítem con descuento, baja de precio, moneda de contrato ≠ factura, destino en unificada
(editable / con borrador en el ERP), emitida dentro de una unificada, consumo excluido, fecha a mitad de período, saldo mayor que un
período, períodos agotados, saldo que sigue en la renovación, baja corregida (con y sin modo, menor, validaciones), **S07212 con sus
cifras** (19 × 627) y la protección (reaplicar, reducir, perder, no tocar, descuento puntual). Además: `overcharge-compensation.spec.ts`
(cuentas, decimales, tope, textos y marca), `invoice-description.spec.ts`, `invoice-edit.spec.ts`, `invoice-scheduler.service.spec.ts`,
`contract-modifications-block2.spec.ts`.

## Despliegue

Sin migración. En QA y luego en producción (con OK): `yarn postgres:assets --apply --only functions/revenue_schedule_rebuild_contract_ccy.sql`.
No recalcula nada por sí sola. Producción: 0 líneas con descuento puntual y 37 registros de baja al 16-11. S07212 lo corrige la usuaria
desde la pantalla (Corregir un dato › la baja › 15 › Compensar en las próximas facturas); su factura de diciembre se emite sola el 01-12.

## Encontrado y no tocado

- **Rebaja sobre un ítem ya renovado** (función del 13-11): con Por Emitir de la renovación, la rebaja del ítem vigente **quita** las
  líneas de la renovación (el grupo incluye al sucesor) y la rebaja de la renovación parte un período después de su inicio. Reproducido
  con test, sin el modo nuevo. Queda en el roadmap (P5) para decidir y corregir.
