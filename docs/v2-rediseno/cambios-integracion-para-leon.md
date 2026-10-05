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

## 5. Las NC/ND Por Emitir no se envían a Odoo hasta que exista la emisión de NC (01-10-2026)

- **Dónde**: `src/modules/invoices/invoice-scheduler.service.ts`: `getInvoicesToSend` (consulta del envío automático diario y del lote
  manual del scheduler) y `sendInvoiceById` (envío puntual, usado por Contrato 360 › "Enviar al ERP ahora"). Constantes exportadas
  `NON_SENDABLE_DOCUMENT_TYPES = ['NC', 'ND']`, `CREDIT_NOTE_SEND_PENDING` e `isNonSendableDocumentType`.
- **Qué cambia**: la consulta agrega `(inv.document_type IS NULL OR inv.document_type NOT IN ('NC','ND'))` (los valores del CHECK
  `invoices_document_type_check`; la NC espejo de v2 se inserta con `document_type = 'NC'` en `insertMirrorCreditNote`). El envío
  puntual de una NC/ND responde **409** `code: credit_note_send_pending` sin llamar a Odoo; el `send-now` del 360 responde el mismo
  código (antes `blocked` con el genérico `credit_note`).
- **Por qué**: las NC espejo de v2 (baja, pausa, anular, consumo) nacían Por Emitir y el envío las mandaba como `move_type: 'out_invoice'`
  (factura positiva). Cobertura Contratos v2, Huecos #1. **Decisión de Domi 01-10**: desde ahora las NC que crea la API **nunca** nacen Por
  Emitir: nacen siempre `Emitida`, sea cual sea el estado emitido de la factura que acreditan (nunca Pagada ni Vencida; `contract-360.ts` `creditNoteStatusFor`), sin `due_date`, con su
  fila en `invoice_references` a la original y `odoo_invoice_id`/`sent_to_odoo_at` NULL = **pendiente de emisión electrónica**
  (`creditNotePendingEmission`). El filtro y el 409 siguen como red de seguridad (y cubren las NC v2 previas que nacieron Por Emitir).
- **Para Leon (emisión de NC)**: el envío de NC deberá tomar las NC/ND con `odoo_invoice_id IS NULL AND sent_to_odoo_at IS NULL` y sin folio,
  en cualquier estado emitido (no `status = 'Por Emitir'`), como `out_refund` con su referencia.
- **Qué no cambia**: facturas (`FACTURA`, `FACTURA_EXPORTACION`, `Invoice`, NULL) se envían igual. Cuando exista el envío como `out_refund`
  basta con quitar `NC` (y `ND` con su tipo) de `NON_SENDABLE_DOCUMENT_TYPES`.
- **Test**: `invoice-scheduler.service.spec.ts` → "Huecos #1: sendInvoiceById rechaza NC/ND…" y "…la consulta del envío … excluye NC y ND";
  `contract-invoices.service.spec.ts` → "NC Por Emitir: 409 `credit_note_send_pending`…".
- **Estado**: sin commit al 01-10; va en la rama `domi`.

## 6. Job `contracts-extend-horizon`: Por Emitir nuevas cada día para ítems sin término (01-10-2026)

- **Qué**: a las 05:45 (America/Santiago, `contracts.scheduler.ts`) la API crea, por contrato Activo, las Por Emitir que faltan para que los
  ítems recurrentes sin término tengan siempre 12 períodos facturados desde hoy (mismo generador que la activación; se suman a la Por Emitir
  del mes si el contrato agrupa). Evento `HORIZON_EXTENDED` por contrato solo si creó algo. `CONTRACT_JOBS_ENABLED=false` lo apaga.
- **Impacto para el envío**: son Por Emitir normales con su fecha de emisión futura (12 períodos adelante): el scheduler de facturas las
  toma cuando llega su fecha, igual que las de la activación. No cambia el envío ni la emisión automática.

## 7. Facturación v2: pagos, correos y recordatorios desde la API (01-10-2026)

- **Qué**: módulo `billing` ([`mapa-v2-facturacion.md`](./mapa-v2-facturacion.md)). No toca el envío a Odoo: las acciones masivas de la
  cola Por emitir llaman al `send-now` del 360 por factura (que delega en `sendInvoiceById`), agrupadas por contrato.
- **Pagos**: `POST /billing/payments` escribe `invoice_payments` con `sapira.writer = 'api'` y recalcula el estado en la API (Pagada solo con
  pagos en la moneda de la factura, nunca sobre Por Emitir; al anular un pago vuelve a Emitida/Enviada/Vencida). Asset escrito, **no
  aplicado**: `after_invoice_payment_change` con el guard de la costura (el front viejo sigue igual). El webhook de Odoo no cambia
  (B-F2 `partial` → Pagada sigue siendo propuesta para ti).
- **Correo**: `EmailsService.send` (SendGrid) acepta varios destinatarios, `bcc` y adjuntos (compatibles con las llamadas existentes).
  Job `billing-reminders` 08:00 America/Santiago, apagado salvo `BILLING_REMINDERS_ENABLED=true` y `dunning_enabled` del holding.
- **Estado**: sin commit al 01-10; va en la rama `domi`.

## 8. Producto sin mapeo a Odoo: la factura se rechaza, ya no viaja como producto 1 (02-10-2026)

