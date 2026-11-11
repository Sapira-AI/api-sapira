# Stanhome · cambiar solo el modo de cobro (Anticipado ↔ Vencido) (Domi 10-11)

Brief: `brief-soporte-10-11-stanhome-brightcell.md`, gap 1. Caso: CTR-2026-884106 (holding 5652e95e), ítem 344a6272 que pasó de Anticipado a
Vencido con datos (`billing_method` + `rescheduleBulk shift_months = 1`). Faltaba el camino de producto.

## Qué pasaba

"Vencido" solo se elegía dentro de "Cambió el modelo de precio"; con el mismo modelo la API respondía `price_model_unchanged`
(`planPriceModelChange` comparaba solo el `PriceSpec`). No había forma de cambiar solo cuándo sale la factura de cada período.

## Cómo queda

- **API** (`contract-changes.ts`, `planPriceModelChange`): `{ item_id, billing_method }` sin `price` (o con el mismo modelo) es un **cambio de
  modo de cobro**. Mismo corte (próximo inicio de período desde la fecha efectiva) y misma regeneración de Por Emitir que el modelo de precio;
  el RENEWAL copia unitario, descuento (también en monto fijo), cantidad y apunta a la **misma fila de `prices`** (`NewItemRow.reuse_price`:
  `contract-changes.service.ts` no inserta otra versión). MRR sin delta → evento `RENEWAL` subtipo `billing_method`, título "Cambio de modo de
  cobro", `metadata.price_model.billing_method_only = true`.
  - a) Anticipado → Vencido: el período ya cobrado por adelantado no se repite; el que comienza en el corte sale al cerrarlo (aviso
    `billing_method_to_arrears`, con "no se repite" si el anterior está emitido). El motor ya fecha las cuotas vencidas en `period_end + 1`.
  - b) Vencido → Anticipado: el día del corte salen dos facturas (la del período vencido, que seguía Por Emitir, y la del que comienza): aviso
    `two_invoices_in_transition`. Si el período anterior ya está emitido, no hay dos facturas y no hay aviso.
  - c) Por Emitir con borrador en el ERP: el mismo aviso de cualquier cambio (`closeInvoiceWarnings`, no bloquea). Emitida después del corte:
    `issued_after_effective_date`, como el modelo de precio.
  - d) Encabezado "Mensual anticipada/vencida": `summarizeItems` (`contract-360.ts`) ya ignora el ítem renovado (`renewed_by_item_id`) y toma el
    que sigue, así que el 360 pasa a "vencida" con el cambio; no se tocó.
  - Errores: el mismo modo que ya tiene (`change.items.0.billing_method`, "ya se cobra anticipado: elige el otro modo de cobro"); Anticipado en
    un ítem por consumo salvo asiento (`METERED_ADVANCE_MESSAGE`); la métrica no se vuelve a validar (el contexto no la carga sin precio nuevo).
    `price_model_unchanged` sigue para el mismo modelo con el mismo modo.
- **Front**: intención **"Cambió cuándo se factura (anticipado o vencido)"** (`modo_cobro`, mismo tipo `price_model_change`): producto (con su
  frecuencia y modo actual), Cobro con el modo contrario propuesto y la nota de qué pasa con el período en curso. Viaja
  `{ item_id, billing_method }` (`priceModel.methodOnly`; `priceModelChangeSchema` admite `price` opcional si viene `billing_method`). Misma
  sugerencia de fecha efectiva que el modelo de precio (cronograma). Resumen "Cobrar X vencido en el contrato …, desde el próximo período sin
  facturar a partir del …. Mismo precio; lo emitido no cambia." Toast "Modo de cobro actualizado".

## Tests

- `contract-price-model-change.spec.ts` → "solo el modo de cobro": Anticipado → Vencido con el período en curso Por Emitir y emitido (fechas
  de emisión, líneas borradas, sin delta, evento, avisos), fecha a mitad de período, Vencido → Anticipado con y sin período anterior emitido,
  descuento en monto fijo y precio anual conservados, mismo modo / por consumo a Anticipado / mismo modelo con otro modo.
- `contract-changes.service.spec.ts`: sin `INSERT INTO prices`, el ítem nuevo lleva el `price_id` del anterior, evento `billing_method`.
- Front: `intenciones.test.ts` (catálogo 15, `methodOnly`, payload, resumen, validación), `ModificarContratoDrawer.test.tsx` (modo contrario
  propuesto, fecha sugerida, error del mismo modo, body sin `price`).

## Docs

Spec §9.2 y §9.3.11; ayuda `modificar-un-contrato.md` → "Cambiar cuándo se factura" y novedad `cambiar-cuando-se-factura.md`; README del
módulo en el front.

## Impacto

Solo `planPriceModelChange` y el `INSERT INTO prices` condicionado por `reuse_price` (nuevo, `false` por defecto): un `price_model_change` con
precio nuevo se comporta igual (tests existentes verdes). Ningún otro planner lee `reuse_price`. Sin migración ni datos tocados. El caso de
Stanhome ya resuelto con datos no se rehace.
