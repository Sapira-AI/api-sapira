# UPSELL con fecha efectiva dentro de un período ya emitido: no bloquea (Domi 28-10)

Soporte SimpliRoute 28-10 (Carelis, contrato S06870): PATHFINDER+ 8 × USD 48,40, mensual anticipado, ciclo día 1. Octubre (01–31) ya
emitido (e-FC A0003204); noviembre y diciembre Por Emitir. La cotización 006RO00000fYr2IYAS (+4 unidades desde el 15-10, "Cobrar ahora")
quedaba bloqueada con `issued_after_effective_date` ("PATHFINDER+ ya está facturado en firme hasta el 2026-10-31 · Usa fecha efectiva
2026-11-01 o posterior"). No debía: el prorrateo del primer tramo se diseñó justamente para el upselling (S3-5, S3-17).

## Causa

`planItemChange` (`src/modules/contracts/contract-changes.ts`) calculaba la frontera emitida del grupo del ítem y bloqueaba si el inicio del
cambio era anterior o igual a ella **sin mirar la categoría**. El bloqueo nació para el DOWNSELL (lo emitido se corrige con nota de crédito,
S3-5/6) y quedó aplicado también al UPSELL. `item_add` del mismo producto no tiene esa frontera, por eso sí funcionaba (factura suelta 15–31 oct
de USD 106,17): el generador y `addGeneratedInvoices` son los mismos para ambos.

## Qué cambia

- **UPSELL con línea propia** (cantidad, precio o ambos ejes): la frontera emitida ya no bloquea. El delta parte el día efectivo; el primer
  tramo se **prorratea por días** hasta el fin de lo emitido y va en la factura del próximo ciclo (`first_period_invoice: cycle`, fundida con la
  Por Emitir del mes) o en una factura suelta fechada el día efectivo (`immediate`). La factura emitida no se toca. Aviso nuevo
  `upsell_within_issued_period`: *"PATHFINDER+ ya está facturado hasta el 2026-10-31: la diferencia del 2026-10-15 al 2026-10-31 se prorratea
  por días y va en una factura aparte; la factura emitida no se toca"*.
- **UPSELL como línea neta** (consumo registrado en una Por Emitir o `net_line: true`): la línea neta reescribe las Por Emitir y no tiene dónde
  dejar el tramo del período emitido, así que el cambio rige desde el día siguiente a lo emitido (aviso `upsell_net_line_from_next_period`), sin
  bloqueo. Con modelo de precio no cambia nada (ya se corría al próximo período, `priced_item_from_next_period`).
- **DOWNSELL**: sin cambios; sigue bloqueando con fecha sugerida si, aun partiendo del próximo período, cae en lo emitido.
- Períodos emitidos por adelantado más allá del actual (p. ej. anual ya facturado): el UPSELL genera la diferencia de cada período emitido
  como factura nueva (o fundida con una Por Emitir del mes si existe), igual que `item_add`.

Caso Carelis con el fix: sin bloqueo; "Cobrar ahora" → factura suelta del 15-10 por 4 × 48,40 × 17/31 = **USD 106,17**; noviembre y diciembre
suman +193,60 (12 unidades); octubre emitido intacto; evento UPSELL `quantity` +193,60 relacionado al ítem.

## Impacto

- **Quién más lo usa.** `planItemChange` lo llaman la modificación manual del 360, la aplicación de cotizaciones del CRM (upsell/downsell) y
  los pactos programados (`scheduled_change`). Solo cambia qué bloquea para el UPSELL; DOWNSELL, renegociación de frecuencia/plazo
  (`planReterm`) y `item_add` no cambian. El front no cambia: el aviso llega por el canal de warnings y el bloqueo deja de aparecer.
- **Cuántos registros reales toca.** Ninguno se migra. Carelis aplica la cotización tal cual.
- **Qué lo verifica.** `contract-changes.spec.ts`: el test que esperaba el bloqueo pasa a esperar el aviso y las facturas (tramo 16/30 × 200 =
  106,67 en la PE de octubre); describe nuevo "upsell dentro de un período ya emitido": caso Carelis exacto en `immediate` (106,17 suelta +
  193,60 en nov y dic, `inv-10` intacta) y en `cycle` (106,17 + 193,60 en la PE de noviembre), upsell por precio y por ambos ejes, downsell
  desde el próximo período y bloqueado si cae en lo emitido, línea neta con consumo (rige desde el 01-11), mes vencido. Suite de contratos:
  1263 tests en verde.
- **Qué doc cambia.** Esta nota; `spec-modificaciones-contrato-v2.md` (blockers) y `mapa-v2-contratos.md` (`item_change`); centro de ayuda
  (Contratos › cambios de precio y cantidad).
