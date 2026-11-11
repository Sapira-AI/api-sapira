# Brightcell · unificadas, tipo de cambio y cambios de contrato (Domi 10-11)

Brief completo: `brief-soporte-10-11-stanhome-brightcell.md`. Regla que ordena el bloque (Domi 10-11): **todo cambio sobre una factura de
origen (consumo, modificación de contrato, descripción, tipo de cambio de la factura o del contrato) se refleja solo en su unificada**; desunificar,
cambiar y volver a unificar es un paso que se elimina. El mecanismo es el que ya usa el consumo: `resyncFromOrigins` (recopia las líneas de
todos los orígenes a la unificada conservando identidad, fecha, OC y glosas) dentro de la misma transacción del cambio.

## 4a · La unificada conserva la tasa de cada línea

Antes (`valueLinesForConsolidation`, §7 "nunca un documento mixto"): si **una** línea que convierte no tenía tasa, el documento entero quedaba
spot y todas las líneas que convierten perdían tasa, origen (`fx_rate_source`) y montos en moneda de factura. Consecuencias: con política fija
la unificada quedaba sin tasa y el envío fallaba ("usa tipo de cambio fijo y no tiene tasa", 6b72c2b0 y 848e8889); una tasa fijada por OC en
un origen se perdía al unificar.

Ahora: cada línea conserva tasa, origen, fecha y montos; `spot` del encabezado = alguna línea sin tasa (encabezado sin montos en moneda de
factura); al emitir, `calculatePairAmountsAtIssue` respeta las líneas con tasa y valoriza al día solo las que no la tienen. `spot_propagated`
queda siempre en false (campo conservado). Avisos: `spot_document` dice que solo las líneas sin tasa se valorizan al emitir; nuevo
`fx_mixed_in_pair` cuando un mismo par mezcla fija y del día (parte del 4d); `pair_rates_differ` ya no se calla cuando el documento es spot.
Front: etiqueta "Fija y del día"; desaparece el texto "Pierde su tasa fija: el documento queda spot".

Impacto: solo unificaciones nuevas y re-copias (`resyncFromOrigins`); las unificadas guardadas no cambian. Con política fija, una línea que
realmente no tiene tasa sigue bloqueando el envío (igual que su origen): lo corrige 4b (las tasas del contrato alcanzan a los orígenes).
Tests: `invoice-consolidation.spec` (valorización por par, encabezado spot, avisos).

## 7 · La vista previa de la regla ya no marca "bloqueado" lo que se vuelve a unificar

`monthView` (`invoice-consolidation-rules.service.ts`) evaluaba un mes "por rehacer" con `consolidation.preview` sobre los orígenes ya
unificados (inactivos, `consolidated_into_invoice_id`): `not_pending` + `already_consolidated` → mes bloqueado y resumen con `blocked`,
aunque `runRule`/`save` lo rehacían bien con `reunifyInvoices` (10-11: vista previa blocked=3, guardado unified=3).

Ahora `preview(dto, holdingId, main, { simulate_undo_of })` evalúa los orígenes de esa unificada como Por Emitir y activos (lo que hará el
deshacer), y el mes sale con estado nuevo `will_reunify` ("Se vuelve a unificar"; cuenta en `summary.will_unify`). Front: etiqueta y color
en `clientes/_lib/unificacion.ts`, `UnificarFacturasDrawer`, tipo `UnificacionEstadoPreviewMes`. La tarjeta "Facturación unificada" (modo
`state`) deja de ver esos meses como bloqueados porque usa la misma vista. Tests: `invoice-consolidation-rules.spec`,
`contract-invoice-consolidation.service.spec`.

## 9 · La tasa fijada por factura (OC) sobrevive a consumos y reorganizaciones

El consumo reescribía la línea con `fx_rate_source = 'consumption'` (tasa correcta, marca "fijada por factura" perdida): con contrato spot
`explicitlyFixed` (scheduler) quedaba en false y el envío revalorizaba al día; en unificadas y multimoneda `keepsRateAtIssue` no conserva
`consumption` y esa línea iba al día mientras las demás quedaban fijas. Reorganizar hacía lo mismo con `reorganize`.

