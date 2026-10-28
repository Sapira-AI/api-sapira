# Downsell a mitad de período: prorratea por días si la factura del período sigue Por Emitir (Domi 28-10)

Soporte SimpliRoute 28-10 (Carelis, contrato S06879): PATHFINDER+ 30 × USD 38,50 (MRR 1.155), mensual anticipado, 1 may–31 dic 2026.
Cotización 006RO00000flyxBYAQ: queda en 5 × USD 47,96 desde el 08-11-2026; la factura del 01-11 (período 1–30 nov) está Por Emitir. La vista
previa decía "La rebaja de PATHFINDER+ rige desde el próximo inicio de período (2026-12-01), sin prorrateo": noviembre completo con 30 y
diciembre con 5. La usuaria espera noviembre 1–7 con 30 al precio actual + 8–30 con 5 al precio nuevo, y diciembre con 5.

## Regla anterior y por qué cambia

"El downsell rige desde el próximo inicio de período" (S3-5/S3-6, `manual-modificaciones-contratos.md`) se decidió para colapsar tres
criterios distintos de la app anterior (RPC de cotización, RSM y contracción) que daban tres números. Con un solo motor, Domi decide que la
rebaja prorratee igual que el upsell cuando la factura del período todavía no se emitió.

## Qué cambia

- **`planItemChange` (`contract-changes.ts`)**: `coveringPendingLine` busca la Por Emitir editable (no facturada por OC) cuya línea base del
  ítem cubre la fecha efectiva **por dentro** (inicio < efectiva ≤ fin), sin consumo registrado ni edición manual. Si existe (y el contrato
  no es multimoneda), la rebaja parte en la fecha efectiva (`downsell_prorated`); si no, sigue "desde el próximo inicio de período"
  (`downsell_from_next_period`, ahora dice por qué: la factura que cubre la fecha ya está emitida) y, si lo emitido cubre más, el bloqueo
  `issued_after_effective_date` con fecha sugerida. Fecha efectiva = inicio de período: sin tramo, como hoy. Modelo de precio: sin cambios.
- **La Por Emitir que cubre la fecha** queda en dos tramos, con el mismo `monthsBetween` del upsell: la línea base pasa a inicio → efectiva−1 al
  valor vigente del grupo en proporción a sus días (`update_line` con `billing_period_end` y sufijo "(hasta 2026-11-07: 7/30 días)"; los
  ajustes previos del grupo en ese período se funden en ella, nunca líneas negativas hacia el ERP), y entra una línea neta efectiva → fin del
  período a la cantidad y el precio nuevos por días (`create_invoices` fundida en la misma PE, `item_key` = ítem madre; respeta el descuento
  si viene). Las PE siguientes quedan netas al valor nuevo como siempre (S3-14).
- **Ítem DOWNSELL**: parte en la fecha efectiva, `term_months` = meses enteros hasta el fin y **valor por días** (ΔMRR × `monthsBetween`), así
  Σ facturas = TCV. Para que `monthly_price` siga siendo ΔMRR (el RSM lo lee y prorratea el primer mes él solo: sin doble prorrateo),
  **`pricingFields` (`api-written-fields.ts`) deriva el mensual del DOWNSELL de cantidad × unitario con signo** (invariante `qty × unit =
  ΔMRR`) en vez de final ÷ plazo; CHURN sigue con final ÷ plazo. Para una rebaja que parte en inicio de período da el mismo número de siempre.
- **Front**: hint del paso Preguntas de Modificar contrato y centro de ayuda (Contratos › Modificar un contrato › Cómo se cobra un aumento y
  una rebaja).

Caso S06879 con el fix: sin bloqueo; ΔMRR −915,20; noviembre 1–7: 30 × 38,50 × 7/30 = **269,50**; 8–30: 5 × 47,96 × 23/30 = **183,85**
(1.155 → 453,35); diciembre 5 × 47,96 = 239,80; ajuste DOWNSELL del 08-11 con mensual −915,20 y valor −1.616,85; devengo de noviembre
−915,20 × 23/30 = −701,65 = 1.155 − 453,35.

## Impacto

- **Quién más lo usa.** `planItemChange` (manual, cotizaciones del CRM y pactos): solo cambia la rama DOWNSELL cuando la PE del período está
  por emitir; UPSELL, `item_remove`, renegociación de frecuencia/plazo y modelo de precio no cambian. `pricingFields` se aplica en cada
  INSERT/UPDATE de `contract_items` por la API: para DOWNSELL escritos por la API (qty × unit = ΔMRR por invariante) da el mismo mensual que
  final ÷ plazo; una fila legada cuya cantidad × unitario no calce con su valor ÷ plazo cambiaría de mensual solo si la API la vuelve a
  escribir (ya sería un dato inconsistente). Multimoneda queda fuera del prorrateo (sigue "próximo período").
- **Cuántos registros reales toca.** Ninguno se migra. S06879 aplica la cotización tal cual.
- **Qué lo verifica.** `contract-changes.spec.ts`: el test del downsell con la PE del período por emitir pasa a esperar el prorrateo (nov 466,67 +
  426,67, dic 800, valor −306,67, mensual −200); describe nuevo "downsell dentro de un período (S06879)": caso exacto (269,50 / 183,85 /
  239,80, TCV 14.643,15, `inv-10` intacta, evento RENEGOTIATION −915,20), mes vencido, factura emitida (próximo período o bloqueo), fecha =
  inicio de período, línea con consumo o manual. `api-written-fields.spec.ts`: mensual del DOWNSELL = qty × unit (con descuento, sin unitario
  cae a final ÷ plazo, en `quote_items` no aplica). Suite de contratos: 1269 en verde.
- **Qué doc cambia.** Esta nota; `manual-modificaciones-contratos.md` (§S3-5 actualización 28-10 e invariante 9), `spec-modificaciones-contrato-v2.md`
  (Prorrateo, §item_change), `mapa-v2-contratos.md` (`item_change`, códigos de aviso), `cobertura-contratos-v2.md` (MF-f); centro de ayuda.