- **Qué**: `invoice-scheduler.service.ts` → `getProductMappingInfo` ya no devuelve `odoo_product_id = 1` cuando el producto no está en
  `odoo_product_mappings` (del holding) ni en `products.odoo_product_id`, ni cuando la lectura falla (ahora propaga el error). Antes de
  mapear, `sendInvoiceToOdoo` llama a `findUnmappedProducts` sobre las líneas que viajan (`itemsSentToErp`: visibles, sin las de cantidad 0
  salvo que todas lo sean) y, si alguna no resuelve, **omite la factura** (`status: 'skipped'`, `error: "Productos sin mapeo a Odoo: …"`),
  registra el log (`errorType: 'product_without_erp_mapping'`) y, fuera de dry run, crea la notificación de fallo de Odoo existente
  (`createOdooFailureNotification`, etapa `product_mapping`, recomendación "Mapea el producto en Integraciones › Odoo…"). Una línea
  visible **sin `product_id`** también se rechaza (antes viajaba como producto 1); `mapInvoiceToOdooFormat` lanza si se le llama directo
  con un producto sin mapeo (defensa).
- **Bloqueo previo**: el 360 (columna Bloqueos y "Enviar al ERP ahora") y la cola Por emitir de Facturación muestran
  `product_without_erp_mapping` con los productos nombrados (`UNMAPPED_PRODUCTS_SQL` en `contracts/contract-360.ts` replica el mismo
  criterio de líneas y de mapeo), `action: 'map_product'`. Solo si la factura va por el ERP.
- **Para validar**: que ninguna factura real dependa hoy del producto 1 "por defecto" (si lo hay, mapearlo antes del próximo envío); que
  el mapeo por holding sin compañía sea el correcto (se replicó tal cual).
- **Test**: `invoice-scheduler.service.spec.ts` → "producto sin mapeo al ERP (product_without_erp_mapping)…".
- **Estado**: sin commit al 02-10; va en la rama `domi`.

## 9. Errores del envío al ERP traducidos a palabras de la usuaria (02-10-2026)

- **Qué**: función pura `translateErpError(raw, errorType)` (`src/modules/invoices/erp-error-translation.ts`) que clasifica el texto
  técnico del envío en `partner_not_linked`, `product_without_mapping`, `tax_not_found`, `currency_inactive`, `journal_missing`,
  `period_closed` (fecha de bloqueo de Odoo), `duplicate_number`, `fx_rate_missing`, `connection`, `validation` (con el mensaje de Odoo
  limpio) y `unknown` (texto crudo en "detalle técnico"), cada una con mensaje, paso siguiente y acción de la UI. **No cambia la lógica
  del envío**: es aditiva sobre lo que ya devuelve el scheduler.
- **Cambios puntuales en `invoice-scheduler.service.ts`**: `InvoiceResultDto.errorType` (opcional, el mismo `error_type` del log) se
  completa en cada rama de error/omisión; `createOdooFailureNotification` ahora titula "No se pudo enviar la factura <folio> de
  <cliente>" y el cuerpo es la frase traducida (lo técnico queda en `metadata.technical_title`, `technical_message`, `error_message` y
  `erp_error`); además se notifica (fuera de dry run, misma deduplicación por factura+etapa+tipo) en tres ramas que antes solo dejaban log:
  omisión por validación (`validation`), taxes incompatibles (`tax_validation`) y rechazo/excepción al crear el borrador
  (`odoo_rejection`, `unexpected_exception`). Nuevo `lastSendAttempt(invoiceId, holdingId)`: lee el último `invoice_odoo_send_logs` de la
  factura (sin columnas nuevas) y lo traduce.
- **Dónde se ve**: `send-now` del 360 y la masiva de Facturación devuelven `message` traducido + `error { category, message, next_step,
  action, raw }`; `GET /contracts/:id/invoices/:invoiceId` trae `last_send_attempt` (la vista rápida muestra "Último intento de envío").
- **Para validar**: que las nuevas notificaciones de validación no sean ruido en el envío automático diario (se deduplican por factura);
  ampliar los patrones de `translateErpError` con mensajes reales de Odoo que conozcas.
- **Test**: `erp-error-translation.spec.ts`, `invoice-scheduler.service.spec.ts` ("la notificación de fallo usa la frase traducida…",
  "lastSendAttempt…"), `contract-invoices.service.spec.ts`, `billing-bulk.service.spec.ts`.
- **Estado**: sin commit al 02-10; va en la rama `domi`.

## 10. Búsqueda del partner de Odoo por RUT más robusta + vincular a mano desde Clientes (02-10-2026)

Contexto: el self-service "editar la razón social → se vincula sola con Odoo" (`POST /odoo-partners/resolve-partner-by-tax-id`,
`RazonSocialFormModal` del front viejo) "últimamente no funciona bien" con usuarias activas. Diagnóstico (lectura de código):

- **Vat de Odoo con otro formato**: la búsqueda era `['vat', '=', taxId normalizado]` y Odoo compara carácter a carácter. Si Odoo guarda
  `76.397.190-2` (o `763971902`) y Sapira `76397190-2`, no hay match → `not_found`.