Nuevo en `fx-rate-sources.ts`: `inheritedFxSource(existing, fallback)` (si alguna línea de la factura tiene `manual` / `net_exact`, la
línea nueva hereda ese origen) y `perInvoiceFxSourceOf(db, invoiceId, holdingId)`. Lo usan `consumption.service.ts` (`insertLines`) y
`contract-invoice-reorganize.service.ts` (`updateLine` / `insertLine`, un origen por factura de destino). El editor ya heredaba
`invoice.fx_rate_source`; las líneas de cambios de contrato llevan `contract-change`, que se conserva en spot (`CONTRACT_FX_SOURCES`).
Tests: `fx-rate-sources.spec`, `consumption.service.spec`, `contract-invoice-reorganize.service.spec`.

## 5 y 4b · Los cambios de contrato y las condiciones de facturación alcanzan a las unificadas Por Emitir

Regla (Domi 10-11): nada de desunificar, cambiar y volver a unificar. `ChangeInvoiceRow` trae `consolidated_into_invoice_id`, `unified_number` y
`unified_state` (`editable` = su unificada está Por Emitir sin borrador en el ERP; `in_erp`; `issued`). `isEditablePending` acepta los
orígenes con unificada `editable` (`isOriginOfEditableUnified`), así que upsell, downsell, renegociación, quitar producto, cambio de modelo,
pausa, agregar producto (`mergeTarget` ya los ve) y las condiciones de facturación (moneda, tasas, política, documento, términos) escriben
sobre la factura de origen como sobre cualquier Por Emitir. `assertNoUnified` deja de bloquear: unificada editable → aviso `unified_resync`
("¿Agregar este cambio a la factura unificada U-…?"; la vista previa pide motivo); con borrador en el ERP → bloqueo `unified_invoice_in_erp`
(elimina el borrador y Restablecer); emitida → en el contrato principal es una emitida más (NC espejo), en uno secundario bloqueo
`unified_issued` (NC desde la unificada). Al aplicar, `ContractChangesService` re-copia cada unificada cuyos orígenes se tocaron
(`unifiedToResync` → `resyncFromOrigins`, misma transacción; conserva identidad, fecha, OC y glosas). Tests: `contract-changes.spec`
(orígenes editables, bloqueos por estado, condiciones de facturación), `contract-changes.service.spec` (re-copia antes del commit).

## 8 · Rehacer una unificada no pierde lo de la usuaria; las glosas llegan a los orígenes

- Pausar la regla con `undo_pending` y volver a guardarla armaba la unificada con `applyInvoices` (sin herencia). Ahora `runRule`, al unir un
  mes sin unificada vigente, busca la última deshecha cuyos orígenes incluyan alguna de las facturas por unir (evento
  `INVOICE_CONSOLIDATION_UNDONE`, `source_invoice_ids`) y pasa `carry_from`: la nueva hereda OC/HES, la emisión reprogramada (día de emisión
  incluido, `keptUnifiedDates`) y las glosas escritas a mano. Re-unificar ya lo hacía (`reunifyInvoices`).
- Descripciones (plantilla con `apply_to_pending`, texto manual) y "Corregir un dato" (regeneración de glosas desde los cambios): los
  orígenes de una unificada Por Emitir sin ERP cuentan como Por Emitir (`loadPendingInvoices(..., includeUnifiedOrigins)`,
  `EDITABLE_UNIFIED_ORIGIN_SQL`, `activateOrigins`), `writeLines` los escribe y la unificada se vuelve a copiar (`resyncAfterWrite`; desde los
  cambios, por las facturas tocadas). Las glosas protegidas de la unificada se conservan (`keptUnifiedDescriptions`).
- Pendiente de 8: la tasa fijada se conserva por la re-copia desde los orígenes (4c la escribe en los orígenes).
Tests: `invoice-consolidation-rules.spec` (carry tras pausa), `contract-invoice-consolidation.service.spec` (carry_from),
`contract-invoice-descriptions.service.spec` (orígenes + re-copia).

