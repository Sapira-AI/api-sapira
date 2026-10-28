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

## C–E · Pendientes (plan, con OK de Domi y análisis de impacto aparte)

- **C · Estado al fallar `action_post`.** No queda Enviada con folio de borrador: vuelve a Por Emitir con `odoo_invoice_id` guardado,
  `sent_to_odoo_at` limpio y marca de error visible en la cola ("Error al emitir: <motivo>"); el webhook no escribe `invoice_number` si
  `name = '/'` o si el scheduler acaba de registrar el fallo del `post` de esa factura; confirmar el borrador en Odoo tras cargar el CAF
  deja Emitida con el folio real (camino a verificar con test). Lectores de `Enviada`: Métricas, Clientes, cobranza, vencidas, devengo
  (`trigger_rsm_on_invoice_change`): análisis de impacto obligatorio.
- **D · México.** Move publicado pero CFDI no timbrado → no `Emitida`: "Publicada en el ERP, timbrado rechazado: <motivo>";
  `emitElectronicInvoiceWithSendWizard` devuelve `rejected` con el motivo en vez de lanzar.
- **E · Resumen de la corrida** por causa ("29 sin folios CAF Chile, 1 timbrado rechazado México") y enlace a las facturas con error, no a
  Por Emitir.
- Datos de prod: las 29 "Enviada FAC 028401" y la A10166 se corrigen con OK explícito de Domi y respaldo (sin folio, de vuelta a Por Emitir
  o Enviada según lo que haga la usuaria en Odoo).
- Aviso a Leon (`docs/v2-rediseno/cambios-integracion-para-leon.md`): A es la ampliación de patrones que pedía su §9; C y D tocan
  scheduler y webhook y se le avisan al construirlos.

## Impacto de A

- **Quién más lo usa.** `translateErpError`: scheduler (`createOdooFailureNotification`, resumen), `last-send-attempt.ts` (detalle de la
  factura en Contratos), `send-now` de Contratos y envío masivo de Facturación (`ContratoErpError`). Solo cambian textos y dos categorías
  nuevas; `raw` sigue igual.
- **Cuántos registros reales toca.** Ninguno: la traducción se calcula al mostrar o al crear la alerta; las 30 alertas del 28-10 conservan
  su `metadata.erp_error` (`unknown`) hasta que se regeneren.
- **Qué lo verifica.** `erp-error-translation.spec.ts` (22 tests), `invoice-scheduler.service.spec.ts` (sin cambios, en verde).
- **Qué doc cambia.** Esta nota. Centro de ayuda (Facturación › Enviar al ERP / Notificaciones) cuando B esté, con los textos finales.
