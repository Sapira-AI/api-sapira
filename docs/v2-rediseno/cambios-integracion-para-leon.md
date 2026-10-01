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

## 4. FX por par al emitir · multimoneda MM4 (01-10-2026)

- **Dónde**: `src/modules/invoices/invoice-scheduler.service.ts`. Tres puntos acotados:
  1. `calculateInvoiceAmountsAtIssue`: al inicio, si `InvoiceSchedulerService.requiresPairValuation(invoice)` deriva al método nuevo
     `calculatePairAmountsAtIssue`; si no, **el código de siempre sin ningún cambio** (mismos números y campos).
  2. `sendInvoiceToOdoo`: la condición que llama al cálculo y la que valida "montos no calculados" pasan de
     `contract_currency !== invoice_currency` a `contract_currency !== invoice_currency || convertsByPair(invoice)`. Es necesario porque un
     contrato CLP con ítems en UF facturado en CLP tiene encabezado CLP = CLP y antes no se valorizaba (U3: líneas UF a $0 en Odoo).
  3. Métodos nuevos: `requiresPairValuation` y `convertsByPair` (estáticos, puros) y `calculatePairAmountsAtIssue` (privado), más el set
     `KEPT_FX_SOURCES`. Importa las funciones puras `valuateLinesByPair`, `pairKey`, `upperCode` de `src/modules/contracts/multicurrency.ts`
     (la misma valorización por línea que usa el motor de Contratos).
- **Cuándo aplica la rama nueva**: el contrato tiene `requires_multicurrency_billing`, **o** las líneas vienen en dos o más monedas
  (`invoice_items.contract_currency`), **o** alguna línea está en una moneda distinta del `contract_currency` del encabezado (p. ej. un
  consolidado). Una factura de una sola moneda (la del encabezado) nunca entra.
- **Qué hace**: agrupa las líneas por par `(moneda de la línea → moneda de factura)`. Línea en la moneda de la factura → tasa 1 (si ya tiene
  sus montos en moneda de factura no se escribe). Línea ya fijada (`fx_rate_source` = `contract`, `manual`, `net_exact` o `manual_unify`, con
  `fx_contract_to_invoice` > 0) → conserva su tasa y su origen. Si no, la spot del día de emisión de **ese par**
  (`getExchangeRateWithFallback(moneda de la línea, moneda de factura, issue_date)`, una consulta por par) y la línea queda con
  `fx_rate_source = 'spot'` y `fx_rate_date` = fecha de la tasa usada. Por línea escribe unitario, subtotal, IVA (subtotal × tasa de IVA del
  documento, 0 si ninguna línea lleva IVA) y total en moneda de factura, con residuo de centavos por par a la línea mayor (convención del
  motor). Encabezado = Σ líneas (`amount_invoice_currency`, `vat`, `total_invoice_currency`); `invoices.fx_contract_to_invoice` = la tasa si
  hay un solo par que convierte, NULL con dos o más. **Nunca ida y vuelta por la moneda del contrato**: `amount_contract_currency` no se toca.
- **Regla dura**: primero resuelve todos los pares; si falta la tasa de **cualquiera** no escribe nada, lanza `fx_rate_missing` con el par
  (`error.code`, `error.pairs`, mensaje "USD → MXN") y la factura queda omitida con el log `exchange_rate` y el correo de tasa faltante de
  siempre (uno por par). Con política fija y una línea que convierte sin tasa → mismo error, sin consultar Banco Central (como U12/B3).
  Las tasas fallback avisan por correo como antes (una por par).
- **Por qué**: decisión de Domi (01-10): lo que va al ERP está siempre en la moneda de la factura y la conversión es directa por par (UF → CLP,
  USD → CLP), nunca ítem → contrato → factura. Antes el envío spot aplicaba una sola tasa `contrato → factura` a todas las líneas.
- **Qué no cambia**: el mapper ya mandaba `price_unit = unit_price_invoice_currency` por línea y `currency_id` = moneda de factura (verificado,
  sin cambios); se siguen omitiendo las líneas en cero y las internas (entradas 1 y 2). Facturas de una sola moneda: sin cambio.
- **Efecto en Contratos**: se quitó el bloqueo `multicurrency_spot_send_pending` (activación de contratos multimoneda spot y consolidación
  spot con varios pares).
- **Test**: `invoice-scheduler.service.spec.ts` → bloque "MM4 · multimoneda: una tasa por par al emitir" (USD en MXN, dos pares, tasa manual
  conservada, par sin tasa no envía, fija sin tasa, detección). Los tests anteriores pasan sin cambios.
- **Estado**: sin commit al 01-10; va en la rama `domi` con el bloque Multimoneda (MM1–MM5).

## Pendiente para Leon (no hecho): estado de la NC de anulación al emitirse

Cuando la NC de anulación creada desde el Contrato 360 (`credit_type = cancellation`, nace Por Emitir con referencia a su factura) se
emite hacia Odoo y recibe folio, debe pasar a `Cancelada` igual que su factura original (par cerrado, como las NC de anulación
históricas): así ninguna de las dos suma en lo facturado ni entra en vencimientos o cobranza. La NC de descuento (`credit_type =
discount`) sigue su estado emitido normal. Decisión de Domi 01-10.