- **Vat numérico pierde el cero inicial** (`xml-rpc-client.helper.ts:93`, `parseTagValue: true`): un NIT como `06142406041060` vuelve como
  número `6142406041060` y el post-filtro `normalizeTaxId(partner.vat) === taxId` lo descartaba (causa raíz Ransa SV 15-09; el fix
  `parseTagValue: false` quedó sin aplicar).
- **Contactos hijos heredan el vat de su empresa**: la búsqueda traía la empresa y sus contactos → `ambiguous` y no vinculaba.
- **Guion tipográfico** (`–` de copiar y pegar, caso SENAPRED) no se normalizaba.
- **Duplicados**: dos razones sociales Sapira con el mismo RUT (el resolve busca por RUT, no por id) o dos partners reales en Odoo con el
  mismo RUT (Logística Médica 30-09) → `ambiguous`, sin vincular.
- **Silencio en el front**: `not_found` / `ambiguous` / errores van a `console.warn`; la usuaria solo ve "Razón social actualizada".
  Además solo se dispara al **editar** (no al crear) y tras escribir directo en Supabase.
- **Errores genéricos**: sin conexión activa o con credenciales inválidas se lanzaba `Error` → 500 sin explicación.

**Qué cambió (solo búsqueda y normalización; la lógica de vincular/ambigüedad del resolve no cambia):**

- `src/modules/odoo/utils/partner-vat.util.ts` (nuevo): `canonicalVat` (= `normalizeTaxId` + guiones tipográficos → `-` + mayúsculas),
  `vatSearchVariants` (tal cual, canónico, sin separadores y, si parece RUT, con guion y con puntos), `vatMatches` (compara solo letras y
  dígitos; acepta el vat numérico sin cero inicial) y `withoutChildContacts`.
- `odoo-partners.service.ts`: `searchPartnersByTaxId` y `searchPartnersByTaxIds` buscan `['vat', 'in', variantes]`, filtran con
  `vatMatches` y descartan contactos hijos cuya empresa también vino; leen además `parent_id` e `is_company`. `resolveAndLinkPartnerByTaxId`,
  `resolveAndLinkPartnerForEntity` y `resolveMissingPartners` usan `canonicalVat`. Conexión + autenticación en un helper `openSession`
  que lanza `OdooConnectionError` (`no_connection` / `auth_failed`) en vez de `Error`.
- Nuevos métodos de **solo lectura** para Clientes v2: `findPartnerCandidates(holdingId, { taxId, name })` (por vat y por nombre `ilike`
  con `parent_id = false`, cada candidato con `match`) y `findActivePartner(holdingId, id)`. No escriben.
- Clientes v2 (`ClientEntityErpService`): `POST /client-entities/:id/erp-partner/search`, `GET|PUT|DELETE /client-entities/:id/erp-partner`.
  Vincular valida que el partner exista activo en la conexión del holding (404) y que ninguna otra razón social del holding lo use (409
  `partner_already_linked`); escribe `client_entities.odoo_partner_id` con la marca `sapira.writer = 'api'`.
