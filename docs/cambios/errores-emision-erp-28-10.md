# Emisión automática al ERP: errores que la usuaria pueda leer (Domi 28-10)

Corrida de emisión automática del 28-10-2026 (~11:00 UTC), SimpliRoute: 30 facturas con error. Las usuarias vieron 30 alertas iguales
"No se pudo enviar la factura al ERP. Revisa el detalle técnico o vuelve a intentarlo en unos minutos" sin detalle técnico visible.

## Casos reales

1. **Chile, Simplit SpA, 29 facturas.** `account.move` creado; `action_post` falla con *"No hay CAFs disponible para el folio 28401 en la
   secuencia de Electronic Invoice. Por favor subo un archivo CAF o solicite uno nuevo en el sitio www.sii.cl (Code: 2)"*. El move queda
   en borrador con `name = '/'`. En Sapira las 29 quedaron **Enviada** con `invoice_number = 'FAC 028401'`, todas iguales
   (`odoo_invoice_id` 201185–201214). Mismo patrón el 01-07 (CAF agotado en 27500, 14 facturas "FAC 027501"; hoy corregidas a mano).
2. **México, SimpliRoute S.A.P.I. de C.V., 1 factura** (e4fbeb9a…, Bord S07051). Odoo publica el move A10166 pero el PAC rechaza el CFDI:
   *"Código: CFDI40147 - El campo DomicilioFiscalReceptor del receptor, debe encontrarse en la lista de RFC inscritos no cancelados en el
   SAT."* En Sapira quedó **Emitida** con folio A10166 aunque no está timbrada.

## Causa raíz

- **Chile.** La acción automatizada de Odoo dispara el webhook (`/odoo/webhooks`) **dentro** de la transacción de `action_post`, antes de
  que `l10n_cl_edi` lance el error del CAF y Odoo haga rollback: llega `state: posted` con el nombre provisional de la secuencia.
  `processInvoiceStatusUpdate` (`odoo-webhook.service.ts`) lo cree y escribe `Enviada` + `invoice_number`. La secuencia nunca avanzó,
  por eso el mismo folio en las 29. El scheduler, en el catch de `postInvoice` (`invoice-scheduler.service.ts`), solo registra el log y
  la alerta: no revierte `status` ni `sent_to_odoo_at`, así que la factura no vuelve a la cola (`pendingInvoicesQuery` exige
  `sent_to_odoo_at IS NULL`). El catálogo de la alerta promete "Reintentamos en la próxima corrida", que en esta etapa es falso.
- **México.** `emitElectronicInvoiceWithSendWizard` lanza con el Fault del PAC y el catch `emitError` del scheduler escribe `Emitida`
  igual (la rama `rejected` también). El webhook, con el move realmente publicado, pone el folio A10166.
- **Traducción.** `translateErpError` no conocía ninguno de los dos textos ni los `errorType` `odoo_post_exception` /
  `emit_electronic_exception`, así que ambos caían en `unknown` con la frase genérica, y la alerta no muestra `raw`.

## A · Traducción (hecho, sin commit)

`src/modules/invoices/erp-error-translation.ts`:

- Categoría **`folios_exhausted`** (texto con "CAF"): *"Se acabaron los folios autorizados por el SII para facturas electrónicas (siguiente
  folio 28401)"* · paso: *"Solicita un CAF nuevo en sii.cl y cárgalo en Odoo; después confirma allí los borradores que quedaron sin
  folio"* · acción `none` (nada en Sapira lo resuelve). `exhaustedFolios()` saca el folio y el tipo de documento de la secuencia (factura,
  exenta, exportación, NC, ND).
- Categoría **`electronic_rejected`** (texto con CFDI / PAC / timbrado, o `errorType` `electronic_rejection` / `emit_electronic_exception`):
  *"El SAT rechazó el timbrado: el domicilio fiscal (código postal) del cliente no coincide con el registrado en el SAT para su RFC
  (CFDI40147)"* · paso: *"Corrige en Odoo los datos fiscales del cliente según su Constancia de Situación Fiscal y vuelve a timbrar desde
  Odoo"* · acción `client_entity`. `electronicRejectionReason()` traduce los códigos conocidos (CFDI40142/40143/40145/40147) y, para el
  resto, deja el motivo limpio del PAC con el código.
