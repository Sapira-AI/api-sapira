# Cambios en la integración con el ERP hechos desde Contratos v2 · para revisión de Leon

Registro de los cambios **puntuales** que el rediseño de Contratos hace en código de integración que mantiene Leon
(`src/modules/invoices/*`, envío a Odoo, scheduler). Cada entrada dice qué cambió, por qué, dónde está el test y en qué estado
de commit quedó. Domi avisa con la ruta de este archivo; no reemplaza la revisión de Leon.

Regla: aquí solo van cambios acotados y ya hechos. Lo que **depende** de Leon y no está hecho vive en
`spec-facturas-en-contrato-360.md` §7 y §8 (borrador en Odoo al restablecer, refresco de la descripción al emitir, NC hacia Odoo,
límites de caracteres CFDI/PE).

## 1. Líneas con cantidad 0 no viajan a Odoo (30-09-2026)

- **Dónde**: `src/modules/invoices/invoice-scheduler.service.ts`, `mapInvoiceToOdooFormat`, al inicio del recorrido de `invoice.items`.
- **Qué cambia**: una línea con `quantity = 0` se omite del borrador que se envía a Odoo, **solo si** la factura tiene al menos una línea
  con cantidad distinta de cero. Si todas las líneas están en cero, se envía igual que antes (sin cambio para el front viejo). Cada
  línea omitida deja una entrada en el log del envío (`🧹 Factura … línea(s) en cero no se envían al ERP`).
- **Por qué**: contratos por consumo que informan cero en un ítem del período (Contratos v2 · Facturas en el 360 · etapa 4). La línea se
  conserva en Sapira con cantidad 0 para trazabilidad y devengo, pero no debe aparecer en el documento legal. En v2 una factura con
  **todas** sus líneas en cero no llega al envío: pasa a Cancelada "sin cobro" (reversible).
- **Qué no cambia**: productos, impuestos, referencias, posición fiscal y montos de las demás líneas se arman exactamente igual.
- **Test**: `src/modules/invoices/invoice-scheduler.service.spec.ts` → "no envía al ERP las líneas con cantidad 0 …".
- **Estado**: sin commit al 30-09; va en la rama `domi` con el bloque de Facturas del contrato (etapa 4).


## 2. Líneas internas de una línea visible no viajan a Odoo (01-10-2026)

- **Dónde**: mismo método `mapInvoiceToOdooFormat`, mismo bloque que la entrada 1.
- **Qué cambia**: una línea con `invoice_items.visible_line_id` (migración `1790690000000-InvoiceVisibleLine`, Contratos v2 · etapa 6,
  facturación parcial por OC) es la asignación interna por ítem y período de **una única línea visible** del documento. Al ERP viaja
  solo la línea visible (cantidad 1 × neto de la OC); las internas quedan en Sapira para trazabilidad, devengo y conciliador.