## 4c · Tipo de cambio de la factura sobre una unificada: por par, o con el neto de la OC por moneda

Antes `planFx` bloqueaba la unificada con varios pares ("ajústalos en cada contrato de origen") y el origen bloqueaba por inactivo:
callejón sin salida (desunificar, fijar en cada origen, re-unificar y perder OC, fecha y glosas). Ahora (Domi 10-11):

- `InvoiceFxDto.net_by_pair` `{ 'USD>CLP': 8612000, 'CLF>CLP': 1420000 }`: neto exacto (sin impuestos, en moneda de factura) por par, que
  es lo que trae una OC con varias monedas; `planFxByPair` deriva la tasa de cada par (neto ÷ Σ subtotal de sus líneas), el redondeo va a la
  línea mayor del par y el origen de tasa queda `net_exact`. `rates_by_pair` (fija por par) ya existía. `net_exact` con `target_net_amount`
  sigue siendo de un solo par.
- Unificada Por Emitir sin borrador en el ERP (`ContractInvoicesService.applyFxToUnified`): las tasas por par del plan se escriben en cada
  factura de origen (como Por Emitir propia, con `rate` del par de su contrato y `rate_source_override` para conservar `net_exact`), evento
  `INVOICE_FX_CHANGED` en cada contrato de origen y en la unificada, y `resyncFromOrigins` la vuelve a copiar en la misma transacción. Así la
  tasa de la OC sobrevive a cualquier re-copia (consumo, cambios de contrato, rehacer): queda en los orígenes.
- Front (10-11, revisión de Domi en local): la entrada no aparecía para la unificada de CTR-2026-110 (encabezado en CLP y contrato sin
  marca multimoneda): la barra de selección y la vista rápida de la unificada v2 ahora ofrecen "Tipo de cambio" cuando sus aportes están
  en otra moneda (`unifiedOtherCurrencies`); con borrador en el ERP no (primero Restablecer ERP).
- Front: en una factura con varios pares, "Neto exacto" se habilita y pide el neto por par (`net_by_pair`); el BFF lo valida
  (`invoiceFxSchema`). Pendiente (idea de Domi): neto por línea, no solo por moneda.
Tests: `contract-invoices.spec` (tasa por par y neto por par en unificada, residuo, par sin neto), `contract-invoices.service.spec`
(orígenes → evento → re-copia antes del commit), front `facturas.test`.

## 10 · Glosas de la unificada desde la vista rápida

La vista rápida (`FacturaVistaRapidaDrawer`) no dejaba editar las líneas de una unificada (`editable = … && !unified`), aunque la API
admitía el texto manual en una unificada v2 Por Emitir. Ahora las unificadas v2 Por Emitir sin borrador en el ERP muestran "Editar
descripción" y "Volver a la plantilla" (las históricas siguen bloqueadas). API: `descriptionBlockers` acepta también `mode: 'unlock'` en la
unificada v2 y `updateDescriptions` la vuelve a copiar desde sus orígenes tras desproteger (la glosa vuelve a la de la plantilla de su
origen); el texto manual se conserva al rehacer (`keptUnifiedDescriptions`).

## 3 · Proforma y detalle de una unificada con líneas en otra moneda (front)

`_lib/proforma.ts` tomaba `detail.contract_currency` (CLP en la unificada) como moneda de todas las líneas: 1.800 / 800 / 27 / 1 "CLP",
Neto 8.648 sumando USD + UF, sin nota. Ahora (regla de Domi 10-11: ambas monedas, la de factura solo cuando existe):
- cada línea va en **su** moneda (`line.currency`, multimoneda y unificadas); con montos en moneda de factura la línea va en esa moneda y
  muestra aparte su subtotal propio si su moneda es otra (`subtotalInvoice`);