- **`unknown`** ya no es la frase genérica: *"El ERP respondió: <primera frase útil>"* (`cleanErpMessage`, que ahora también quita
  "XML-RPC Fault" y el "(Code: N)" de Odoo). Sin texto sigue "No se pudo enviar la factura al ERP".
- Las dos categorías van antes de las ramas laxas (impuesto, diario, validación) para que no las pisen.

Tests: `erp-error-translation.spec.ts` con los dos textos reales (tabla + describe "corrida del 28-10"), fallback con texto y sin texto.
El front no enumera categorías (`ContratoErpError.category: string`); `erpActionLink` ya resuelve `client_entity` y `none`.

## B · Alerta agrupada por causa, qué hacemos por etapa y detalle técnico (hecho, sin commit)

Corrección a lo dicho antes: el "Qué pasó" del drawer **ya mostraba** el `message` traducido (`resolveTexts` prefiere el del productor
sobre la plantilla); lo que estaba fijo era "Qué hacemos nosotros" ("Reintentamos en la próxima corrida…", falso tras crear el borrador).

API:

- **`src/modules/invoices/odoo-failure-alert.ts`** (nuevo, puro): clave de deduplicación por compañía emisora + día de negocio + etapa +
  causa traducida (categoría + hash del mensaje: las 29 del CAF comparten aviso; dos razones sociales sin vincular no, porque el mensaje
  nombra al cliente); lista `metadata.invoices[]` (tope 200, `invoice_count` con el total); contenido para N facturas: con una, la forma de
  siempre (título con folio y cliente, `open_contract`, `resource_id`); con varias, "No se pudieron enviar N facturas de <compañía> al ERP",
  sin acción ni `resource_id`. `metadata.technical_detail` = `cleanErpMessage(error_message)` (nunca la traza) y `metadata.what_we_do` por
  etapa (`ODOO_FAILURE_WHAT_WE_DO`): antes del borrador "la reintentamos en la próxima corrida"; con borrador "no la reintentamos solos: el
  borrador ya existe en el ERP y un reenvío lo duplicaría…"; publicada sin timbre "cuando se vuelva a timbrar allí, archiva este aviso";
  correo al cliente "la factura ya está emitida; solo falló el correo".
- **`invoice-scheduler.service.ts`**: `createOdooFailureNotification` lee el aviso abierto de la clave (`findOpenByDeduplicationKey`), suma la
  factura y manda el contenido a `createOrUpdate`; `resolveOdooFailureNotifications` además saca la factura de los grupos que la contienen
  (`findOpenWithMember` + `updateContent`) y resuelve el grupo cuando queda vacío.
- **`notifications.service.ts`**: `findOpenByDeduplicationKey`, `findOpenWithMember` (contención JSONB sobre `metadata.<lista>`) y
  `updateContent` (cambia contenido y recurso sin tocar lectura ni gravedad, avisa por socket).