- **Tests**: `odoo/utils/partner-vat.util.spec.ts`, `odoo-partners.service.spec.ts` ("variantes de formato… caso Ransa SV", "contactos
  hijos ya no lo vuelven ambiguo", `findPartnerCandidates`, `OdooConnectionError`), `clients/client-entity-erp.service.spec.ts`.
- **Estado**: sin commit al 02-10; rama `domi`. Sin migraciones.

**Para Leon (no hecho, decide él):**

1. `parseTagValue: false` en `xml-rpc-client.helper.ts` para toda la integración (zip, teléfono, folios o refs con ceros iniciales también
   vuelven como número). Aquí solo se tolera en la comparación del vat.
2. **Conexión por holding**: `odoo_connections` permite varias activas por holding (único por `holding_id + name`) y todas las búsquedas
   usan `findOne({ holding_id, is_active })` sin orden. Si un holding tiene más de una (p. ej. una base por país), la búsqueda puede ir a
   la equivocada. Debería resolverse por la compañía emisora (`companies.odoo_integration_id`) o dejar una sola activa.
3. **Front viejo** (`RazonSocialFormModal.tsx` ~146-190): mostrar `not_found` / `ambiguous` en vez de `console.warn`, resolver por
   `clientEntityId` (no por RUT, para no chocar con duplicados de Sapira) y disparar también al crear. O enviar a las usuarias a
   "Vincular con Odoo" del front nuevo.
4. Unicidad de `odoo_partner_id` por holding: hoy no hay constraint (dos vinculaciones simultáneas al mismo partner no se bloquean en la
   base). Hay casos legítimos de dos partners con el mismo RUT (SOLUCLAB), pero no de un partner en dos razones sociales.
5. El resolve automático sigue sin ver partners archivados y sin buscar por nombre; el vínculo manual cubre esos casos.

## 11. "Traer desde ERP": crear una razón social ya vinculada a su partner (02-10-2026)

- **Dónde (Odoo, solo lectura)**: `src/modules/odoo/odoo-partners.service.ts`.
  - `OdooPartnerCandidate` suma `email` y `address` (la dirección sale del helper `partnerAddress`, el mismo cálculo que ya usaba
    `toPartnerData`, ahora compartido). `findPartnerCandidates` / `findActivePartner` no cambian de dominio ni de campos leídos.
  - Método nuevo `connectionStatus(holdingId)` → `{ connected, name }`: solo `findOne({ holding_id, is_active: true })` sobre
    `odoo_connections`, **sin autenticar ni llamar a Odoo**. Habilita el botón en el front antes de buscar.
- **Dónde (Clientes)**: `ClientEntityErpService` (`connection`, `searchForNew`, `createWithPartner`) y `ClientDirectoryService.createEntity`
  (opción `odooPartnerId`). Endpoints nuevos en `client-entities.controller.ts` (no en el módulo odoo):
  `GET /client-entities/erp-connection`, `POST /client-entities/erp-partner/search` (`{ query }` obligatorio, sin razón social) y el
  campo opcional `odoo_partner_id` en `POST /client-entities`.
- **Qué hace**: con `odoo_partner_id`, el alta valida que ninguna otra razón social del holding use el partner (409
  `partner_already_linked`, nombra razón social y cliente comercial; sin consultar Odoo) y que exista activo en la conexión del holding
  (404 `partner_not_found` / 503 si Odoo no responde). Luego crea y vincula **en una sola transacción** (`insertClientEntity` con
  `odoo_partner_id` en el mismo INSERT, marca `sapira.writer = 'api'`), repitiendo dentro de la transacción la regla de unicidad del
  vínculo (`findEntitiesLinkedToPartners`, la misma consulta que usan buscar y vincular). RUT duplicado: la regla de siempre (409
  `duplicate_tax_id` salvo `allow_duplicate_tax_id`). Sin campos ni migraciones.
- **Copy**: los mensajes de bloqueo (`odooBlocker`) y de vínculo dicen "ERP" en vez de "Odoo" (los `code` no cambian).
- **Tests**: `clients/client-entity-erp.service.spec.ts` (bloque "Traer desde ERP"), `clients/client-entity-create-delete.spec.ts`
  ("Traer desde ERP: …"), `odoo/odoo-partners.service.spec.ts` (correo y dirección, `connectionStatus`).
- **Estado**: sin commit al 02-10; rama `domi`.
- **Para Leon**: sigue vigente el punto 4 de la entrada 10 (sin constraint de unicidad de `odoo_partner_id` por holding: el chequeo dentro
  de la transacción reduce pero no elimina la carrera entre dos altas simultáneas al mismo partner) y el punto 2 (si hay más de una
  conexión activa, `connectionStatus` y la búsqueda toman cualquiera).

## 12. Salesforce: cotizaciones en espera de mapeo de producto desde el front nuevo (02-10-2026)

- **API: sin cambios.** Atajo aprobado por Domi ("opción 1"): el front nuevo (`front-sapira`, lab de Cotizaciones) consume solo
  endpoints que ya existían en `src/modules/salesforce`. No hay servicios, DTO ni migraciones nuevas.
- **Endpoints que ahora consume el front nuevo** (BFF `app/api/integraciones/salesforce/*`, siempre con `x-holding-id`):
  - `GET /salesforce/staging/opportunities?status=error&page=N&limit=100` (hasta 5 páginas): oportunidades detenidas. El front lee
    `raw_data` (`Account.Name`, `Amount`, `CurrencyIsoCode`, `CloseDate`, `OpportunityLineItems.records[].Product2Id/Product2.Name/ProductCode/Family`),
    `error_message` e `integration_notes`.
  - `GET /salesforce/staging/opportunities?search=<id>&limit=10`: estado de una oportunidad tras reintentar (coincidencia exacta).
  - `GET /salesforce/mappings/products`: mapeos activos; una oportunidad está "en espera de mapeo" si alguna línea tiene un Product2
    sin mapeo activo (o si su `error_message` dice "sin mapping activo" y el producto ya se mapeó: falta reintentar).
  - `POST /salesforce/mappings/products` (`CreateProductMappingDto`; el servicio ya hace upsert por `salesforce_product_id` y reactiva).
  - `POST /salesforce/staging/opportunities/:id/retry` con body `{}` (→ `retry_full`, el mismo modo que propone la notificación
    `unmapped_products`) y `GET /salesforce/staging/runs/:runId` para esperar el resultado.
  - `GET /quotes?search=<id>&origin=salesforce` (módulo `quotes`): para enlazar la cotización creada.
- **Huecos vistos (para Leon, no tocados):**
  1. **`SalesforceMappingController` no tiene `HoldingAccessGuard`** (solo `SupabaseAuthGuard`), a diferencia de
     `salesforce/staging` y `salesforce/sync-logs`. Cualquier usuario autenticado puede leer o escribir mapeos de producto, tipo de
     cotización, campos y objetos de **otro** holding mandando su id en `x-holding-id`. Lo mismo en `SalesforceController`
     (`GET /salesforce/connection`, `POST /salesforce/query`, `sync*`). Recomendación: `HoldingAccessGuard` (o `HoldingScopeGuard` +
     `@HoldingId()`) a nivel de controlador.
  2. **`createProductMapping` no valida que `sapira_product_id` sea del holding**: solo la FK a `products`. Un mapeo podría apuntar a
     un producto de otro holding. Recomendación: verificar `products.holding_id = holdingId` (404/400) y tomar `sapira_product_name`
     del catálogo en vez de confiar en el body.
  3. **No hay un endpoint de lectura de "detenidas con su motivo estructurado"**: el motivo `unmapped_products` y la lista de productos
     solo viven en `metadata` de la notificación (`SALESFORCE_STAGING_BLOCKED_NOTIFICATION_TYPE`) o como texto en `error_message`. El
     front lo reconstruye cruzando `raw_data` con los mapeos. Lo más parecido hoy es `GET /salesforce/staging/opportunities?status=error`.
     Sugerencia: `GET /salesforce/staging/opportunities/blocked?reason=unmapped_products` con `{ salesforce_id, name, account_name,
     amount, currency, close_date, block_reason, unmapped_products[{ id, name, code, family }] }`, sin `raw_data`.
  4. **`GET /salesforce/staging/runs/:runId` no expone el error por oportunidad** (`salesforce_sync_run_items.error_message`): el front
     relee el staging para saber por qué sigue detenida.
  5. **Una sola ejecución del mismo tipo por holding** (`createRun` → 409): reintentar dos oportunidades exige esperar a que termine la
     primera. El front lo hace en serie y reintenta el inicio ante 409. Un `retry` que acepte varios ids en una ejecución lo
     simplificaría (`POST /salesforce/staging/opportunities/process/run` acepta varios, pero es `process_final`: no reclasifica ni
     resuelve la notificación `unmapped_products`).
  6. `GET /salesforce/connection` responde `null` (cuerpo vacío) sin conexión: el front no lo usa para decidir si mostrar el aviso
     (sin Salesforce el staging está vacío y el aviso no aparece).
- **Estado**: sin commit al 02-10; rama `domi`. Pruebas reales contra producción las hace Domi a mano.

## 13. Huecos de seguridad de la API que afectan al front nuevo (02-10-2026)

Revisión de solo lectura de los controladores sin `HoldingScopeGuard` (detalle con archivo:línea en
[`revision-seguridad-api.md`](./revision-seguridad-api.md)). Solo se listan los que siguen vivos con el front nuevo (la API es la
misma); lo que solo usa el front actual se elimina en el switch. Atacante realista: un usuario existente de un cliente (el registro
libre está cerrado en Supabase) o, en las rutas `@Public`, cualquiera. Nada corregido todavía.

**De integraciones (Leon):**

| Ruta | Problema | Arreglo sugerido |
|---|---|---|
| `GET /odoo/connections` (sin header devuelve todas), `GET/PUT/DELETE /odoo/connections/:id` | Expone `api_key` de Odoo de todos los clientes; permite cambiar la URL de la conexión de otro | `HoldingScopeGuard`, quitar la rama "todas", nunca devolver `api_key` |
| `GET /stripe/connections`, `GET /stripe/connections/:id` | Devuelve `secret_key` de Stripe del holding del header (sin validar) | Ídem, nunca devolver `secret_key` |
| `POST /odoo/webhooks` (`@Public`, sin firma) | Sin sesión se marcan facturas como Pagadas/Enviadas y se cambian monto, IVA, número y fecha | Secreto por conexión + validar que la factura sea del holding de la conexión (requiere reconfigurar cada Odoo) |
| `GET /odoo/webhooks` | Payloads e ids de facturas de todos los holdings | Eliminar o solo super admin |
| `POST /invoices/scheduler/send` | Sin header y con `dryRun:false` emite las facturas vencidas de todos los holdings | Solo super admin, o holding validado |
| `POST /odoo/invoices/create-draft` | Crea y publica facturas en el Odoo de otro holding | Eliminar la ruta (sin uso) |
| `POST /bigquery/query`, `POST /salesforce/query` | Consulta libre (SQL/SOQL) contra el BigQuery o Salesforce del cliente | Eliminar (sin uso en el front nuevo) |
| `/salesforce/mappings/*`, `/salesforce/staging/*` (`HoldingAccessGuard`), `/salesforce/*` (credenciales, sync) | Header sin validar: leer y escribir mapeos, credenciales y syncs de otro holding. El front nuevo usa mapeos y staging | `HoldingScopeGuard` en todos |
| `/stripe/invoices|customers|subscriptions` (clave global), `/stripe/products*`, `/stripe/staging/*` | Datos de la cuenta Stripe de la plataforma; staging ajeno por id | Eliminar los de clave global; `HoldingScopeGuard` + dueño en el resto |
| `/odoo/companies*`, `/odoo/products*`, partners, invoice-processing, `/bigquery/*` | Usar credenciales de otro cliente y escribir mapeos/staging | `HoldingScopeGuard` |

**Comunes (los tomamos Domi y Claude dentro del bloque Configuración, aviso a Leon por si usa alguna):**

| Ruta | Problema |
|---|---|
| `POST /holdings/assign-to-all-holdings/:userId` | Cualquier usuario con sesión se agrega a todos los holdings (la API escribe como `postgres`, RLS no aplica). Se deja solo para super admin |
| `GET /users`, `/users/:id`, `/by-email`, `/by-auth-id`, `/holdings/user/:id` | Datos de todos los usuarios de la plataforma |
| `POST /copilot/chat` y sesiones | Datos de cualquier holding vía el copiloto (`holding_id` en el body); la BFF de Next debe mandar `holdingHeaders()` |
| `/agents/*` (run, approve, configs) | Enviar cobranza/proforma y cambiar configuración de agentes de otro holding |
| `/emails/*` | Dominios y remitentes de otro holding por id |
| `/database/*` (`@Public`), `/security/*`, `/audit/*`, `/devices/*` | Esquema completo sin sesión; bloquear la IP del front (caída total) |
| `POST /invoices/bulk-update-currency`, `PATCH /invoices/:id/auto-invoice` | Cambiar facturas ajenas por id |

**Correos: `/emails/*` y `/email/*` reemplazadas por `/settings/communications/*` (03-10-2026, ronda 3 de Configuración).** El hueco #15
de [`revision-seguridad-api.md`](./revision-seguridad-api.md) (ver, editar y borrar dominios y remitentes de otro holding por id; mandar el
correo de prueba desde el dominio de otro cliente) **no se arregla en las rutas viejas**: el front nuevo usa las rutas nuevas
`/settings/communications/domains|senders|test-email` (contrato de Configuración §8.2), con `HoldingScopeGuard`, permiso
`VIEW/EDIT_CONFIGURACION`, cada id filtrado por el holding del header y el correo de prueba solo a correos del propio usuario o de
miembros del holding. Reutilizan la lógica de SendGrid de `EmailsService` (registro, borrado y envío) sin cambiarla. **Las rutas viejas
siguen abiertas** porque el front actual (`app.aisapira.com`) las usa hasta el switch; se cierran en el bloque de seguridad. Si alguna
integración tuya llama `/emails/*` o `/email/*`, avísanos para moverla a las nuevas antes de cerrarlas.

## 14. Integraciones v2: lo que es lógica de integración (03-10-2026)

Módulo nuevo `src/modules/integrations/` con rutas `/integrations/*` (contrato:
[`contrato-api-integraciones.md`](./contrato-api-integraciones.md); spec: [`spec-integraciones-v2.md`](./spec-integraciones-v2.md)).
**No cambia la lógica de ninguna integración**: cada adaptador inyecta los servicios existentes (Odoo, Salesforce, Stripe, BigQuery,
envío de facturas). Esto es lo que queda de tu lado:

**Cómo se complementa con tu Fase 2 de tenancy (rama `leon`).** Las rutas nuevas nacen seguras (`SupabaseAuthGuard` +
`HoldingScopeGuard` + `@HoldingId()` + `RequirePermission(VIEW/EDIT_INTEGRACIONES)`, DTOs sin `holding_id`, 404 por id, los 3 tests de
guard) y **nunca devuelven claves**. Las viejas (`/odoo/*`, `/salesforce/*`, `/stripe/*`, `/bigquery/*`) no se tocaron: las usa la app
actual hasta el switch y su cierre es tu Fase 2 (`inventario-tenancy-fase-2.md`). Cuando el front nuevo esté en producción, las viejas que
solo usaba la app actual se pueden borrar en vez de proteger. Para no chocar con tu rama: no se editó `invoice-scheduler.service.ts`,
su controlador, `dtos/scheduler-report.dto.ts` ni `notifications.controller.ts`; el historial del ERP lee `invoice_scheduler_jobs`
directo y sirve con las dos versiones (jobs `all` filtrados al holding y jobs por holding). **`holding_integration_settings` es la tabla
única de ajustes por integración**: `domi` trae tu entity y tu migración tal cual y la migración `1791000000000-IntegrationsV2` le agrega
`settings jsonb` (etapas del CRM, filtro del ERP, reglas de exclusión) y `updated_by`, y suma `stripe` a su CHECK (mismo nombre de
constraint). Tipo → `integration`: erp → odoo, crm → salesforce, stripe → stripe, datos → bigquery. El switch "Sincronización automática"
(`auto_sync` en `/integrations/:tipo/settings`) escribe `auto_enabled` en la misma fila (TypeORM con la entity).

| # | Pedido | Por qué |
|---|---|---|
| L1 | **Traer del ERP solo las facturas que no nacieron en Sapira** (sueltas o legacy) y **notas de crédito** (A9) | Hoy la importación trae todo; la API solo filtra al leer (regla `exclude_sapira_invoices` en `records`, por `invoices.odoo_invoice_id`) |
| L2 | **Estados de pago desde el ERP**, sincronización continua (A9) | Todo queda pendiente de pago y no se concilia; una actualización masiva sirve una vez |
| L3 | **Integración Kame** (TiMining) con el mismo esquema de adaptador (A9) | Declarar sus objetos (registros y mapeos) en un adaptador nuevo |
| L4 | **Sync del CRM por `sellers.crm_owner_id`** (D7) | Hoy busca por email/nombre e inventa `sf_<ownerid>@salesforce.local` (en minúsculas: el id del CRM distingue mayúsculas). Con la columna nueva, buscar primero por `crm_owner_id` y guardarlo al crear. Sin esto, fusionar vendedores (`POST /settings/sellers/merge`) puede volver a crear duplicados |
| L5 | **Etapas del CRM configurables en la corrida diaria y en la importación a revisión** | `holding_integration_settings.settings.opportunity_stages` hoy solo lo usa "Traer oportunidades" (vista previa). `syncOpportunitiesToStaging` y la corrida diaria siguen con `SALESFORCE_WON_STAGES`: una oportunidad de otra etapa se ve en la vista previa pero no entra a revisión |
| L6 | **Respetar descartes y reglas de exclusión en los procesos que no aceptan ids** | `integration_record_discards` y las reglas (`holding_integration_settings.settings.rules`) se aplican al leer y al importar por ids (clientes del ERP, oportunidades y cuentas del CRM). `InvoiceProcessingService.startAsyncProcessing`, `StripeSyncService.syncAll` e `integrateSapiraQuantities` procesan todo lo listo |
| L7 | **Respetar `holding_integration_settings.auto_enabled` en los crons de Salesforce, BigQuery y Stripe** (tu plan, paso 3) | El switch ya se escribe desde Integraciones (también para `stripe`, que entra al CHECK con la migración I2); hoy solo el envío a Odoo lo mira |
| L8 | **`StripeService.getProducts` toma una sola cuenta activa** | Integraciones lista productos por cada cuenta con su clave (lectura); el mapeo (`stripe_product_mappings`) no guarda la cuenta |
| L9 | **Locks con varias réplicas** | "Sincronizar ahora": ERP y CRM usan Mongo (jobs `running` < 3 h); Stripe, logs `running` < 2 h y `stripe_sync_jobs`; almacén de datos, lock en memoria de la réplica (igual que su cron) |
| L10 | **Consulta del almacén de datos sin filtro de holding** | `ingestSapiraQuantities` lee `finance.sapira_base` por fecha sin acotar al holding: con dos holdings con conexión, ambos ingieren las mismas filas |
| L11 | **Cifrado de claves** | Las nuevas rutas no devuelven claves, pero en la base siguen en texto plano (salvo la contraseña del CRM) |

Copys de `translateErpError` (`erp-error-translation.ts`): los pasos que mandaban a "Integraciones › Odoo" ahora mandan a
"Integraciones › ERP › Mapeos" (producto, impuestos, compañía) o "› Configuración" (conexión). El resto del mensaje sigue igual.
`MAP_PRODUCT_STEP` de Contratos (módulo cerrado) sigue diciendo "Integraciones › Odoo" hasta el OK de Domi; el front lo pasa por `sinMarcas`.

**Cambios en la sincronización de Salesforce (cuentas), OK de Domi 03-10.** Sí tocan lógica de integración, en
`salesforce-sync-complete.service.ts` y `utils/salesforce-transformers.ts`, con tests:

1. **Clasificación de cuentas (`classifyAccountStaging`).** Una cuenta con cliente existente pasa a `update` solo si hay un cambio que la
   importación **aplica**. Antes, 22 cuentas de SimpliRoute quedaban en `update` para siempre: importar las dejaba en `processed` y la
   siguiente clasificación las volvía a marcar. Las reglas:
   - En la razón social, `legal_name`, `legal_address` y `country` con valor en Sapira no cuentan como cambio, porque
     `createOrLinkClientEntity` los conserva.
   - Los demás campos se comparan normalizados: sin mayúsculas, tildes ni espacios repetidos. El identificador tributario se compara con
     `normalizeTaxId`.
   - El `client_number` igual al id de la cuenta (el respaldo `client_number_fallback`) no cuenta como cambio si ya hay uno.
   - Una sola función (`compareAccount` + `accountFieldChanges`) alimenta la clasificación y la vista de diferencias de Integraciones
     (`GET /integrations/crm/records/account/:id/changes`).
2. **Importación de cuentas** (`syncAccountFromData`, usada por `processAccountsStaging` y por la cuenta de cada oportunidad):
   - El id de la cuenta del CRM, usado como `client_number` de respaldo, ya **no reemplaza** un número existente, ni del cliente ni de la
     razón social. Solo completa uno vacío.
   - `normalizeTaxId` quita el prefijo `RUT`, `RUT:` o `R.U.T.` cuando lo que sigue es un RUT chileno (7–8 dígitos + dígito verificador).
     Así no recorta un RFC que empiece con esas letras. Se aplica al buscar la razón social y al guardar.
   - Ese normalizador también lo usan `canonicalVat` (búsqueda de partner en Odoo) y `normalizeTaxIdsForHolding`.

Resultado en prod (SimpliRoute, solo lectura): de las 22 cuentas `update`, 5 siguen con cambios reales (giro, nombre comercial, datos de
una razón social sin completar) y 17 pasarán a `processed` en la próxima clasificación.

**Cotizaciones del CRM protegidas, OK de Domi 03-10.** Toca lógica de integración en `salesforce-sync-complete.service.ts`
(`syncQuote`, clasificación de oportunidades), `salesforce-typeorm.service.ts` (`manager` opcional), el worker de ejecuciones y
`utils/crm-quote-snapshot.ts` (nuevo, puro), con tests. Migración `1791100000000-CrmQuoteSnapshot` **sin aplicar** (va antes del deploy:
la entity ya declara las columnas).

1. **Un solo lugar.** `syncQuote` es el único punto que crea o actualiza cotizaciones desde el CRM: lo usan la sincronización diaria,
   `process_final`, `retry_full`, `POST /salesforce/staging/process`, `/salesforce/staging/opportunities/process*`, `/retry` y
   `POST /salesforce/sync-complete`. Antes, todas las rutas manuales actualizaban una cotización existente si la clasificación la marcaba
   `update` (comparación contra la cotización actual), **también con contrato**, y la devolvían a la etapa "Enviada" pisando sus notas.
2. **Protegidas: nunca se actualizan.** Cotización con contrato vigente (`contracts.quote_id` o por `contract_items.quote_item_id`) o en una
   etapa de tipo `contract_created` ("Procesada previamente"). La oportunidad queda `processed` con "La cotización ya tiene contrato: no se
   actualiza" / "Procesada previamente: no se actualiza"; no se toca ni el cliente. Se revalida dentro de la transacción.
3. **Cambio real = el CRM cambió desde la última importación.** `salesforce_opportunities_stg.last_imported_snapshot` guarda lo que llegó
   del CRM al crear o actualizar la cotización (encabezado mapeado sin notas + dueño + cuenta + ítems resueltos), en la misma transacción.
   La clasificación compara lo que llega con eso, no con la cotización: lo editado en Sapira se respeta mientras el CRM no cambie. Igual →
   `processed` "Sin cambios"; distinto → `update` "Por revisar". Sin snapshot (cotizaciones de antes) → `processed` y lo que llegó queda
   como base (`baseline: true`, `last_imported_at` NULL): es la única escritura de snapshot fuera de una importación.
4. **Solo con confirmación por ids.** Una cotización existente se actualiza solo en una ejecución `process_final` con
   `salesforce_sync_runs.confirmed_by` (`POST /integrations/crm/records/import` con `ids` + `confirm_updates: true`). Nunca en la diaria,
   con `all` (ahora toma solo `create`), con `retry_full` ni por `/salesforce/*`: ahí la oportunidad sigue `update` y el ítem de la
   ejecución termina `completed` con el aviso en `error_message`.
5. **Al aplicar**: encabezado sin `quote_stage_id` ni `notes`, ítems (`createQuoteItems` con el `manager`), evento `UPDATED` en
   `quote_events` (`actor_id` = quien confirmó, `reason` "Sincronización del CRM", `metadata.source = 'crm_sync'`, `changes` /
   `item_changes` con antes/después como la edición manual, `crm_changes` con lo que cambió en el CRM) y snapshot nuevo: **una
   transacción**. Crear también es una transacción (cotización, vínculo, ítems, snapshot); el conflicto de `createQuoteIfAbsent` la revierte.
6. La diaria sigue siendo solo inserción, pero ahora clasifica las existentes con la misma regla (antes las marcaba "omitida").

Encontrado en prod (SimpliRoute, solo lectura, 03-10): 401 cotizaciones del CRM; 144 con contrato (116 en "Contrato creado" y **28 en
"Enviada"** con contrato, todas importadas desde el CRM después de crear el contrato: probablemente la importación les devolvió la etapa) y
24 en "Contrato creado" sin contrato. `quote_events` tiene 1 fila en toda la base: no hay historial de ediciones. Las 28 no se reparan:
quedan para la auditoría previa al switch (`estado-v2-y-plan-switch.md` §5).

## 15. Facturación usa las mismas reglas de permisos que el resto de la API (04-10-2026)

**Facturación usa ahora las mismas reglas de permisos que el resto de la API; hoy ningún usuario real cambia de acceso (verificado 04-10
en SimpliRoute, TiMining y uPlanner).**

- `BillingPermissionGuard` (`src/modules/billing/billing-permissions.service.ts`; rutas `/billing/*`, conciliación y `/budgets/*`) ya no
  tiene consulta propia: valida con `PermissionsService` (`src/guards/permissions.service.ts`, de `GuardsModule`, global), igual que
  `@RequirePermission`. Se eliminó `BillingPermissionsService`; `@RequireBillingPermission` y los códigos `VIEW_FACTURACION` /
  `EDIT_FACTURACION` no cambian.
- Reglas que ahora aplica (antes comparaba el código exacto): super admin pasa; `ALL_PERMISSIONS` cubre Facturación; `EDIT_FACTURACION`
  incluye `VIEW_FACTURACION`; el rol (`users.role_id`) cuenta solo si es del holding activo (`roles.holding_id`).
- El 403 usa el mensaje común: "No tienes permiso para ver la facturación · pídeselo a un administrador" (antes "…de este holding").
- Tests: `billing-permissions.service.spec.ts` (comodín, Editar incluye Ver, rol de otro holding, super admin, mensaje) y el cableado en
  `billing.module.spec.ts` / `budgets.service.spec.ts`.
- Si algo tuyo inyectaba `BillingPermissionsService`, usa `PermissionsService.assert(authId, holdingId, ['VIEW_FACTURACION'])`.

Relacionado (mismo día): los enlaces que arma la API (tareas, actividad del Cliente 360, alertas nuevas, correos de alerta y resumen)
apuntan a las rutas finales del front (`/facturacion`, `/contratos`, `/conexiones`, `/notificaciones`…) en vez de `/lab/...`. Las
alertas ya guardadas no se tocan: el front redirige las rutas viejas.

## Pendiente para Leon (no hecho): estado de la NC de anulación al emitirse

Cuando la NC de anulación creada desde el Contrato 360 (`credit_type = cancellation`, nace Por Emitir con referencia a su factura) se
emite hacia Odoo y recibe folio, debe pasar a `Cancelada` igual que su factura original (par cerrado, como las NC de anulación
históricas): así ninguna de las dos suma en lo facturado ni entra en vencimientos o cobranza. La NC de descuento (`credit_type =
discount`) sigue su estado emitido normal. Decisión de Domi 01-10.