- `byCurrency`: subtotal, IVA y total por moneda de las líneas cuando mezclan monedas (nunca una suma de monedas distintas);
- spot sin montos en moneda de factura y monedas mezcladas → `invoicePending`: totales "Pendiente de tipo de cambio" y nota "los montos en
  moneda de factura se calculan al emitir"; `model.currency = 'por línea'` (el encabezado de la tabla deja de rotular una moneda).
- Vista rápida › Totales: con líneas en varias monedas muestra "Por moneda" (neto por moneda) y, en la moneda de facturación, los montos
  si ya están valorizados o "Pendiente de tipo de cambio". Los totales de la pestaña Facturas se revisan en el punto 2.
Tests: `proforma.test` (unificada spot USD + UF en CLP), `proforma-pdf.test` (modelo), `FacturaVistaRapidaDrawer.test`.

## 2 · Montos del contrato sin mezclar monedas ni contar dos veces

"Estado de cobro" y los totales del cronograma (`contract-360.service.ts` `loadInvoices` → `computeFinancial`) tomaban
`amount_contract_currency` de cada factura; en una unificada ese encabezado suma los orígenes de varios contratos y monedas (Pagado "USD
13.124.996,84" eran CLP de dos unificadas). Ahora, para una unificada (del contrato principal o de otro contrato con líneas de este), el
monto que cuenta es `own_subtotal` = Σ `subtotal_contract_currency` de SUS líneas (`invoice_items.contract_id = este contrato`), en la
moneda del contrato; sus orígenes siguen inactivos y no suman (ni dos veces). El cronograma de un contrato secundario ahora ve la unificada.
La alerta "las facturas suman X y el valor total es Y" (`INVOICED_BY_CONTRACT_SQL`) ya sumaba por línea del contrato y excluía los orígenes:
no cambia (si en CTR-2026-110 sigue saliendo, es una diferencia real o un desvío por revisar). Front sin cambios: el widget ya muestra
`schedule.collection` en la moneda del contrato.

## 1 · Listas: una fila por unificada, en cada contrato de origen

`ContractsService.invoices` (pestaña Facturas): ya no lista los orígenes que viven dentro de una unificada vigente (inactivos,
`consolidated_into_invoice_id` a una unificada activa no cancelada); incluye las unificadas de otros contratos que tienen líneas de este
(período y conteo de líneas solo de las suyas); los orígenes de una unificada deshecha vuelven activos y se ven como siempre; la unificada
deshecha queda en Anuladas con `unified_undone` → chip "Unificación deshecha". Bajo el folio de una unificada vigente, sus contratos de
origen con líneas y monto por moneda (`contributions`). Contadores y paginación salen de la misma base. Pendiente (otra tarea, módulos
cerrados): Facturación y los 360 de cliente y razón social aplican el mismo criterio solo en sus filtros Por Emitir/Emitidas (`d.is_active`);
en "Todas" aún pueden mostrar orígenes inactivos.

## 6 · Desde cotización: una línea como ítem nuevo (otra cuenta) y la cotización aplicada por partes

Hoy: una cotización se aplicaba en un solo pedido. Si traía un producto que el contrato ya tenía pero para otra cuenta, "Cambió el precio y/o
la cantidad" lo sumaba como ajuste del ítem existente y, al volver a "Asociar a contrato" para agregarlo aparte, la API bloqueaba con
`quote_already_applied` (la cotización ya tenía un contrato o un evento con `origin.quote_id`).

API (`contract-changes.service.ts`, `contract-changes.ts`): el contexto de la cotización trae `applied_quote_item_ids` = líneas ya aplicadas
(`contract_items.quote_item_id` de esa cotización ∪ `metadata.quote_items` de sus eventos). `assertQuoteOrigin` ya no bloquea por cotización
sino por línea: bloquea `quote_already_applied` solo si el pedido no trae `quote_item_id` o todas sus líneas ya se aplicaron;
`quote_item_already_applied` si mezcla aplicadas y nuevas ("quita esas líneas del pedido"); y deja pasar con aviso `quote_partially_applied`
las que faltaban. El evento guarda `quote_items` como siempre, así la segunda aplicación queda registrada y una tercera se rechaza.
Sin migración.

Front: en la fila de un producto cotizado de "Cambió el precio y/o la cantidad" aparece "Así queda como ajuste del ítem que ya existe ·
**Agregar como ítem nuevo (otra cuenta)**" (`CambioForms.ItemChangeForm`, prop `onAddAsNewItem`); el panel pasa a "Agregó un producto"
prellenado solo con esa línea (`prefillFromQuote(..., 'agrega_producto', [quoteItemId])`) y avisa que las demás se aplican después, otra vez
desde la cotización. Son dos confirmaciones (una por tipo de cambio), cada una con su vista previa.

Tests: `contract-changes.spec` ("una cotización se aplica por línea"), `desde-cotizacion.test` (prefill por línea),
`ModificarContratoDrawer.test` (enlace → "Agregó un producto" con una línea y `quote_item_id`).
Ayuda: `contratos/modificar-un-contrato.md` → "Una línea cotizada va a otra cuenta".


## Ajustes de la revisión de soporte (simulación con datos de Brightcell, 10-11)

Soporte corrió las vistas previas del bloque con el código local contra los datos reales de Brightcell (sin escribir) y dejó cuatro
detalles. Todos son de Contratos, sin migración ni datos.

1. **"Todas" sin las unificadas deshechas.** La lista de facturas del contrato (`ContractsService.invoices`) excluye de "Todas" y de su
   conteo las Unificada/Consolidada en estado Cancelada (las que quedaron al deshacer o rehacer); siguen en "Anuladas" con el chip
   "Unificación deshecha". Test en `contracts.service.spec`.
2. **Paso siguiente del bloqueo `unified_invoice`.** Antes decía siempre "Desunifica el documento en Facturación y vuelve a intentarlo".
   `CONTRACT_INVOICE_SELECT` trae ahora `consolidated_into` (folio, estado, activa, borrador en el ERP de la unificada que contiene a la
   factura) y `unifiedInvoiceBlocker` (`contract-invoices.ts`, usado por `commonBlockers`, las referencias y anular) arma el paso según el
   caso: origen de una unificada Por Emitir sin borrador → "Hazlo en la factura unificada U-…: el cambio se guarda en sus facturas de origen
   y la unificada se actualiza sola"; con borrador → restablecerlo primero; emitida → nota de crédito desde la unificada; la unificada v2
   bloqueada (editar líneas, anular, reorganizar) → "Haz el cambio en la factura de origen de cada contrato". Las históricas y las
   `Consolidada` conservan el texto de desunificar. Test en `contract-invoices.spec`.
3. **Condiciones de facturación avisa la re-copia.** El cambio de moneda o política de tipo de cambio ya alcanzaba a los orígenes de una
   unificada editable (4b) y el servicio la re-copiaba, pero sin preguntar. Ahora emite `unified_resync` una vez por unificada, con el
   mismo texto que los demás cambios (`contract-changes.ts`, rama `billing_conditions`). Solo el aviso: los orígenes de una unificada
   con borrador en el ERP siguen fuera de la revalorización, como antes. Test en `contract-changes.spec`.
4. **"Enviar ahora" de una unificada spot sin total (front).** La API manda `total_invoice_currency` null y `amount_contract_currency` 0
   (la fila lo normaliza a número); el resumen mostraba "—" y "USD 0". `pendingFxTotalLabel` (`_lib/facturas.ts`) devuelve "Pendiente de
   tipo de cambio" para una Unificada/Consolidada Por Emitir sin total, y lo usan el resumen de la factura (`FacturaAccionForm`) y el
   resumen del envío (`FacturaAccionPreview.EnvioResumen`, que además oculta el neto 0). Tests en `facturas.test` y
   `FacturaAccionDialog.test`.

Pendiente (módulos cerrados, ya anotado): Facturación y los 360 de cliente y razón social siguen mostrando los orígenes en "Todas"; con el
punto 2, al menos el bloqueo que ven ahí apunta a la unificada correcta.