- **`notification-catalog.ts`**: `resolveTexts` acepta `metadata.what_we_do` del productor; la plantilla del tipo pasa a ser honesta ("Si la
  factura no llegó a crearse… la reintentamos…; si ya existe allá como borrador o publicada, no la reenviamos").
- **`erp.adapter.ts`**: el subestado `send_error` de "Factura enviada" encuentra el aviso por `resource_id` **o** por contención en
  `metadata.invoices`.

Front (`app/(protected)/notificaciones`): `_lib/contexto.ts` → `facturasDeAlerta`, `nombreFactura`, `detalleTecnico` (prefiere
`technical_detail`; en alertas viejas, `error_message` sin traza; nunca `error_details.stack`); `AlertaVistaRapida.tsx` → "Ver detalle
técnico" plegable (`DetalleTecnico` de Integraciones) y sección **Facturas (N)** con enlace profundo a cada contrato
(`/contratos/<id>?tab=facturas&invoice=<id>`) cuando hay más de una; con una sola, Datos y "Ver contrato" ya la cubren. Tipos:
`NotificationInvoiceRef`. Centro de ayuda: `docs/documentacion-funcional/notificaciones/README.md`.

Tests: `odoo-failure-alert.spec.ts` (7), `invoice-scheduler.service.spec.ts` (+2: agrupación y achicado), `notifications.service.spec.ts`
(+3 métodos), `notification-catalog.spec.ts` (+1), front `notificaciones-lib.test.ts` (+2) y `Notificaciones.test.tsx` (+2).

**Impacto de B.** Quién más lo usa: `createOrUpdate`/`resolveOpen` no cambian de firma; Kame (`kame-export.service.ts`) usa el mismo tipo con
su propia clave por factura y sigue igual; el correo de alerta (`notification-email.service.ts`) toma `what_we_do` por `resolveTexts` sin
cambios; Integraciones › ERP › Estado lee el aviso con la condición ampliada. Registros: ninguno migrado; las 30 alertas del 28-10 quedan
como están (una por factura, metadata vieja, sin `invoices`): el front las muestra igual que hoy, y el detalle técnico sale de su
`error_message`. Qué cambia para la usuaria: un aviso en vez de 29; "Qué hacemos nosotros" cierto según la etapa; detalle técnico visible.
Riesgo: el cierre automático al enviar bien ahora también achica grupos; si `updateContent` falla, el `warn` del scheduler lo registra y el
envío no se afecta.

## C · Estado al fallar la publicación (hecho, sin commit)

Dato de prod del 28-10 (solo lectura, antes de construir): las 29 de Simplit **ya no** estaban "Enviada FAC 028401": alguien cargó el CAF y
confirmó los borradores en Odoo y hoy figuran Emitida con folios reales FAC 028401–028429 (+ FCXE 000756). Ese Emitida no lo escribió la
API (el scheduler solo lo escribe tras publicar él mismo; el webhook escribe Enviada): llegó por soporte o por el front viejo. Las 30 alertas
seguían abiertas: se resolvieron con OK de Domi y respaldo en `sapira_backups.app_notifications_odoo_failure_20261028`. Las de julio
(FAC 027500–027515) están Pagadas. Hay 7 grupos de folio repetido entre emitidas (16 facturas; 4 con FCXE 000800 en una compañía) que
huelen al mismo patrón: análisis aparte.

Confirmado en código: el scheduler **nunca escribe Enviada**; lo hace el webhook (`posted` → Enviada + `name`) y además reconstruye el
devengo. La acción automatizada de Odoo dispara el webhook dentro de la transacción de `action_post`, con el nombre provisional de la
secuencia, antes del rollback. El catch del scheduler solo registraba log y alerta.

- **`OdooInvoicesService.readInvoiceState`** (nuevo): `state`, `name` y `edi_state` del documento (sin `account_edi`, relee sin el campo).
- **`InvoiceSchedulerService.revertIfNotPosted`**: en los dos caminos de fallo de la publicación (respuesta `success: false` y excepción) relee
  el documento en Odoo. Si **no** quedó publicado y Sapira la tiene como facturada o con un folio distinto al de antes del envío: vuelve a
  **Por Emitir** con el folio previo (NULL en v2), conserva `odoo_invoice_id` y `sent_to_odoo_at` (la cola la muestra "Borrador en ERP" y
  `pendingInvoicesQuery` no la reenvía: no se duplica el borrador) y, si estaba facturada, `revenue_schedule_rebuild(contrato, mes de
  emisión)` como hace el webhook. Si Odoo dice `posted`, no toca nada; si no se puede leer, tampoco. Nunca lanza.
- **Webhook:** `name = '/'` nunca se copia como folio (guard barato; **no cubre** el caso del 28-10, donde llegó "FAC 028401": lo cubre la
  relectura). Cuando una Por Emitir pasa a publicada, cierra sus avisos de envío fallido o la saca del aviso agrupado
  (`detachInvoiceFromOdooFailureAlerts`, compartido con el scheduler; `NotificationsService` inyectado con `@Optional()`, `OdooModule`
  importa `NotificationsModule`).
- **Cola Por Emitir** (`BillingReadService.queueEntries`): para las vinculadas al ERP lee el último intento del log en una sola consulta
  (`InvoiceSchedulerService.lastSendErrors`, `BillingModule` importa `InvoicesModule`) y, si falló, el bloqueo `sent_to_erp_draft` dice
  **"Error al emitir en el ERP: <motivo>"** con el paso siguiente traducido. El front no cambia: ya muestra `message`/`next_step` del
  bloqueo; el chip sigue "Borrador en ERP" con "Restablecer borrador".
- "Qué hacemos nosotros" de la etapa `post_invoice` ahora dice que la factura vuelve a Por Emitir como "Borrador en ERP" y que el aviso se
  cierra al confirmarse el borrador en el ERP.

## D · México publicada sin timbre (hecho, sin commit)

- **`emitElectronicInvoiceWithSendWizard`**: si el wizard lanza (Fault del PAC) pero `readInvoiceState` dice `posted`, devuelve
  `electronic_status: 'rejected'` con el motivo en vez de lanzar; si no quedó publicada, lanza como antes.
- **Scheduler**: rechazo o excepción del timbre → **`Enviada`** (lo que el webhook ya puso), nunca `Emitida`; Emitida solo con timbre
  aceptado / no requerido. Para Métricas, Clientes y cobranza no cambia nada: Enviada ya cuenta como facturada en todos los lectores; cambia
  la etiqueta ("Enviada al ERP") y la vista rápida muestra "El SAT rechazó el timbrado…" (`last_send_attempt`, ya existía).
- **Webhook**: lee `edi_state` (o `l10n_mx_edi_cfdi_state`) si viene en el aviso; publicada + `sent` → Emitida. Hoy la acción automatizada
  no lo manda: pedido a Leon. Mientras, una rechazada y luego timbrada en Odoo queda Enviada hasta que se pague.

Tests: `invoice-scheduler.service.spec.ts` (C: fallo → Por Emitir sin folio + devengo; publicada → no toca; ilegible → no toca; Por Emitir sin
cambios → no reescribe; D: rechazo y excepción → Enviada, aceptado → Emitida; `lastSendErrors`), `odoo-invoices.service.spec.ts`
(`readInvoiceState`, wizard con documento publicado → rechazada), `odoo-webhook.service.spec.ts` (nombre "/", cierre de alertas, `edi_state`),
`billing-read-queue.spec.ts` (bloqueo con motivo), `odoo-failure-alert.spec.ts` (detach). Arranque de la API local verificado tras la DI.

**Impacto de C+D.** Quién más lo usa: `status`/`invoice_number` los leen webhook, backfill, cola (`toIssueGroupOf` → `erp_draft`), Contrato
360 (`erp_sync_state: draft`), consumos y modificaciones (`hasErpDraft`, `erp_draft_stale`), Métricas/Clientes/cobranza (estados
facturados): volver a Por Emitir las saca de facturado, igual que si nunca se hubieran publicado; el devengo se reconstruye. `Enviada` en
vez de `Emitida` no mueve ningún KPI. `sendInvoiceToOdoo` lo llaman la corrida automática, "Enviar ahora" de Contratos y el envío masivo de
Facturación: los tres heredan C y D. Registros: ninguno migrado (las 29 ya estaban emitidas; A10166 queda como decida Domi). Riesgo: si Odoo
no responde a la relectura, la factura queda como la dejó el webhook (igual que hoy) y el log lo dice.

## E · Pendiente (plan, con OK de Domi)

- **E · Resumen de la corrida** por causa ("29 sin folios CAF Chile, 1 timbrado rechazado México") y enlace a las facturas con error, no a
  Por Emitir (`InvoiceNotificationService.sendSchedulerErrorSummary`).
- Datos de prod: A10166 (México, publicada con CFDI rechazado) sigue Emitida; pasarla a Enviada no mueve KPIs y la decide Domi. Las 29 de
  Chile ya estaban emitidas; sus 30 alertas se resolvieron (respaldo arriba).
- Aviso a Leon (`docs/v2-rediseno/cambios-integracion-para-leon.md`): A, B, C y D ya avisados; pedido: que la acción automatizada mande
  `edi_state` para que Sapira pase a Emitida cuando se vuelva a timbrar en Odoo.

## Impacto de A

- **Quién más lo usa.** `translateErpError`: scheduler (`createOdooFailureNotification`, resumen), `last-send-attempt.ts` (detalle de la
  factura en Contratos), `send-now` de Contratos y envío masivo de Facturación (`ContratoErpError`). Solo cambian textos y dos categorías
  nuevas; `raw` sigue igual.
- **Cuántos registros reales toca.** Ninguno: la traducción se calcula al mostrar o al crear la alerta; las 30 alertas del 28-10 conservan
  su `metadata.erp_error` (`unknown`) hasta que se regeneren.
- **Qué lo verifica.** `erp-error-translation.spec.ts` (22 tests), `invoice-scheduler.service.spec.ts` (sin cambios, en verde).
- **Qué doc cambia.** Esta nota. Centro de ayuda (Facturación › Enviar al ERP / Notificaciones) cuando B esté, con los textos finales.
