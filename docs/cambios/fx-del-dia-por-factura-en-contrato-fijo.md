# Cambio: "Del día" elegido en una factura manda sobre la política fija del contrato

> **Rama:** `domi` · Domi 22-10-2026 · caso Carelis, CTR-2026-161 (Salud Digital SB), factura de octubre.
> Sin migraciones ni cambios de datos.

## Qué pasaba

Contrato UF → CLP con `fx_invoice_policy = 'fixed'` y sin tasas cargadas. La usuaria eligió **Del día** en el diálogo
Tipo de cambio de la factura: la API borraba la tasa (`fx_contract_to_invoice = NULL`) y el origen (`fx_rate_source = NULL`) y
respondía "factura actualizada". Pero una factura spot elegida y una fija pendiente de tasa quedaban **idénticas en la base**,
así que `effectiveFxPolicy` caía a la política del contrato (fija) y el envío la bloqueaba con `fixed_fx_without_rate` ("Usa
tipo de cambio fijo pero no tiene la tasa cargada"). El bloqueo vivía en tres lugares: el plan de "Enviar al ERP ahora"
(`contract-invoices.ts`), los bloqueos del Contrato 360 (`contract-360.ts`) y el scheduler al valorizar
(`invoice-scheduler.service.ts`, rama simple y rama por pares). El arreglo del 22-10 a `derivedFxPolicy` (etiqueta "Spot" en vez
de "Fija") no cubría este camino: ese era el de tasa ya valorizada, este es el de tasa en NULL.

## Qué cambia (opción (a): respetar la decisión por factura)

1. **Elegir Del día deja una marca.** `planFx(policy: 'spot')` escribe `invoice_items.fx_rate_source = 'spot'` con la tasa en NULL
   (`writeLineAmounts` ya no fuerza NULL en el origen cuando la tasa es NULL y el origen es `spot`). Lectura: `spot` sin tasa =
   "Del día" elegido en la factura; `spot` con tasa = valorizada por el envío (la marca que ya escribía el scheduler).
   `no_change` solo si la factura ya tenía la marca.
2. **La política efectiva la respeta.** `effectiveFxPolicy`: tasa NULL con marca `spot` → `spot` antes de caer a la política del
   contrato. Con eso desaparecen el bloqueo del plan de envío y el del 360 (`ScheduleInvoice.fx_rate_source`, leído con `mode()`
   de las líneas en `contract-360.service.ts`).
3. **El scheduler valoriza con la tasa del día.** Rama simple: con alguna línea marcada `spot`, la política fija del contrato no
   exige tasa ni aplica la tasa guardada. Rama por pares: `fixedPolicy` queda en falso con la marca y se consultan las tasas del
   día. Es el espejo de la regla del 01-10 (tasa fija por factura en un contrato spot).
4. **Restablecer el borrador del ERP** de una factura así valorizada la devuelve a spot pendiente y conserva la marca
   (`planErpReset`: `spot_reset` también con marca `spot`; en contrato fijo `after.fx_rate_source = 'spot'`, en contrato spot NULL
   como antes).

Qué no cambia: una factura de contrato fijo a la que nadie le tocó el tipo de cambio sigue bloqueada hasta cargar la tasa (U12/B3,
nunca spot en silencio); la tasa manual fijada en una factura sigue mandando sobre un contrato spot; `EXPLICIT_FX_SOURCES`
(manual, net_exact) no incluye `spot`. El front no cambia: con tasa NULL la etiqueta ya dice "Spot · al emitir".

## Specs

- `contract-invoices.spec.ts`: `effectiveFxPolicy` en los dos sentidos, `planSendNow` sin `fixed_fx_without_rate` con la marca y
  con él sin ella, `planFx` spot escribe la marca, `planErpReset` conserva la marca en contrato fijo.
- `contract-invoices.service.spec.ts`: la marca llega a `invoice_items`; restablecer en contrato spot deja NULL.
- `contract-360.spec.ts`: bloqueo del 360 con y sin marca.
- `invoice-scheduler.service.spec.ts`: rama simple (CLF → CLP, contrato fijo, línea marcada → tasa del día) y rama por pares
  (con marca valoriza; sin marca `fx_rate_missing`).

## Impacto

- Solo afecta facturas donde alguien elija **Del día** desde este despliegue; las existentes con tasa NULL y sin marca siguen
  igual (bloqueadas si el contrato es fijo). Ninguna escritura directa en producción.
- Datos pendientes (decisión de negocio de la usuaria): si Salud Digital se factura con la UF del día, Modificar facturación →
  Tipo de cambio: Del día de emisión; si es fija, cargar la tasa en el contrato.