- **Por qué**: caso Alicorp (roadmap #8, flexibilidad caso 6): la OC cubre un monto cerrado del período y el documento legal lleva
  una sola línea con la glosa acordada.
- **Qué no cambia**: facturas sin líneas internas se arman exactamente igual.
- **Test**: `invoice-scheduler.service.spec.ts` → "no envía al ERP las líneas internas de una línea visible…".
- **Estado**: sin commit al 01-10; va en la rama `domi` con el bloque de Facturas del contrato (etapa 6). Requiere la migración.

## 3. El envío respeta la tasa fijada explícitamente en la factura (01-10-2026)

- **Dónde**: `src/modules/invoices/invoice-scheduler.service.ts`, `calculateInvoiceAmountsAtIssue`.
- **Qué cambia**: antes, con política spot del contrato, el envío siempre consultaba Banco Central y pisaba `fx_contract_to_invoice`.
  Ahora, si la factura trae una tasa fijada **explícitamente desde el Contrato 360** (sus líneas llevan `invoice_items.fx_rate_source`
  = `manual` o `net_exact`: tasa por factura, neto exacto o facturación por OC), esa tasa se respeta y no se consulta Banco Central.
  Una tasa "pegada" por datos heredados, sin ese origen, sigue recalculándose a spot exactamente como antes. Con política fija
  nada cambia.
- **Por qué**: decisión de Domi (01-10): la tasa fijada por factura es una excepción explícita que da flexibilidad (OC con monto cerrado,
  acuerdo con el cliente) y el documento debe salir con esa tasa.
- **Test**: `invoice-scheduler.service.spec.ts` → "respeta la tasa fijada explícitamente…" y "una tasa pegada sin origen explícito no se usa…".
- **Estado**: sin commit al 01-10; va en la rama `domi` con el bloque de Facturas del contrato.

## Pendiente para Leon (no hecho): FX por par al emitir (multimoneda, 01-10-2026)

- **Dónde**: `src/modules/invoices/invoice-scheduler.service.ts`, `calculateInvoiceAmountsAtIssue` (**no se tocó** desde Contratos; es MM4 de
  [`spec-multimoneda-contrato.md`](./spec-multimoneda-contrato.md) §4 "Envío al ERP").
- **Qué debe cambiar**: hoy el envío spot toma **una** tasa `invoice.contract_currency → invoice.invoice_currency` y la aplica a todas las
  líneas. En un contrato multimoneda (`contracts.requires_multicurrency_billing`) cada línea guarda su par: `invoice_items.contract_currency`
  = moneda del ítem (UF, USD, CLP…) e `invoice_items.fx_contract_to_invoice` = tasa ítem → factura. El cálculo al emitir pasa a **una tasa
  por par**: agrupar las líneas por `(contract_currency, invoice_currency)` de la línea; si la línea ya trae tasa (fija del contrato,
  `fx_rate_source` = `contract`, o explícita `manual` / `net_exact`) se respeta; si es spot (NULL), la del día de emisión del par
  (`getExchangeRateWithFallback`); escribir cada línea (unitario, subtotal, IVA = subtotal × tasa de IVA del documento, total) con su tasa,
  `fx_rate_source = 'spot'` y `fx_rate_date`, y recalcular el encabezado = Σ líneas (`amount_invoice_currency`, `vat`, `total_invoice_currency`);
  `invoices.fx_contract_to_invoice` = la tasa si hay un solo par que convierte, NULL con dos o más. `amount_contract_currency` **no** se
  recalcula al emitir (moneda de contrato con la tasa pactada ítem → contrato, `contract_fx_period_rates.purpose = 'item'`).
- **Regla dura**: si falta la tasa de **cualquier** par, la factura no se envía (`fx_rate_missing` con el par); nunca un documento medio
  valorizado hacia el ERP. Las líneas en la moneda de factura van a 1.
- **Qué no cambia**: el mapper ya manda `price_unit = unit_price_invoice_currency` por línea y `currency_id` = moneda de factura; los
  contratos sin el flag (una moneda por línea = la del encabezado) siguen exactamente igual.
- **Mientras tanto**: un contrato multimoneda con política spot no se activa (bloqueo `multicurrency_spot_send_pending`); con política fija
  sí, porque la activación ya deja cada línea valorizada con la tasa de su par.
- **Estado**: pendiente de Leon. Lado Contratos sin commit al 01-10 (rama `domi`, MM1–MM3).

## Pendiente para Leon (no hecho): estado de la NC de anulación al emitirse

Cuando la NC de anulación creada desde el Contrato 360 (`credit_type = cancellation`, nace Por Emitir con referencia a su factura) se
emite hacia Odoo y recibe folio, debe pasar a `Cancelada` igual que su factura original (par cerrado, como las NC de anulación
históricas): así ninguna de las dos suma en lo facturado ni entra en vencimientos o cobranza. La NC de descuento (`credit_type =
discount`) sigue su estado emitido normal. Decisión de Domi 01-10.
