# Reemisión tras anular: copia exacta por línea (Domi 28-10)

Reporte: al anular con NC y "Reemitir corregida" la F101-00004417 de Alicorp (SimpliRoute, CTR-2026-55: contrato USD, factura PEN, tasa
fija 3,369 sin tasa vigente en el contrato desde julio), las líneas reemitidas quedaban con `subtotal_invoice_currency` igual al monto en
moneda de contrato (ASESORÍA 679,41 USD → 679,41 PEN en vez de 2.288,93) y la línea parcial de PATHFINDER+ (55,9573 unidades, 1.938,92 USD;
el resto del mes ya emitido en F101-00004398) se reemitía por el mensual completo del ítem (560 × 34,65 = 19.404).

## Qué encontramos

- **El editor copia exacto.** `planReissue` con el encabezado y las líneas reales de la factura (test de borrador, no commiteado) devuelve
  las dos líneas sin cambios: 679,41 → 2.288,93 PEN y 55,9573 × 34,65 = 1.938,92, también con la tasa del encabezado en NULL. Sin
  `reissue_changes` ninguna línea se recalcula desde `contract_items`; con cambios, solo la línea tocada.
- **Los dos valores del reporte los produce el trigger heredado `standardize_invoice_items`** (BEFORE INSERT en `invoice_items`): cuando la
  transacción no lleva la marca `sapira.writer = 'api'` reescribe cada línea con `quantity` y `unit_price` del ítem del contrato y deja
  `subtotal_invoice_currency := subtotal_contract_currency`. Son exactamente 19.404 y 679,41. El servicio real sí pone la marca
  (`ContractInvoiceVoidService.transaction` → `setApiWriter`), y las 4 reemisiones que existen en prod (FAC 028271, FE3533, FAC 028315,
  FAC 028370) salieron bien: sus diferencias contra la original son cambios pedidos en el editor o tasa manual. QA tiene la misma costura en
  el trigger y no tiene el caso Alicorp. Conclusión: la simulación insertó sin la marca. Regla vigente: toda escritura v2 va dentro de una
  transacción con `setApiWriter` (`docs/reglas-desarrollo/logica-en-api-triggers.md`).
- **Defectos reales, menores, en `writeReissue`:** la línea copiada tomaba la tasa del encabezado (`invoices.fx_contract_to_invoice`) y no
  la suya (`invoice_items.fx_contract_to_invoice`), `fx_rate_date` quedaba en la fecha de la reemisión y `quantity_source` pasa de NULL a
  `fixed`. En Alicorp no cambia ningún monto (ambas tasas son 3,369); cambiaría en una factura cuyas líneas tengan tasas distintas al
  encabezado (p. ej. tasa manual por línea o encabezado spot sin tasa).

## Qué cambia

- `contract-invoice-edit.service.ts` · `lineOf`: toda línea del editor trae `fx` y `fx_rate_source` propios (sin `currency`, así no entra
  en la rama multimoneda de `stateOf`; los estados y comparaciones del editor no cambian).
- `contract-invoice-void.service.ts` · `writeReissue`: una línea copiada sin cambios conserva su propia tasa; una editada lleva la del
  encabezado, con la que el editor la volvió a valorizar. Multimoneda sigue igual (tasa por línea del plan).
- `insertLineState`: `fx_rate_date` se copia de la línea origen cuando la tasa es la misma; si no, hoy. Lo usa también facturar por OC
  (`contract-invoice-partial-po.service.ts`, líneas de saldo con `source_line_id`): una línea de saldo con la misma tasa que su origen
  conserva la fecha de esa tasa, lo que es lo correcto.
- `quantity_source` de la copia sigue `fixed` (el valor que el editor escribe para toda línea sin origen); no se toca.

## Gap de flujo (pendiente de decisión de Domi)

Si se anuló **sin** reemitir, no hay cómo recuperar las líneas desde la anulada: "Editar" la Por Emitir y agregarlas bloquea con
`overlaps_issued`. `checkOverlap` (`invoice-edit.ts`) mide solape de **fechas** por ítem contra `issued_periods`, que ya excluye la
anulada (`CONTRACT_LINES_SQL` deja fuera Canceladas y las anuladas por NC); la que bloquea es la **otra** emitida del mismo ítem y período
(F101-00004398, que llevó el resto de septiembre). Una emisión parcial del mes cierra el mes entero. En soporte (27-10) se recuperaron las
asesorías editando la Por Emitir de octubre y quedó sin recuperar la parcial de PATHFINDER+.

Opciones:

- **A · "Reemitir" sobre una anulada sin reemisión.** `POST :id/invoices/:invoiceId/reissue(/preview)` que reutiliza `loadEditContext`
  + `planReissue` + `writeReissue` + traspaso de consumos + evento `INVOICE_REISSUED` (hoy viven dentro de `voidInvoice`; hay que
  extraerlos). Precondición propia: Cancelada por NC de anulación y sin reemisión activa. Front: acción en la factura anulada
  (`AnularFacturaDialog` / acciones de `_lib/facturas.ts`), BFF y schema. No toca la regla "las emitidas son ancla". **Recomendada.**
- **B · `overlaps_issued` por monto.** `IssuedPeriod` con `subtotal_contract_currency` y bloquear solo si lo emitido del (ítem, período)
  cubre lo esperado del plan; una emisión parcial deja pasar y `deviation` lo refleja. Cambia también Reorganizar (`invoice-reorganize.ts`).

## Impacto

- **Quién más lo usa.** `lineOf`/`loadLines`: editor de Por Emitir, reorganizar, facturar por OC, anular/NC de descuento (los campos nuevos
  son opcionales y `stateOf` los ignora sin `currency`). `insertLineState`: reemisión y líneas de saldo de facturar por OC. `writeReissue`:
  solo anular con reemisión.
- **Cuántos registros reales toca.** Ninguno se migra. Prod: 4 reemisiones, todas correctas; 8 líneas, una sola con tasa distinta a su
  origen por decisión manual (FAC 028315, 40.881,68 vs 40.950,90). 111 facturas Canceladas con NC de anulación y sin reemisión (conteo
  aproximado, solo lectura).
- **Qué lo verifica.** `invoice-void.spec.ts` → "copia exacta por línea (Alicorp 28-10)…" (línea parcial de 560 unidades y tasa propia
  con encabezado sin tasa; editar otra línea no toca la parcial). `contract-invoice-void.service.spec.ts` → "reemisión por línea (Alicorp
  28-10)…" (INSERT con la tasa de cada línea y copia de `fx_rate_date`). Suites de contratos e invoices en verde.
- **Qué doc cambia.** Esta nota; `fx-rate-sources.ts` ya decía "copia de la emitida" para `reissue` (ahora se cumple por línea). La
  opción elegida para el gap llevará su propia nota, centro de ayuda (Contratos › Anular y reemitir) y `flujo-y-funciones.md`.
