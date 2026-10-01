# Spec · Facturas en el Contrato 360 (pestaña Facturas, v2)

> 29-09-2026 · para Domi y quienes implementen. Define **qué operaciones sobre facturas viven en el Contrato 360 › Facturas** del
> front nuevo (`front-sapira/app/(protected)/lab/contratos`) y cuáles **esperan al módulo Facturación**. Mejora el front viejo
> (`sapira-ai/src/components/contratos/detail/tabs/ContratoFacturasTab.tsx`), no lo copia, y cierra los bugs documentados.
> Fuentes: [`auditoria-contratos.md`](./auditoria-contratos.md) §2c, S4, S6/S7 · [`flexibilidad-con-trazabilidad.md`](./flexibilidad-con-trazabilidad.md)
> (casos 1, 2, 5 y 6) · [`mapa-v2-contratos.md`](./mapa-v2-contratos.md) §2c F1–F5, §3, §3b, §4 · [`spec-pricing-v2.md`](./spec-pricing-v2.md) §4.3–4.4 ·
> [`spec-modificaciones-contrato-v2.md`](./spec-modificaciones-contrato-v2.md) §4 · [`plan-coexistencia-funciones.md`](./plan-coexistencia-funciones.md) §2c ·
> `sapira-ai/docs/ROADMAP-OPERATIVO.md` · benchmarks de [agrupación/edición](./benchmarks/benchmark-facturacion-agrupacion-edicion.md) y
> [FX/emisión](./benchmarks/benchmark-metering-pricing-fx-emision.md) §4–5. Los Supuestos de la primera versión quedaron resueltos con las **Decisiones de Domi (29-09)** en §7.

## 0. Punto de partida en v2 (lo que ya existe)

- Lectura: `GET /contracts/:id/invoices` (paginado, filtro por estado, conteos) y `GET /contracts/:id/invoices/:invoiceId` (encabezado,
  líneas con `pricing_breakdown`/`quantity_source`, `references[]` de `invoice_references` + `billing_references`, `adjustments[]`,
  `related_documents[]`) en `src/modules/contracts/contracts.service.ts:889-1120`. Front: `components/ContratoFacturasTab.tsx` (tabla por
  período: folio, estado, período, emisión, vencimiento, monto, moneda/TC, total, consumo, ERP, bloqueos) y
  `components/detalle/FacturaVistaRapidaDrawer.tsx` (solo lectura; "Ver en Facturación" → app vieja).
- Bloqueos por factura ya calculados en `contract-360.ts:368-406`: `needs_reference`, `fixed_fx_without_rate`, `no_erp_partner`,
  `item_without_product`, `past_issue_date`.
- Escritura que ya sabe hacer la API: recalcular la Por Emitir por consumo (`consumption.service.ts`, §4.3), complementaria y **reemisión =
  NC espejo + PE nueva** (`insertMirrorCreditNote`, `contract-changes.service.ts:982`), cambio mínimo sobre Por Emitir en modificaciones,
  `billing_conditions` y `change_entity` (`POST /contracts/:id/changes`); todas con `set_config('sapira.writer','api')` y evento en
  `contract_lifecycle_events`.
- Envío al ERP: solo el scheduler (`POST /invoices/scheduler/send`, `invoice-scheduler.service.ts:126-800`): Por Emitir del mes en curso con
  `issue_date ≤ hoy` y `sent_to_odoo_at IS NULL`, FX resuelto al enviar (`:1192-1250`), borrador en Odoo → `odoo_invoice_id` +
  `sent_to_odoo_at`; `auto_invoice` → `auto_post`. No hay "enviar esta factura ahora" ni reset.

## 1. Inventario: qué hace el front viejo con las facturas de un contrato

| Operación (front viejo) | RPC / escritura | Uso real (auditoría §2c/S4b) | Bugs conocidos (cita) | Qué debe ser en v2 |
|---|---|---|---|---|
| Cambiar fecha de emisión (fila y masivo, `EditInvoiceDateModal`) | `UPDATE invoices SET scheduled_at, original_issue_date, issue_date[, due_date]` directo (`ContratoFacturasTab.tsx:490-512`); `reschedule_invoice_safe` casi sin uso (1) | El camino vivo es el UPDATE sin permiso ni evento | Pisa `original_issue_date` (se pierde la fecha original); vencimiento puede quedar ≤ emisión (91 PE, ROADMAP "cuadre a"); PE que cae fuera del mes no entra al scheduler (B6, regla 31-08) | **Reprogramar** (§3.3): conserva `original_issue_date`, recalcula vencimiento, evento |
| Tipo de cambio de la factura (`EditInvoiceFxModal`: tasa o "subtotal exacto") y "Tipo de cambio de facturación" del contrato (`InvoiceFxBulkUpdate`) | `apply_fixed_fx_to_contract(p_contract_id, p_fx_rate, p_policy, p_invoice_ids, p_target_amount)` (`useContractInvoices.ts:763-832`) | 37 contratos `fixed`, último 22-09 | Fija la política de **todo el contrato** antes de validar (§2b); "fijo" sin tasa sale a spot en silencio (B3, 11 PE); FX clonado de la última factura (79 PE spot con FX pegado); IVA del header sin × fx (B2) | **FX por factura** (§3.2, F5/S6-1): política y tasa viven en la factura; `net_exact` para OC |
| Moneda de facturación del contrato (`InvoiceCurrencyBulkUpdate`) | `POST /invoices/bulk-update-currency` (API) + `UPDATE contracts` del front | S6: aplica a todas las PE, incluso enviadas; sin holding; fuerza `auto_send_to_odoo = true` | U3 (líneas en moneda ≠ header), estado mixto (68 PE) | Ya cubierto por `billing_conditions.invoice_currency` (modificaciones §4); **no** se repite aquí |
| Descripciones de líneas (fila y masivo, `EditInvoiceItemDescriptionsModal`: editar/prefijar/sufijar) | `invoice_items_bulk_update_description(p_contract_id, p_updates)` | **La más usada**: 227 / 121 contratos | Regenerar pierde la cuenta (Tanda 3 #2, ya en prod 22-09) y pisa textos manuales (límite documentado §6.1); no hay "regenerar" con formato | **Constructor de descripción** (§3.6): plantilla por contrato con bloques y contador del DTE; línea editada a mano protegida (`description_locked`) |
| Términos y condiciones (fila, masivo, "todas Por Emitir") | `invoice_bulk_update_terms` | 1 uso (07-05) | — | Queda como campo del **editor de borrador** (§3.4); lo masivo lo absorbe `billing_conditions` |
| Cambiar receptor / emisor (`EditInvoiceEntityModal`) | `invoice_reassign_entity` | 35 / 9 contratos | No actualiza RUT, IVA, export ni serie (S4b) | Fila: campo **receptor** del editor de borrador (§3.4, re-deriva RUT/documento); contrato entero: `change_entity` (M5) |
| Reestructurar cronograma (`restructure/*`, modos Organizar / Fechas / Montos, mover, dividir, unir, cuotas) | `invoice_reschedule_items(p_contract_id, p_target_state)` (`useRestructureDraft.ts:1853`) | 74 / 45 contratos, última 22-09 | **U1** (`:163-165` reescribe `qty = contract_items.quantity` en toda línea; 53 PE en riesgo; regresión Salvador/NSAgro, ROADMAP #3) · **U2** validador compara headers (Alicorp, ROADMAP #4) · clona header con vencimiento NULL (18 PE) · clona FX (`:122-133`) | **Reorganizar** (§3.5) + **Editar borrador** (§3.4) con preview, cambio mínimo (F3) y conciliador de desvíos (Decisión 1) |
| Editar PE como un todo (`EditInvoiceModal` → `edit_pending_invoice`) | `edit_pending_invoice(p_invoice_id, p_items, p_issue_date)` | **0 usos** (modal nunca se abre); a retirar (coexistencia §2c) | FX 1 en PE con conversión pisa montos de contrato; no bloquea unificadas | **Editar borrador** (§3.4, F2): líneas, cantidades, unitario, descuento, glosa, receptor, fechas; desvío conciliado con motivo (`plan_deviation`) |
| Consolidar / desunificar (`ConsolidateInvoicesModal`, Desconsolidar) | `consolidate_invoices_simple`, `unconsolidate_invoices_simple`; unificar vive en Facturación (`unify_invoices_multi_contract`) | Consolidar: 24, ninguna desde 06-08 (**S4-6: se elimina**); unificar 14 | DELETE físico sin mirar `odoo_invoice_id`; guard U3 mira la línea consigo misma; pierde OC/HES | Un contrato: **Reorganizar › juntar** (§3.5). Multi-contrato: Facturación (hasta M3 + ruta declarada) |
| Restablecer borrador de Odoo (`reset_invoice_odoo_draft`) | `reset_invoice_odoo_draft(p_invoice_id)` (`ContratoFacturasTab.tsx:232-251`) | No medible (log en Mongo) | **B6**: no toca Odoo (borrador huérfano), no limpia folio ni FX/montos del envío; el scheduler la reenvía sola → **duplicado** (§2c) | **Retirar del ERP** (§3.1) solo cuando Odoo cancele el borrador por API; hasta entonces aviso sin botón (Decisión 2) |
| Auto-envío / auto-emisión (switches) | `UPDATE contracts` directo + `PATCH /invoices/:id/auto-invoice` | 408 contratos con auto-envío | NULL = encendido (`:196`); defaults (S6-10) | Ya cubierto por `billing_conditions` y `PATCH /invoices/:id/auto-invoice`; en el 360 solo se muestra (chip) con enlace a Condiciones |
| Emisión manual con división (`emit_invoice_manually`), emitir masivo (`bulk_emit_*`), NC (`create_credit_note_safe`), ajuste a lo emitido (`adjust_issued_invoice`) | Facturación (`invoiceAdvancedService.ts`) | Manual 24 (**camino principal**: 2 de 3 clientes sin ERP, S4-14); división 0; NC 112; ajuste 0 | División copia moneda factura al campo de contrato; NC IVA en moneda contrato y `p_nc_fx_rate` invertido (ROADMAP #10); ajuste sin uso | **Registrar emisión externa** (§3.1) y **anular/reemitir** (§3.8) en el 360; NC parcial, ND y "ajustar a lo emitido" → Facturación |
| Referencias OC/HES (`InvoiceViewModal`, `InvoiceBulkActions` `references`) | INSERT/DELETE directos en `invoice_references`; `requires_references_for_billing` | Solo desde Facturación; Contrato 360 v2 las lee | Unificar las pierde; sin OC "parcial por monto" (caso 6) | **Referencias por factura** (§3.7a) + **facturar parcial por OC** con línea visible ↔ internas (§3.7b) |
| Duplicar / eliminar PE · Generar facturas faltantes | INSERT/DELETE directos (`useContractInvoices.ts:871`) · `generate_missing_invoices_for_contract` | Duplica **en cualquier estado** · botón muerto | Sin evento; agujero de trazabilidad | **No existen** en v2 (una factura nace del generador al activar o de Reorganizar › dividir; borrar = Reorganizar deja vacía → cancelada; huecos = alerta) |

## 2. Corte: qué vive en el 360 y qué espera a Facturación

**Criterio**: todo lo que actúa sobre **una factura de este contrato o su cronograma** (fechas, líneas, FX, glosa, receptor, referencias,
enviar/retirar del ERP, anular y reemitir, juntar/dividir dentro del contrato) vive en **Contrato 360 › Facturas**. Lo **transversal**
(bandeja de emisión masiva entre contratos, cobranza y pagos, sincronización global con el ERP, NC/ND sueltas, consolidación entre
contratos, cierre de períodos) vive en **Facturación**. Regla de la casa: sin placeholders; lo que no se construye no muestra botón.

| En Contrato 360 › Facturas (v2) | Espera al módulo Facturación |
|---|---|
| Enviar al ERP ahora / registrar emisión externa (§3.1); Retirar del ERP **oculto** hasta la Decisión 2 (aviso sin botón) | Bandeja "por emitir hoy" multi-contrato, job masivo del scheduler, reporte de envíos (`/invoices/scheduler/report`) |
| Tipo de cambio de una o varias PE del contrato (§3.2) | Tasas oficiales por país, backfill de 79 PE con FX pegado (S4-12, sesión de datos) |
| Reprogramar emisión (§3.3), "mover al mes siguiente" masivo dentro del contrato | Aviso de cierre de mes con lista global de PE no emitidas (S6 propuesta 6, se conecta con cierre S5) |
| Editar borrador como un todo + conciliador de desvíos con motivo (§3.4) | Emisión con folio por integración distinta a Odoo, facturación electrónica nativa (#22) |
| Reorganizar el cronograma del contrato: juntar períodos, dividir, mover ítem (§3.5; reemplaza Reestructurar) | Unificar / desunificar entre contratos (hasta M3 + A.5), consolidación parent/child |
| Constructor de descripción: plantilla por contrato, selección o factura (§3.6) | Plantilla por **holding** en Configuración (nivel superior de la herencia) |
| Referencias OC/HES y facturar por OC con línea visible ↔ líneas internas (§3.7) | Agente de proformas / extracción de OC desde correo (A.11 fase 2), gate global "sin OC no se envía" por compañía |
| Anular con NC espejo y reemitir (§3.8) | NC parcial (descuento) con devengo `impact_month/defer_forward`, **ND**, "ajustar a lo emitido", NC a Odoo como `out_refund` (S4-8, Leon) |
| Vista rápida como punto de entrada a todo (§5), columna "Desvío" y desplegable de líneas internas | Cobranza: pagos, conciliación, AR, estado de pago desde Odoo (ROADMAP #7) |

Lo de la derecha no tiene botón en el 360; una unificada muestra "documento unificado: gestiónalo en Facturación" con enlace `facturacionHref`.
## 3. Diseño de cada operación del 360

Convenciones comunes (todas): **preview** antes de aplicar (misma forma que `POST /contracts/:id/changes/preview`: `invoices {updated,
created, cancelled, credit_notes}`, `warnings[]`, `blockers[]`); **una transacción** con `sapira.writer = 'api'` y `FOR UPDATE` de la factura
(y del contrato cuando toca varias); **evento** en `contract_lifecycle_events` con `event_type` propio, `metadata { invoice_id(s), before,
after, reason }` y usuario (el `Historial` de la factura en la vista rápida lo lee); **encabezado = Σ líneas** con la convención FX (misma
moneda → 1 y montos llenos; conversión → `NULL` en spot o valorizado con la tasa de la factura; nunca mixto, nunca clonado). **Convención
única del encabezado (01-10)**: `headerFromLines(lines, { sameCurrency, fx, taxRate })` (`consumption.ts`) = Σ de los montos **ya redondeados**
de las líneas (subtotal, IVA y total en moneda de factura; subtotal en moneda de contrato); spot → monto/total en moneda de factura `NULL` y `vat`
en moneda de contrato; los centavos residuales de una conversión a tasa fija van a la línea mayor (`fixedFxLines`, `netExactFx`), nunca al
encabezado. La usan editar, masivo, tipo de cambio, saldo de facturar por OC, emisión externa, anular/reemitir y reorganizar (`headerAmounts`
queda solo para consumo y modificaciones hasta que migren); **emitidas
intocables**; **líneas no afectadas no se reescriben** (S4-2). Bloqueos comunes (409 `code: blocked`): `not_pending` (no está Por Emitir
activa), `unified_invoice` (documento unificado/consolidado: primero desunificar en Facturación), `period_closed`, `legacy_invoice`,
`credit_note` (NC/ND no se editan aquí). Advertencias comunes (piden motivo): `sent_to_erp_draft` (ya está en Odoo como borrador: se
retira y reenvía cuando exista Retirar; hasta entonces el cambio se aplica en Sapira y el aviso pide coordinar el borrador de Odoo con
Leon, §3.1), `manual_edit_overwritten` (la operación pisaría una edición manual del borrador, S4-1).

### 3.1 Enviar al ERP ahora · registrar emisión externa · retirar del ERP

- **Hoy**: el scheduler corre a las 9 y toma solo PE del mes en curso con `issue_date ≤ hoy` (`getInvoicesToSend`); no hay envío puntual.
  Restablecer (`reset_invoice_odoo_draft`) solo pone `odoo_invoice_id`/`sent_to_odoo_at`/`sent_at` en NULL; el borrador sigue vivo en
  Odoo y el scheduler la vuelve a enviar → **dos borradores** (B6; auditoría §2c "puede duplicar").
- **Enviar ahora** (`POST /contracts/:id/invoices/:invoiceId/send`): confirmación con resumen (receptor, documento, total, FX que se
  usará, referencias); reutiliza `sendInvoiceToOdoo` del scheduler para **una** factura con `dryRun=false`. Antes de enviar corre los
  mismos bloqueos que la columna Bloqueos (`no_erp_partner`, `item_without_product`, `needs_reference`, `fixed_fx_without_rate`) más
  `fx_rate_missing` (spot sin tasa oficial del día, benchmark §4: se detiene y avisa; nunca spot con "fijo" sin tasa, B3) y
  `already_sent` (ya tiene `odoo_invoice_id` **o** `sent_to_odoo_at`: ofrece "retirar y reenviar"; el evento `INVOICE_SENT_MANUALLY`
  lleva `before`/`after` de `{ odoo_invoice_id, sent_to_odoo_at }`). `issue_date` en el pasado **no bloquea** el envío manual
  (la usuaria decide; queda evento con la fecha real). Evento `INVOICE_SENT_TO_ERP`. Multi-selección: mismo endpoint por factura en
  serie, resultado por fila (patrón `ResultadoMasivo`).
- **Registrar emisión externa** (`POST …/:invoiceId/mark-issued`, S4-14): para compañías sin ERP o emitidas fuera de Sapira. Body
  `{ issue_date, invoice_number, fx_rate?, notes? }`; pasa a `Emitida`, congela vencimiento, **sin división** (S4-14: se quita). Evento
  `INVOICE_ISSUED_EXTERNALLY`. **Solo registra (decisión de Domi 01-10)**: folio, fecha y la tasa realizada; **nunca reescribe líneas ya
  valorizadas**. Si los montos en moneda de factura están en `NULL` (spot) los completa (líneas y encabezado) con `fx_rate` (o la tasa de la
  factura) y escribe la tasa; si ya existen (fija, neto exacto, facturada por OC) quedan intactos y, si `fx_rate` difiere de la guardada, avisa
  `fx_mismatch` ("La tasa informada no coincide con la de la factura: ajusta la factura antes con las opciones disponibles") sin cambiar nada.
  Encabezado = Σ líneas. Una factura por OC se puede registrar (no se reescribe). `pdf_url` no se usa.
- **Retirar del ERP** (`POST …/:invoiceId/erp-withdraw`) — **no se muestra hasta que Leon confirme** que Odoo permite cancelar el borrador
  por API (S6-11, pendiente #10; Decisión 2). Mientras, la fila y la vista rápida de una PE con `odoo_invoice_id` muestran el aviso
  "enviada al ERP; para retirarla, coordinar con Leon" (sin botón) y `reset_invoice_odoo_draft` **no se porta** (evita el borrador huérfano
  y el duplicado de B6). Cuando se habilite: solo si `erp_sync_state = draft` (`odoo_invoice_id IS NOT NULL AND status = 'Por Emitir'`);
  Sapira cancela el borrador en Odoo por API, limpia `odoo_invoice_id`, `sent_to_odoo_at`, `sent_at`, `invoice_number` fantasma y los
  montos/FX escritos por el envío (a `NULL` si es spot), marca `erp_withdrawn_at` y emite `INVOICE_ERP_WITHDRAWN`. Una emitida **no se
  retira**: se anula (§3.8). No hay "retirar igual con paso manual".
- **RSM**: sin cambio. El scheduler ignora facturas con `erp_withdrawn_at` hasta que se editen o reprogramen (evita el re-envío que duplicaba).
- **Restablecer borrador del ERP — ✅ API construida 30-09 (decisión de Domi 30-09, reemplaza por ahora el `erp-withdraw` oculto)**: se usa
  todo el tiempo en el front viejo, así que se porta la acción de `reset_invoice_odoo_draft` **con la trazabilidad que no tenía**.
  `POST /contracts/:id/invoices/:invoiceId/erp-reset` `{ reason?, notes? }` y masivo `POST /contracts/:id/invoices/erp-reset`
  `{ invoice_ids[] (≤200), reason?, notes? }` (las bloqueadas van en `skipped`, `bulk_id` compartido; si ninguna aplica → 409). Solo Por Emitir
  activa del contrato vinculada al ERP (`odoo_invoice_id` o `sent_to_odoo_at`). Bloqueos: `not_pending`, `not_sent_to_erp`, `unified_invoice`,
  `legacy_invoice`, `credit_note`, `period_closed` (fecha de emisión en período cerrado). Acción (una transacción, `setApiWriter` primero,
  `FOR UPDATE`): `odoo_invoice_id = NULL, sent_to_odoo_at = NULL, sent_at = NULL` (igual que la función vieja) y, **si el contrato es spot y la
  tasa la escribió el envío** (ninguna línea con `fx_rate_source` explícito `manual`/`net_exact`, no facturada por OC; `spot_reset`), la factura
  vuelve a leerse spot: `fx_contract_to_invoice`, montos en moneda de factura (líneas y encabezado) y `fx_rate_source/date` de las líneas en
  `NULL`, `vat` en moneda de contrato. Evento `INVOICE_ERP_DRAFT_RESET` con `before`/`after { odoo_invoice_id, sent_to_odoo_at, sent_at,
  fx_contract_to_invoice, fx_rate_source, amount_invoice_currency, vat, total_invoice_currency }`, `spot_reset`, motivo y usuario. Respuesta `{ invoice_id, reset: true,
  previous_odoo_invoice_id, before, warnings: [{ code: 'erp_draft_remains', message: 'El borrador sigue en el ERP: elimínalo allí para que no quede
  duplicado al reenviar.' }], event_id, invoice }`. **Pendiente con Leon**: eliminar/cancelar el borrador en Odoo por API (entonces pasa a ser el
  "Retirar del ERP" de arriba). El bloqueo `sent_to_erp_draft` de las demás operaciones (editar, reprogramar, FX, emisión externa) lleva
  `action: 'erp_reset'` para que la UI ofrezca "Restablecer borrador y editar"; lista y detalle exponen `erp_sync_state` (una restablecida lee
  `none`) y `erp_reset_available`.

### 3.2 Tipo de cambio de una o varias PE (spot ↔ fijo · tasa · subtotal exacto)

- **Hoy**: `apply_fixed_fx_to_contract` fija `contracts.fx_invoice_policy` para todo el contrato aunque se toque una factura; la
  política se guarda **antes** de validar (§2b); el scheduler lee la política del contrato (`:1201`). "Subtotal exacto" (`p_target_amount`,
  fx = neto ÷ Σ cantidad × unitario, diferencia de redondeo a la línea mayor) es correcto y se conserva como modo.
- **v2 (F5, S6-1/S6-2)**: `PATCH /contracts/:id/invoices/fx` con `{ invoice_ids[], fx_policy: 'spot' | 'fixed' | 'net_exact', fx_rate?,
  target_net_amount?, reason? }`. Persistencia **por factura**: `invoices.fx_policy`, `fx_rate`, `fx_rate_date`, `fx_rate_source
  (contract | manual | official)` (esquema aditivo ya previsto en mapa §6 "`invoices.fx_policy` (+ tasa por factura)"). Reglas:
  `fixed` exige tasa > 0 (400 `fixed_fx_without_rate`); `net_exact` una factura a la vez, multimoneda, neto > 0 (misma matemática de
  `apply_fixed_fx_to_contract:41-112`, incluido el ajuste de redondeo); `spot` deja montos en moneda de factura `NULL` (se valoriza al
  enviar con la tasa oficial de la fecha de emisión, benchmark §4) y **borra** la tasa pegada; IVA del header = Σ IVA de línea **en moneda de
  factura** (cierra B2). El contrato conserva solo su default por par (`contract_fx_period_rates purpose='invoice'`, mapa §3b) que se propone
  a las PE nuevas; el diálogo muestra "tasa fija del contrato para este período: X" como sugerencia.
- **Preview**: por factura, neto/IVA/total antes → después en ambas monedas, y aviso `sent_to_erp_draft` si ya está en Odoo (se retira y
  reenvía). **Evento** `INVOICE_FX_CHANGED` (política y tasa antes/después). **RSM**: no cambia (el devengo va en moneda de contrato y
  compañía). **Bloqueos**: comunes + `same_currency` (no aplica FX) + `uf_invoice_currency` + `period_closed` (fecha de emisión en período
  cerrado). **Montos (01-10)**: tasa fija = líneas × tasa con el residuo de centavos (subtotal e IVA) en la línea mayor; neto exacto sobre el
  **unitario efectivo** (subtotal ÷ cantidad: el descuento de la línea se conserva); encabezado = Σ líneas (`headerFromLines`).
- Transición: `calculateInvoiceAmountsAtIssue` lee primero `invoices.fx_policy` y solo si es `NULL` la del contrato (coexistencia §2c "U12/B3").

### 3.3 Reprogramar (fecha de emisión)

- `POST …/:invoiceId/reschedule` `{ issue_date, due_date?, reason }` (masivo `{ invoice_ids[], shift: { months: 1 } | issue_date }` para
  "mover al mes siguiente", S6 propuesta 6). Escribe `scheduled_at = issue_date = nueva`, **conserva `original_issue_date`** (solo se fija
  la primera vez; hoy el UPDATE directo la pisa), vencimiento = nueva emisión + condiciones de pago del contrato (México +1 mes; nunca `+30`
  fijo; `due_date` del body lo sobreescribe; `due_before_issue` bloquea). **No** toca período ni líneas; el RSM solo se reconstruye si la
  factura lleva descuento puntual (`nc_revenue_treatment`, su ajuste se ancla al mes de emisión) desde el menor mes de emisión (antes/después); la vista rápida ya muestra
  "Reprogramada (original dd/mm)". Evento `INVOICE_RESCHEDULED` (reemplaza `invoice_reschedules` + `reschedule_invoice_safe`). Bloqueo
  `period_closed`; aviso `past_issue_date` (el scheduler no la tomará; "Enviar ahora" sí).

### 3.4 Editar una PE como un todo (F2, S4-1) · conciliador de desvíos

- `POST …/:invoiceId/edit/preview` y `PUT …/:invoiceId` con `{ lines[{ id?, contract_item_id, description, quantity, unit_price,
  discount_pct, billing_period_start, billing_period_end, amount_basis: 'unit_rate' | 'exact_total', exact_total? }], issue_date?,
  due_date?, client_entity_id?, invoice_terms_and_conditions?, notes?, deviation?: { type, reason, revenue_treatment? } }` (forma final en
  "Etapa 4 construida", abajo). **Cada línea sigue
  ligada a su ítem sin excepción** (obs. Domi 24-09, Decisión 5): `contract_item_id` obligatorio, líneas nuevas solo de ítems vigentes; la
  "línea informativa monto 0" queda **descartada**. Una línea con cantidad o consumo **cero** no se borra: queda oculta (`is_visible = false`
  derivado de `quantity = 0`, sin columna; sigue en Sapira para trazabilidad y devengo; no se ve en el documento ni debe viajar a Odoo —mapper
  pendiente con Leon). `exact_total` fija el subtotal y deriva el unitario.
- **Invariantes que no se tocan**: estado, tipo de documento y `export_type` (`billing_conditions`), moneda de contrato y de factura,
  política/tasa FX (§3.2), `original_issue_date`, vínculos NC/original, `pricing_breakdown` de líneas con modelo de precio (cambiar cantidad
  de una línea `metered` deriva a Consumos; bloqueo `metered_line_use_consumption`).
- **Conciliador de desvíos** (reemplaza el validador "no empeorar"; flexibilidad casos 1 y 5): **nunca bloquea** por diferencia contra el
  plan; bloqueos duros solo por invariantes (emitidas intocables, header = Σ líneas, moneda y documento coherentes, período cerrado). Al
  guardar una PE distinta al plan (Σ líneas por ítem vs. lo que el generador esperaría para el período, `billing-engine`) pide un **motivo
  tipado** (`deviation.type`): `discount` (descuento puntual) · `upsell` · `downsell` · `correction` (motivo libre). ~~`invoices.plan_deviation`
  jsonb~~ e ~~`invoice_items.source`~~ **no se crean** (Domi 30-09, sin campos duplicados): el motivo va en la tabla existente
  `invoice_adjustments` (type, amount_diff, notes = motivo, adjusted_by) y la línea tocada queda `invoice_items.quantity_source = 'manual'`;
  chip **"Desvío"** en tabla y vista rápida desde el último ajuste; las PE que se desvían **sin motivo** (heredadas de ediciones en Odoo o
  cuadres manuales) se listan con `GET …/invoices/deviations` y se completan con `POST …/deviation`. Consumos, modificaciones y plantillas no
  pisan líneas `manual` (aviso `manual_edit_kept`). Aplica igual en Editar borrador y en Reorganizar (§3.5).
- **Receptor**: cambiar `client_entity_id` (misma regla de junction de `invoice_reassign_entity`) **re-deriva** RUT, tipo de documento
  sugerido por país, `export_type` e IVA (cierra S4b "no actualiza RUT, IVA, export ni serie") con aviso `document_type_review`.
- **Preview**: antes/después por línea, totales en ambas monedas, desvío por ítem con el motivo a completar. **Evento** `INVOICE_EDITED`
  (before/after, desvío). **RSM**: rebuild de los meses tocados solo si cambió un monto. **Bloqueos**: comunes + `quantity_negative` +
  `deviation_reason_required` (409 si el preview detectó desvío y no llegó motivo). ~~`empty_invoice`~~ lo reemplaza **sin cobro** (abajo).
**Etapa 4 construida (API, 30-09)** — `invoice-edit.ts` (pura) + `one-off-discount.ts` (pura) + `contract-invoice-edit.service.ts`; restablecer
borrador en `contract-invoices.ts`/`.service.ts` (§3.1). Rutas: `POST /contracts/:id/invoices/:invoiceId/edit/preview` · `PUT
/contracts/:id/invoices/:invoiceId` · `POST …/:invoiceId/deviation` · `GET /contracts/:id/invoices/deviations` · `POST
/contracts/:id/invoices/bulk-edit/preview` · `PATCH /contracts/:id/invoices/bulk-edit`.
- **Esquema** (migración `1790680000000-InvoiceEditChecks`, escrita y **sin aplicar**; sin columnas ni tablas nuevas): CHECK
  `invoice_adjustments_type_check` + `correction`; `invoice_items_quantity_source_check` + `manual`; `invoices_nc_revenue_treatment_check` +
  `service_period`. Una línea "oculta" es **derivada**: `is_visible = quantity !== 0` en las respuestas (sin columna `is_visible`).
- **Líneas**: con `id` se actualiza esa línea; sin `id` es nueva y exige un ítem vigente del contrato (`item_not_in_contract`); las omitidas
  quedan igual (nada se borra). Nunca se aplana: `cantidad × unitario × (1 − descuento)`; `exact_total` fija el subtotal y deriva el unitario
  (6 decimales). El usuario edita en **moneda de contrato**; la moneda de factura sigue la convención FX (misma moneda = igual; spot sin tasa =
  NULL; fija = × tasa; nunca el `COALESCE(fx,1)` de `edit_pending_invoice`); IVA por línea con la tasa normalizada; encabezado = Σ de los
  montos redondeados de las líneas (`headerFromLines`; solo si cambió un monto: fechas/glosa/presentación no reescriben el encabezado, p. ej. el neto exacto de una OC); `refreshInvoiceSystemAmounts`.
  Línea con modelo de precio (no medida) a la que solo le cambia la cantidad: la tarifa el **motor** (desglose coherente) si la línea guardada
  se reproduce con el precio del ítem; si no (precio o monto a mano, filas por tramo, período prorrateado), queda **manual** con el desglose
  descartado (aviso `pricing_breakdown_dropped`). En esas líneas el descuento del ítem ya está dentro del unitario: `discount_pct` del cuerpo es
  adicional (omitido o igual al guardado = sin adicional). Línea medida: cambiar cantidad → `metered_line_use_consumption`. Solo la glosa →
  `description_locked` (texto ASCII, límite del documento; no marca la línea manual); con cambio de montos y sin glosa nueva, se re-renderiza
  con la plantilla (salvo protegida). Período nuevo que se cruza con uno emitido del mismo ítem → `overlaps_issued`. Al cambiar el período de una
  línea, `period_closed` y el mes desde el que se reconstruye el devengo miran el período **nuevo y el anterior** (01-10).
- **Encabezado**: `issue_date` conserva `original_issue_date` y recalcula el vencimiento (`invoiceDueDate`) salvo `due_date`; aviso
  `past_issue_date`; `due_before_issue`. Receptor: misma regla de junction que `change_entity`; re-deriva RUT (`client_tax_id`), IVA (tipo de
  documento de la factura: exportación 0, Colombia 0, si no la compañía normalizada) y `export_type`; aviso `document_type_review` si el receptor
  es de otro país que la emisora. **El tipo de documento no cambia** (vive en Condiciones de facturación). `invoice_terms_and_conditions`,
  `notes` (reemplaza) y `auto_invoice`.
- **Presentación por tramo** (`line_mode[{ contract_item_id, mode: single | per_tier, scope?: invoice | invoice_and_following }]`): recompone las
  filas del ítem por período desde `period_quantity` + desglose **sin cambiar el total** (Σ subtotales e IVA iguales; la recomposición es la única
  que quita filas: las del mismo ítem y período, acción `remove`); glosas con la plantilla (la protegida queda en la primera fila). Salta filas
  manuales (salvo `confirm_manual_overwrite`), sin desglose o con descuento puntual. `invoice_and_following`: además `prices.invoice_line_mode`
  de la copia del contrato (`owner = contract`) y las Por Emitir posteriores (se saltan e informan las bloqueadas y las manuales).
- **Conciliador**: por ítem y período, lo que el plan espera (motor con los ítems vigentes —fin recortado a la baja— y los consumos) menos lo que
  ya llevan las otras facturas vigentes del contrato (complementarias, reemisiones, NC), contra las LÍNEAS de la factura. `deviation {
  has_deviation, total_diff, by_item[{ contract_item_id, product_name, period_start, period_end, expected, actual, diff }], inherited, changed,
  currency, reason_required }`. Aplicar exige `deviation { type, reason }` si el desvío es nuevo o cambió (409 `deviation_reason_required`); con
  motivo y desvío, una fila en `invoice_adjustments` (`amount_diff` = diferencia total en moneda de contrato). Las diferencias de plan heredadas
  (p. ej. prorrateo por días de una baja vs. por meses del motor) aparecen como `inherited`.
- **Descuento puntual** (decisión de Domi 30-09, reemplaza "línea de descuento"): `lines[].one_off_discount { type: pct | amount, value }` (monto
  en moneda de contrato; "aplicar X % a todas" lo expande el front). La línea conserva cantidad × unitario; su `discount_pct` pasa a ser el %
  efectivo combinado (sin líneas negativas; con monto, el % queda a 2 decimales y el subtotal exacto) y la parte puntual queda como sublínea del
  `pricing_breakdown` existente `{ kind: 'discount', one_off: true, amount: -X, label: 'Descuento puntual: <motivo>', one_off_type, one_off_value,
  base_discount_pct }` (re-editar la reemplaza, null la quita). Exige `deviation { type: 'discount', reason, revenue_treatment: service_period |
  impact_month | defer_forward }` (400 si falta), que se guarda en **`invoices.nc_revenue_treatment`** de la factura (quitar todos los puntuales lo
  limpia); el total va a `invoice_adjustments` (type discount). **Devengo**: `nc_discount_revenue_adjustment` (asset editado, sin aplicar) suma la
  nueva fuente —facturas no NC con tratamiento, activas y no Canceladas; cuenta desde que se registra, aunque esté Por Emitir— salvo que la factura
  tenga una NC de descuento clasificada vigente (manda la NC); `service_period` (nuevo, también para NC) reparte en los meses del período de
  servicio de la línea. El preview devuelve `revenue_effect { treatment, total, by_month[{ month, amount }] }` con las mismas reglas
  (`one-off-discount.ts`) y aplicar reconstruye el devengo (`revenue_schedule_rebuild` desde el mes más temprano afectado). Glosa, filas por tramo
  y etiquetas de tramo ignoran la sublínea `one_off`. Exponer `service_period` para NC en la UI es de **Facturación**.
- **Sin cobro** (decisión de Domi 30-09, reemplaza `empty_invoice`): una línea en 0 dentro de una factura con otras queda oculta y la factura
  sigue Por Emitir. Si **todas** las líneas quedan en 0 (cantidad y monto) —editando o registrando consumo 0— la factura pasa a `Cancelada` (las
  líneas en 0 quedan) con evento `INVOICE_NO_CHARGE` (`reason: zero_edit | zero_consumption`, before/after, período, usuario); no se envía ni
  genera alertas. Es **reversible**: si luego recupera cantidad (edición o consumo > 0) vuelve a Por Emitir recalculada con
  `INVOICE_NO_CHARGE_REVERTED`; "sin cobro" se deriva de eventos (último `INVOICE_NO_CHARGE` no seguido de `…_REVERTED`), y ninguna otra cancelada
  se reactiva. Preview: aviso `becomes_no_charge` / `no_charge_reverted` e `invoice.after.status`. Una PE con borrador en el ERP que quedaría sin
  cobro sigue bloqueada por `sent_to_erp_draft`. Lista y detalle exponen `no_charge`.
- **Masivo** (cubre "términos a todas" y receptor del front viejo): `bulk-edit` `{ invoice_ids[] (≤200), invoice_terms_and_conditions?, client_entity_id?,
  auto_invoice? }`, mismas reglas y bloqueos por factura (`no_change` si ya tiene esos valores), un `INVOICE_EDITED` por factura con `bulk_id`.
  Una factura **por OC** con `client_entity_id` o cambio de IVA se salta y se informa (`partial_billing_invoice`, 01-10); en la edición de una
  factura, cambiar la tasa de IVA también la bloquea.
- **Lectura**: lista y detalle suman `deviation { has_reason, type, amount_diff, reason, adjusted_at, adjusted_by_name } | null` (último ajuste de
  tipo discount/upsell/downsell/correction), `has_manual_lines`, `no_charge`, `erp_sync_state`, `erp_reset_available`; líneas del detalle con
  `is_visible`; detalle con `nc_revenue_treatment`. La alerta "desvío sin motivo" **no** va en `ContratoAlertas` (exige correr el motor por
  contrato): la da `GET …/invoices/deviations`.
- **Idempotency-Key**: no (las operaciones vecinas de facturas no la usan; solo `changes`). **Pendiente**: validar con Leon que el mapper a Odoo
  **omita las líneas con cantidad 0** (hoy viajarían); alineación automática cuando el ERP emite algo distinto a la PE; el sufijo "Consumo
  adicional" y el recálculo `per_tier` de Consumos siguen sin leer la plantilla del contrato (solo conservan glosas protegidas).

**Presentación por tramo (pedido de Domi, 30-09).** Un ítem cuyo precio factura "una fila por tramo" (`invoice_line_mode = per_tier`) debe poder pasarse a **una sola fila** (y al revés) desde la edición de la factura Por Emitir: se recompone la línea desde sus filas (`period_quantity` + desglose), sin cambiar el total. Alcance a decidir al construir: solo esa factura, o esa y las siguientes (cambia `prices.invoice_line_mode` de la copia del contrato). En la vista rápida las filas por tramo ya se muestran juntas y en orden (detalle de factura ordenado por ítem y `line_index`).

### 3.5 Reorganizar el cronograma (juntar períodos · dividir · mover un ítem a otra factura)

- **Hoy**: Reestructurar reenvía **todas** las PE y líneas (`p_target_state`), y la RPC reescribe todo → U1; el validador compara con
  headers de emitidas → U2; facturas nuevas clonan el header de la última factura (vencimiento NULL, FX pegado).
- **v2**: `POST /contracts/:id/invoices/reorganize/preview|apply` con **operaciones**, no estado completo:
  `{ operations: [ { op: 'merge', invoice_ids[] } | { op: 'move_line', line_id, to_invoice_id | new_invoice: { issue_date } } |
  { op: 'split_line', line_id, by: 'date' | 'amount' | 'installments', at?, amount?, count? } | { op: 'split_invoice', invoice_id,
  cut_date } ], reason }`. La API convierte las operaciones en el **cambio mínimo** (F3): solo las líneas nombradas cambian de factura,
  período o monto; cantidad, unitario y descuento se **conservan** salvo que la operación divida montos (entonces cantidad = override del
  período → la de la línea → la del ítem; unitario = subtotal ÷ cantidad; cierra U1 y la regresión ROADMAP #3). Factura nueva: nace del
  **generador v2** con receptor, documento, condiciones de pago (vencimiento calculado), moneda y **FX = política del contrato para su
  período** (nunca clonado); `split_reason = 'reorganize'`. Factura que queda sin líneas → `Cancelada` con evento (no DELETE).
- **Coexistencia con emitidas**: las emitidas son ancla; una línea no puede moverse a una emitida ni solaparse con el período ya emitido
  del mismo ítem (`overlaps_issued`); la frontera de lo facturado (`MAX(billing_period_end)` emitido) no se reescribe.
- **Conciliador de desvíos** (§3.4; reemplaza el validador "no empeorar" de S4-13 y cierra U2): la continuidad por ítem se calcula **antes
  y después leyendo líneas** (no headers) con la matemática de `check_contract_item_continuity` (overrides incluidos) portada a TypeScript
  junto a `billing-engine.ts`, y se muestra en el preview como **información**, no como bloqueo; si se aparta del plan pide motivo
  (`plan_deviation`). Lo heredado (header ≠ líneas por callback, venta única triplicada) sale como aviso `inherited_gap` → "Ajustar a lo emitido" (Facturación).
- **Evento** `INVOICES_REORGANIZED` (operaciones, facturas creadas/canceladas, líneas movidas). **RSM**: rebuild de los meses tocados
  solo si cambió el período de alguna línea (mover entre facturas del mismo período no toca devengo). **Bloqueos**: comunes +
  `mixed_currency` (juntar facturas de distinta moneda/receptor/documento) + `sent_to_erp_draft` como aviso.
- Retira `invoice_reschedule_items`, consolidar/desconsolidar de 1 contrato y la vista Reestructurar (Decisión 1: la reemplazan Reorganizar + Editar borrador; sin modo "Ajustar montos").

**Etapa 5 construida (API, 30-09)** — `invoice-reorganize.ts` (pura) + `contract-invoice-reorganize.service.ts` + `dtos/contract-invoice-reorganize.dto.ts`.
Rutas: `GET /contracts/:id/invoices/schedule-lines` · `POST /contracts/:id/invoices/reorganize/preview` · `POST /contracts/:id/invoices/reorganize`
(no `…/apply`). **Sin esquema nuevo**: facturas nuevas con `split_reason = 'reorganize'` y `split_from_invoice_id` = la de origen (columnas existentes);
`related_invoice_id` y `consolidated_into_invoice_id` no se usan (juntar no crea un documento consolidado: mueve líneas).
- **Cuerpo** `{ operations[] (≤50, en orden: cada una opera sobre el resultado de la anterior), reason?, deviation?: { type, reason } }`. Operaciones:
  `merge { invoice_ids[] }` · `move_line { line_id, to_invoice_id | new_invoice: { issue_date } }` · `split_line { line_id, by: date | amount |
  installments, at?, amount?, count?, installments?[{ amount, issue_date? }], issue_date? }` · `split_invoice { invoice_id, cut_date, issue_date? }` ·
  `item_monthly { contract_item_id }` · `item_unify_pending { contract_item_id, issue_date? }` · `item_even_split { contract_item_id, count? }` ·
  `round_fix { invoice_id }`.
- **Qué hace cada una**: *merge* → todas las líneas a la de emisión más temprana (sin fusionar períodos: cambio mínimo), las vaciadas → `Cancelada`.
  *move_line* → la línea (o su grupo por tramo) conserva cantidad, unitario, descuento y período; si cambia la tasa o el IVA de la factura destino,
  se revalorizan moneda de factura e IVA. *split_line date* → dos subperíodos `[inicio, at]` y `[at+1, fin]`, montos por días (telescópico), cantidad
  igual, unitario = subtotal ÷ (cantidad × (1 − descuento)) a 6 decimales (en líneas con modelo de precio el descuento está en el unitario:
  subtotal ÷ cantidad) y desglose escalado; la parte posterior va a una factura nueva con la emisión original corrida los meses que se corre el
  período (misma factura si queda en el mismo mes; `issue_date` la fija). *split_line amount / installments* → cuotas concurrentes (mismo período),
  montos fijos, residuo de centavos en la última; la primera queda en la línea original (salvo que su cuota traiga otra `issue_date`) y cada una de
  las siguientes en su propia factura nueva (su `issue_date` o mensual desde la original); **admite montos distintos por cuota** (brecha del front
  viejo, que solo repartía parejo o a mano). *split_invoice* → las líneas que cruzan el corte se dividen por fecha y las que empiezan después se
  mueven, todo a una factura nueva. *item_monthly* → cada línea pendiente del ítem en tramos por mes calendario (montos por días de esa línea, así el
  total por línea no cambia); el tramo de cada mes entra a la Por Emitir compatible de ese mes o a una nueva; tramos contiguos del mismo mes se juntan
  en una línea. *item_unify_pending* → todo lo pendiente del ítem en una línea (período mín → máx, suma) en la factura más temprana (o en la de
  `issue_date`); las demás líneas se quitan. *item_even_split* → sin `count`, reparte parejo el total pendiente entre sus líneas actuales (mismos
  períodos); con `count`, lo pendiente en `count` cuotas por bloques de meses (la primera en la línea más temprana, las demás en la PE del mes o
  nueva). *round_fix* → lleva el residuo encabezado − Σ líneas (moneda de contrato y, con tasa fija, de factura) a la línea mayor no manual; aviso
  `rounding_residual_large` si supera 1 unidad; `no_change` si ya cuadra.
- **Reglas comunes**: solo Por Emitir activas del contrato (bloqueos comunes, `sent_to_erp_draft` **bloquea** —mismo criterio que etapas 1–4—,
  `period_closed` por emisión, por fecha de la factura nueva y por período re-fechado). Una línea de una emitida → `not_pending`; mover a una
  emitida → `overlaps_issued` ("las emitidas son ancla"); una línea con período nuevo que cruza un período emitido del mismo ítem →
  `overlaps_issued`. `mixed_currency` al juntar facturas de distinta moneda, receptor o tipo de documento (y al mover a una PE de otra moneda).
  Filas por tramo del mismo ítem y período se mueven y dividen juntas (aviso `per_tier_group`); `item_unify_pending` sobre un ítem por tramo →
  `per_tier_group` (bloqueo: primero pasarlo a una fila en Editar borrador). Líneas `manual` o con descuento puntual se mueven pero no se re-montan
  (`manual_edit_kept` / `one_off_discount_kept`); líneas de ítems medidos se mueven pero no se dividen ni reparten (`metered_line`). Glosa protegida
  se conserva; las demás de líneas divididas, nuevas o re-montadas se re-renderizan con la plantilla (+ ajuste al límite).
- **Factura nueva**: nace de las reglas del generador, nunca de otra factura: receptor = razón social del contrato, documento = el del contrato (o
  sugerido por países), IVA por documento, moneda de facturación del contrato, vencimiento `invoiceDueDate` (condición de pago), FX = misma moneda 1;
  política `fixed` → `findFixedRate` del contrato para el inicio de su período (sin tasa → NULL con aviso `fixed_fx_without_rate`); spot → NULL.
  Emisor, RUT del receptor, términos, `requires_references_for_billing` y `auto_invoice` desde contrato/compañía/razón social; **forma de pago,
  régimen fiscal y serie** (`payment_method`, `fiscal_regime`, `invoice_series`) se copian de la factura de origen (`split_from_invoice_id`; serie
  `FAC` solo si no hay origen; también el saldo de facturar por OC, 01-10). Emisión pasada → aviso `past_issue_date`.
- **El descuento puntual sigue a su línea (01-10)**: si una línea con sublínea `one_off` pasa a otra factura, el destino toma el
  `nc_revenue_treatment` del origen (409 `revenue_treatment_conflict` si ya tiene otro), el origen lo pierde si no le queda ninguna línea con
  puntual, la fila de `invoice_adjustments` (type discount) se mueve (toda la parte) o se duplica por la parte (`one_off_moves[{ share }]`) y el
  devengo se reconstruye desde el mes de emisión más temprano de ambas. Dividir una línea (`scaleBreakdown`) escala `one_off_value` del puntual en
  monto (el % se conserva). Las `consumption_entries` de una línea movida (ítem + `period_start`) pasan a la factura de destino (igual en el saldo
  de facturar por OC).
- **Escritura** (una transacción, `setApiWriter` primero, `FOR UPDATE` del contrato y de sus Por Emitir): facturas nuevas por INSERT; líneas movidas
  o divididas por UPDATE (conservan id; `invoice_id`, estado y emisión de la factura donde quedan; `fx_rate_source = 'reorganize'` si cambia la tasa),
  partes nuevas por INSERT, líneas absorbidas (juntar por mes / unificar) por DELETE; encabezado = Σ líneas en ambas monedas; vacías → `Cancelada`
  (nunca DELETE de factura); `refreshInvoiceSystemAmounts`; devengo (`revenue_schedule_rebuild`) solo si cambió el período de alguna línea, desde el
  primer mes tocado. Nunca `invoices.updated_at`.
- **Conciliador** (continuidad por ítem, port de `check_contract_item_continuity` leyendo LÍNEAS, sin el prorrateo por encabezado de U2): para los
  ítems tocados, antes y después, `{ expected_total (motor), before/after { actual_total, lines, gaps[], overlaps[] }, diff, tolerance
  (máx(0,01; 0,01 × líneas)), inherited, changed, by_period[{ month, expected, before, after }] }` incluyendo emitidas y NC del ítem. Una
  redistribución pura (mismo total por ítem) no pide motivo; si cambia (p. ej. `round_fix` de más de unos centavos) aplicar exige `deviation { type,
  reason }` (409 `deviation_reason_required`) y deja una fila en `invoice_adjustments` por factura con diferencia. Lo heredado sale como aviso
  `inherited_gap` (informa, no bloquea).
- **Respuesta** preview `{ operations[{ index, op, ok, blockers[], warnings[] }], invoices[{ id | null, key (id o new:N), invoice_number, action:
  updated | created | cancelled | unchanged, split_from_invoice_id, before, after, lines[{ id | null, key, action: moved | split | created | updated |
  unchanged | removed, from_invoice_id, origin_line_id, to_invoice_key, per_tier_group, before, after }] }], continuity { by_item[], changed,
  total_diff, inherited, reason_required, currency }, warnings[], blockers[], can_apply, rsm_from_month, summary }`; aplicar = lo mismo + `applied,
  event_id, created_invoice_ids[], cancelled_invoice_ids[], adjustment_ids[]` (409 `no_change` si las operaciones no cambian nada). Errores de forma →
  400 `errors[{ field: operations.N.…, message }]`. Evento `INVOICES_REORGANIZED` con `operations`, `invoice_ids` / `created_invoices` /
  `invoices_cancelled` (los lee el historial de cada factura), antes/después por factura y línea, continuidad, motivo y `adjustment_ids`.
- **Tablero** `GET …/invoices/schedule-lines` → `{ contract_id, cutoff_date, invoices[{ …encabezado, header_residual, operable, blockers[],
  lines[{ id, contract_item_id, product_name, account, description, quantity, unit_price_contract_currency, discount_pct,
  subtotal_contract_currency, subtotal_invoice_currency, total_invoice_currency, billing_period_start, billing_period_end, quantity_source,
  per_tier_group, line_index, manual, locked, one_off_discount, metered, is_visible }] }] (por período), issued_periods[], items[], total }` (sin motor).
- **Qué cubre del Reestructurar viejo** (`useRestructureDraft.ts`): mover ítem a otra factura → `move_line`; agregar factura vacía → `move_line` con
  `new_invoice`; dividir por fecha / por monto / en cuotas concurrentes (con destinos) → `split_line`; dividir factura por fecha → `split_invoice`;
  unir dos o varias → `merge`; eliminar factura → mover o juntar sus líneas (la vacía se cancela); eliminar ítem → no existe (una línea en 0 se
  oculta en Editar borrador); editar período con propagación → `split_line`/`item_monthly` (el período se deriva de las operaciones; editar a mano un
  período sigue en Editar borrador); `convertToMonthly` → `item_monthly`; `regenerateItemEvenMonthly` → `item_even_split { count }`;
  `rescaleItemPendingEven` → `item_even_split`; `unifyAllPending` → `item_unify_pending`; `autoFixRoundingDelta` → `round_fix` (por factura: el
  "enviar la diferencia al último período" de un ítem es un desvío y va por Editar borrador con motivo). No se porta el modo "Ajustar montos"
  (Decisión 1).

### 3.6 Constructor de descripción (plantilla por contrato)

- **Qué es** (reemplaza editar/prefijar/sufijar y la función fija de glosa): la descripción de cada línea se arma con una **plantilla de
  bloques**. Bloques de datos seleccionables y **ordenables por arrastre**: producto · cuenta · período (formatos `dd/mm/aaaa a dd/mm/aaaa`,
  `mes aaaa`, `mmm-aa`, `dd-mm-aa al dd-mm-aa`) · cantidad + unidad · precio unitario · monto en moneda del contrato · TC aplicado · moneda
  de facturación · N° de contrato · OC/HES · cliente; más **bloques de texto libre** entre datos (separador ` - ` por defecto). **Vista
  previa en vivo** con una línea real de la factura y **contador** contra el límite del documento tributario
  (`tax_document_types.description_max_chars`, nuevo: SII 80 = `NmbItem`; CFDI y PE a confirmar con Leon); al superarlo avisa en rojo y
  no deja guardar la plantilla. Los datos **dinámicos** (consumo, TC spot, OC) se marcan "se completa al emitir": la descripción se
  renderiza al **generar** la factura y se **refresca al emitir** (`send` / `mark-issued`) con los valores finales.
- **Ámbito**: **contrato** (`contracts.invoice_description_template` jsonb `{ blocks: [{ type, format?, text? }] }`; afecta las PE futuras
  y, con `apply_to_pending`, las activas no protegidas) · **selección** (masivo desde la barra de la pestaña: plantilla del contrato o
  bloques ad hoc sobre las facturas marcadas) · **factura** (desde el editor de borrador o la vista rápida). **Herencia holding → contrato →
  factura**: sin plantilla propia se usa la del nivel superior (default del holding: `producto - cuenta - período`). Disponible en el
  **alta del contrato** como bloque opcional del paso de facturación, precargado con la del holding.
- **Protección**: una línea editada a mano queda `invoice_items.description_locked = true` y ninguna regeneración la toca; "Volver a la
  plantilla" (por línea o por selección, `mode: 'unlock'`) la libera y regenera. Cierra Tanda 3 #2 y el límite "preservar textos manuales".
- **API** (§4): `PUT /contracts/:id/invoice-description-template` + `…/preview` (`{ text, length, max_chars, pending_fields[] }`) y
  `PATCH /contracts/:id/invoices/descriptions` `{ invoice_ids[] | line_ids[], mode: 'apply_template' | 'apply_blocks' | 'set' | 'unlock', blocks?,
  text?, include_locked?: false }`. Solo PE activas; eventos `INVOICE_DESCRIPTIONS_UPDATED` y `CONTRACT_DESCRIPTION_TEMPLATE_CHANGED`. Sin RSM. El generador v2 (mapa §3) renderiza con la plantilla vigente.

**Etapa 3 construida (API, 30-09)** — `invoice-description.ts` (pura) + `contract-invoice-descriptions.service.ts`:
- **Esquema** (migración `1790670000000-InvoiceDescriptionTemplate`, escrita y **sin aplicar**): `contracts.invoice_description_template`
  jsonb NULL, `invoice_items.description_locked` boolean NOT NULL DEFAULT false, `tax_document_types.description_max_chars` int NULL
  (Chile = 80 por UPDATE en la migración y en el seed 003; el resto NULL = sin límite). La API **no se despliega antes** de la migración: el
  detalle de factura, la activación, las modificaciones, los consumos y el constructor leen esas columnas.
- **Plantilla** `{ separator?, blocks: [{ type, format?, text? }] }` (≤ 12 bloques, `text` ≤ 120). Bloques: `product`, `account` (`block` |
  `inline`), `period` (`range_slash` | `month_year` | `mmm_yy` | `range_dash`), `tier` (`label` | `detail`: en línea única con modelo de precio
  agrega el detalle "Tramos: …"), `quantity`, `unit_price`, `amount`, `fx_rate`, `invoice_currency`, `contract_number`, `references`, `client`,
  `text`. En los bloques de datos `text` es una etiqueta que se antepone ("Periodo", "Cuenta", "OC"). Bloques vacíos se omiten.
  `DEFAULT_TEMPLATE` = `product`, `account` inline "Cuenta", `period` range_slash "Periodo", `tier` detail: reproduce **exactamente** la glosa
  de hoy (probado contra `lineDescription`, `describeSingleLine` y la fila por tramo); el generador v2 renderiza siempre por aquí (plantilla del
  contrato o la default) en activación y modificaciones.
- **Pendientes** (`pending_fields`): `quantity`/`unit_price`/`amount` con cantidad medida sin consumo cerrado (`quantity_source` pending o
  estimated), `fx_rate` en spot sin tasa, `references` sin OC/HES; el bloque va con el valor actual o se omite.
- **Límite**: el `description_max_chars` del documento del contrato; contratos sin documento del catálogo → el del primer documento de su
  familia en el país de la compañía (`resolveDescriptionMaxChars`). Guardar una plantilla cuya muestra lo supera → 400.
- **Protección**: `set` deja `description_locked = true`; `apply_template`/`apply_blocks` saltan las protegidas (salvo `include_locked`) y
  dejan las regeneradas sin proteger (decisión: bloques ad hoc no protegen); `unlock` libera y regenera. Recalcular consumos (línea única) y
  el sufijo de modificaciones ya no tocan una glosa protegida.
- **Referencias**: `PUT …/:invoiceId/references` reemplaza las filas propias de `invoice_references` (OC → `801`/"Orden de Compra", HES →
  `HES`, OTHER con `document_type_code`; `reference_code`/`reason` de una fila previa igual se conservan); Por Emitir (aviso
  `sent_to_erp_draft` si ya hay borrador) y emitidas solo sin ERP (409 `sent_to_erp`).
- **Pendiente**: plantilla por **holding** (Configuración, herencia holding → contrato; hoy la default es la glosa estándar) y el bloque
  opcional en el **alta**; **refrescar la descripción al emitir** (`send`/`mark-issued` con los valores finales) vive en el scheduler
  (`src/modules/invoices`, Leon); límite de **México (CFDI) y Perú** a confirmar con Leon (hoy NULL); recalcular consumos `per_tier` recrea
  las filas con la glosa estándar (no lee la plantilla ni conserva `description_locked`).

**Ajuste automático al límite (decisión del dueño 30-09).** Sin bloqueos del ERP por descripciones largas: se corrige en el origen. Toda
glosa que el sistema **genera** (activación, cambios de contrato, recálculo por consumo, recomposición por tramo, aplicar/regenerar
plantilla) pasa por `fitDescription` y nunca supera `description_max_chars`: si no cabe, se acorta en pasos deterministas (período corto,
sin etiquetas, sin cuenta, tramo resumido, texto libre recortado y, como último recurso, recorte del bloque más largo conservando período y
tramo, sin partir palabras). Las respuestas informan `fitted`/pasos y el aviso `description_fitted`. El texto manual (`mode: 'set'`) sigue
rechazándose si supera el límite y las líneas protegidas no se tocan; guardar plantilla solo rechaza si la muestra aún ajustada lo supera.

### 3.7 Referencias OC/HES por factura · facturación parcial por OC (caso 6)

- **a. Referencias**: `PUT …/:invoiceId/references` `{ references: [{ type: 'OC' | 'HES' | 'OTHER', code, date?, name? }],
  requires_references_for_billing? }` sobre `invoice_references` (misma tabla que Facturación; juego completo con before/after en el evento
  `INVOICE_REFERENCES_UPDATED`). A Odoo viajan como hoy (`invoice-scheduler.service.ts:1068`). El bloqueo `needs_reference` desaparece al
  guardarlas. Editables en emitidas **solo** si aún no se envió (después, ajuste en el ERP).
- **b. Facturar un monto cerrado por OC** (flexibilidad caso 6 **tal cual**, Decisión 4; Alicorp): `POST …/:invoiceId/partial-by-po/preview|apply`
  `{ reference: { type: 'OC' | 'HES', code, date? }, amount_invoice_currency, allocation?: [{ line_id, amount }], visible_line_text, reason }`.
  1. **Propuesta**: con el monto en moneda de factura la API propone los ítems que calzan: combinación **exacta** (subconjuntos sobre ≤ 12
     líneas) o, si no existe, una línea **parcial** a precio de lista (cantidad = resto ÷ unitario, ej. 504,04 de 560 licencias); la usuaria
     confirma o ajusta (`allocation`).
  2. **Saldo explícito**: la diferencia queda como líneas **"pendientes de facturar" del mismo período** en una PE nueva (`split_reason =
     'partial_by_po'`, `issue_date` = próximo ciclo, `notes` "Saldo de OC X del período P"; cada línea conserva su período de servicio),
     visibles con chip "Saldo OC X" y en `ContratoAlertas` ("te quedan 6.609,12 USD de septiembre por facturar"); se suman a una factura
     futura (Reorganizar › mover) o se emiten aparte.
  3. **Línea visible ↔ internas** (Decisión 5): el documento legal lleva **una sola línea visible** (`visible_line_text` + OC/HES + total),
     la única que viaja a Odoo; Sapira conserva las N líneas internas ligadas a ítem y período (`is_visible = false`, `visible_line_id`) para
     trazabilidad, devengo y conciliador, con **desplegable** en la fila. Requiere el filtro `is_visible` en `mapInvoiceToOdooFormat` (§4).
  4. **FX**: la OC fija el monto en moneda de factura → `net_exact` (§3.2) sobre la factura cubierta; el saldo toma la política del contrato y
     la **diferencia de cambio se liquida al facturar lo pendiente** (`fx_difference` en el evento; no NC/ND, no se arrastra).
  5. **Consumo sin cerrar**: línea `metered` sin consumo cerrado → aviso `open_consumption` ("el saldo puede cambiar"), no bloquea.
  6. **Trazabilidad**: evento `INVOICE_PARTIAL_BILLING` (OC/HES, monto, líneas cubiertas, saldo, quién) y `plan_deviation.kind =
     'partial_billing'`. **RSM**: sin cambio; en el balance triple el saldo es "facturación diferida acordada", no desbalance.

**Etapa 6 construida — Facturar por OC (API, 30-09)** — `invoice-partial-po.ts` (pura) + `contract-invoice-partial-po.service.ts` +
`dtos/contract-invoice-partial-po.dto.ts`. Rutas `POST /contracts/:id/invoices/:invoiceId/partial-by-po/preview` y `POST …/partial-by-po` (no
`…/apply`). **Esquema**: la única columna nueva es `invoice_items.visible_line_id` (migración `1790690000000-InvoiceVisibleLine`, escrita y **sin
aplicar**; FK a `invoice_items` ON DELETE SET NULL, índice parcial `idx_invoice_items_visible_line_id`). `is_visible` sigue **derivado**:
`quantity <> 0 AND visible_line_id IS NULL` (`isVisibleLine`, en el detalle, el editor, Reorganizar y el tablero); `plan_deviation.kind` no se
crea (no es un desvío: sin fila en `invoice_adjustments`, solo el evento).
- **Propuesta**: líneas visibles con monto de la Por Emitir, en moneda de factura; subconjunto **exacto** al centavo sobre ≤ 12 líneas (entre
  varios, el de líneas de período más temprano) o, si no hay, las más grandes completas y la siguiente **parcial** por el resto (cantidad =
  resto ÷ unitario, a 4 decimales; subtotal por proporción). `allocation[{ line_id, amount }]` la reemplaza (400 si no suma la OC o una línea
  no es visible de la factura).
- **Línea visible ↔ internas**: la visible es una línea nueva (glosa `visible_line_text` protegida, cantidad 1, unitario = neto de la OC en
  ambas monedas, ítem = el de la primera línea cubierta, período = el de las cubiertas, `quantity_source = manual`) con **subtotal, IVA y total
  en 0**: los montos viven en las internas (`visible_line_id` = la visible; conservan ítem, período y montos) para que Σ líneas = encabezado sin
  duplicar y el devengo por ítem quede igual. El documento/ERP lee la visible por cantidad × unitario; **el mapper de Odoo debe omitir las
  internas** (`visible_line_id IS NOT NULL`, pendiente de Domi, `cambios-integracion-para-leon.md`). La referencia OC/HES se guarda en
  `invoice_references` (OC = 801; sin duplicar) → desaparece `needs_reference`.
- **Saldo**: Por Emitir nueva con las reglas del generador (receptor, documento, IVA, moneda, FX del contrato para el período; `split_reason =
  'partial_by_po'`, `split_from_invoice_id`, notas "Saldo de OC X del período MM/AAAA", emisión = próximo ciclo (emisión + 1 mes, no antes de hoy),
  vencimiento por condición de pago); las líneas no cubiertas se **mueven** (UPDATE, conservan id y período) y el resto de la parcial se inserta.
- **FX**: misma moneda → 1. Con conversión y tasa fija, **neto exacto** (`netExactFx`) sobre las internas con unitario efectivo (subtotal ÷
  cantidad): tasa derivada en la factura y en las internas (`fx_rate_source = net_exact`), encabezado = neto de la OC; `fx_difference` = neto de la
  OC − neto cubierto × tasa previa (va al evento). Spot sin tasa → bloqueo `spot_without_rate` (fijar la tasa primero).
- **Bloqueos** (409 `blocked`): los de operabilidad de Reorganizar (`not_pending`, `unified_invoice`, `legacy_invoice`, `credit_note`,
  `sent_to_erp_draft`, `period_closed`) + `partial_billing_invoice` (ya facturada por OC), `spot_without_rate`, `no_visible_lines`,
  `exceeds_invoice`. **Avisos**: `open_consumption` (línea por consumo `pending`/`estimated`), `no_balance`, `reference_exists`,
  `fixed_fx_without_rate` (saldo sin tasa del período), `several_partial_lines`.
- **Una factura por OC queda fija**: `partial_billing_invoice` bloquea editar sus líneas o receptor (§3.4; fechas, notas y condiciones siguen
  editables), reorganizarla (§3.5) y cambiar su tipo de cambio (§3.2).
- **Respuesta** preview `{ proposal { mode: exact | partial | allocation, allocation[{ line_id, amount, partial }] }, covered_lines[{ line_id,
  contract_item_id, product_name, billing_period_start, billing_period_end, quantity, subtotal_contract_currency, subtotal_invoice_currency,
  partial }], partial_line { line_id, quantity_before, quantity_covered, quantity_remaining, unit_price_invoice_currency, amount_covered,
  amount_remaining } | null, visible_line { description, quantity: 1, unit_price_contract_currency, unit_price_invoice_currency,
  contract_item_id, billing_period_start, billing_period_end }, balance_lines[{ line_id | null, from_line_id, action: moved | split, … }],
  covered_invoice { id, invoice_number, invoice_currency, before, after }, remainder_invoice { issue_date, due_date, contract_currency,
  invoice_currency, fx_contract_to_invoice, split_reason, split_from_invoice_id, notes, totals } | null, fx { policy_before, fx_before, fx_after,
  net_exact, covered_contract_total, covered_invoice_total, fx_difference, remainder_fx }, reference { type, code, date, document_type_code,
  already_present }, rsm_from_month, warnings[], blockers[], can_apply }`; aplicar = lo mismo + `applied, event_id, visible_line_id,
  remainder_invoice_id, invoice`. Evento `INVOICE_PARTIAL_BILLING` (`invoice_id` = cubierta, `remainder_invoice_id`, `invoice_ids`,
  `reference`, `covered_total`, líneas cubiertas y de saldo, `fx`, `fx_difference`, motivo). Devengo reconstruido desde el mes del período
  (defensivo; los montos por ítem y período no cambian).
- **Lectura**: la lista y el detalle exponen `split_reason` / `split_from_invoice_id` y `partial_billing { role: covered | remainder,
  reference_code, reference_type, covered_total, covered_invoice_id, remainder_invoice_id } | null` (desde el evento; chip "Saldo OC X" en la de
  saldo); el detalle, `lines[].visible_line_id`, `lines[].is_visible` y `lines[].internal_lines[]` (las internas bajo su visible; también
  siguen en la lista plana).
### 3.8 Anular con NC espejo y reemitir

- Ya existe la pieza: `insertMirrorCreditNote` (NC exacta en moneda, FX, IVA, receptor; nace Por Emitir; `credit_type = cancellation`).
- **Ajustes 01-10 (decisiones de Domi)**: (1) con **NC de descuento vigentes** la NC de anulación acredita lo que queda de cada línea (original −
  NC de descuento, cruzadas por ítem y período como `PREVIOUS_DISCOUNTS_SQL`; esas líneas van cantidad 1 × −monto) y avisa
  `previous_credit_notes_considered` con los folios; nunca bloquea (si ya no queda nada → `no_lines`). (2) **Factura por OC**: la NC (anular o
  descuento) refleja **todas** sus líneas: la visible del documento (cantidad 1, unitario = −Σ de lo que la NC acredita en sus internas, montos en
  0) y las internas ligadas por `visible_line_id`, así el ERP recibe una línea igual al documento emitido y Sapira conserva las internas. La NC de
  descuento sobre una factura por OC (pct, o monto/pct sobre la visible o sobre internas) se convierte en un **ratio del documento** que se aplica
  igual a la visible y a cada interna (centavo residual a la interna mayor; aviso `partial_billing_whole_document`): la selección de internas de la
  UI se reemplaza por el monto o % del documento. (3) La reemisión copia también `invoice_reference_links`; `partial_billing` de una reemisión se
  resuelve por la cadena `related_invoice_id` (`split_reason = reissue`), así la reemisión de una factura por OC muestra el chip.
  Endpoint `POST …/:invoiceId/void/preview|apply` `{ reason: 'issue_error' | 'client_request' | 'other', notes, reissue: boolean,
  reissue_changes?: <mismo body que §3.4> }`: NC espejo completa + (si `reissue`) PE nueva del período con todas las líneas de la emitida
  (copiadas tal cual o con los cambios de `reissue_changes`), vínculo `related_invoice_id` y `notes` "Reemplaza a F-xxxx"; los consumos
  del período pasan a `cancelled` y se liberan (S7-8). Emitidas con NC previa → bloqueo `already_voided`; con pago conciliado → aviso
  `paid_invoice_voided` (Facturación decide la devolución). Evento `INVOICE_VOIDED` / `INVOICE_REISSUED`. **RSM**: rebuild del mes del
  período (la NC resta y la PE de reemplazo suma; cierra ROADMAP #10 para este camino). La NC se **emite** desde Facturación (S4-8 con Leon:
  `out_refund`); el 360 la muestra en `related_documents` y en la fila con badge "NC".

**Etapa 6 construida — Anular / reemitir y NC de descuento (API, 30-09)** — `invoice-void.ts` (pura) + `contract-invoice-void.service.ts` +
`dtos/contract-invoice-credit-notes.dto.ts`. Rutas `POST …/:invoiceId/void/preview`, `POST …/:invoiceId/void`, `POST …/:invoiceId/credit-note/preview`,
`POST …/:invoiceId/credit-note`. Sin esquema nuevo.
- **Convención de anulada** (la de v2, igual que la reemisión por consumo corregido): la emitida **no se toca** (conserva su estado); queda
  anulada por derivación (`voided` = tiene una NC de anulación activa vinculada, `voidedSql`). El flujo viejo (`create_credit_note_safe`) dejaba
  original y NC en `Cancelada`; v2 no lo copia porque la NC nace Por Emitir y "NC + factura se cierran juntas".
- **NC** (`insertMirrorCreditNote`): Por Emitir, **sin `due_date`** (regla para toda NC que crea la API, también modificaciones y consumo),
  `related_invoice_id` = la original, `invoice_type = Manual`, montos negativos en ambas monedas con la tasa, IVA, receptor y emisor de la
  original, cada línea con su ítem y período. Anular: `credit_type = cancellation`, `nc_revenue_treatment` NULL, cada línea con cantidad o monto
  al 100 % con **su IVA guardado** (`exact`: la NC cancela el documento al centavo aunque el IVA de la original no sea subtotal × tasa); las
  ocultas en 0 no se espejan. `credit_reason`: `issue_error` → `issue_error`; `client_request` y `other` → `other` (el CHECK no tiene
  `client_request`; el motivo exacto va al evento y a las notas de la NC).
- **Reemisión** (`reissue: true`): el editor de §3.4 sobre la emitida vista como una Por Emitir nueva (`reissueEditContext`: sin folio ni ERP,
  emisión = `reissue_changes.issue_date` o hoy, vencimiento por condición de pago, sin la emitida en los períodos emitidos ni en "otras facturas"
  del conciliador). Sin cambios = copia exacta de líneas y encabezado (moneda, tasa, receptor, IVA, condiciones); con `reissue_changes` (mismo
  cuerpo que `PUT …/:invoiceId`, `lines[].id` = líneas de la emitida) pasa por la misma lógica y exige `reissue_changes.deviation` si se desvía
  del plan (409 `deviation_reason_required`; con motivo, fila en `invoice_adjustments` de la reemisión). Encabezado nuevo con
  `related_invoice_id` = la original, `split_reason = 'reissue'`, notas "Reemplaza a F-xxxx" (+ las del cuerpo), grupo propio, referencias
  OC/HES copiadas; las internas de facturar por OC conservan el vínculo con su visible.
- **Consumos** (S7-8): las `consumption_entries` que llevaba la anulada pasan a la reemisión (`invoice_id`) o quedan libres (`invoice_id`
  NULL); el consumo trata una emitida con NC de anulación como anulada (`isVoidLine`), así el período queda abierto para registrarse de nuevo.
- **Bloqueos** (409 `blocked`): `credit_note`, `not_issued` (solo Emitida/Enviada/Vencida/Pagada activas), `unified_invoice`, `legacy_invoice`,
  `already_voided`, `period_closed` (fecha de la NC), `no_lines`, y los del editor en la reemisión. **Avisos**: `paid_invoice_voided` (pagos
  confirmados o Pagada), `credit_note_to_erp` (la original está en el ERP: la NC se emite desde Facturación contra ese documento).
- **Respuesta anular** `{ invoice { id, invoice_number, status, voided, paid }, credit_note { credit_type, credit_reason, nc_revenue_treatment,
  status, issue_date, due_date: null, related_invoice_id, contract_currency, invoice_currency, fx_contract_to_invoice, lines[{ source_line_id,
  contract_item_id, product_name, description, billing_period_start, billing_period_end, subtotal_*, tax_*, total_* (negativos) }], totals {
  amount_contract_currency, amount_invoice_currency, vat, total_invoice_currency } }, reissue { issue_date, due_date, notes,
  related_invoice_id, split_reason, header, lines[{ source_line_id, action, is_visible, after }], deviation, revenue_effect } | null,
  consumption_entries[{ id, contract_item_id, period_start }], warnings[], blockers[], can_apply }`; aplicar = lo mismo + `applied,
  credit_note_id, reissue_invoice_id, adjustment_id, event_ids[], invoice`. Eventos `INVOICE_VOIDED` (`invoice_id` = original, `invoice_ids`,
  `created_invoices`, `credit_note_id`, `reissue_invoice_id`, `reason`, `credit_reason`, `paid`, `consumption_entries_released`) e
  `INVOICE_REISSUED` (`invoice_id` = reemisión, `related_invoice_id`, cambios, desvío). **RSM**: rebuild desde el mes del período.
- **NC de descuento parcial sobre una emitida** (§8, tercer motivo): `{ lines?: [{ line_id, amount? | pct? }] | pct?, reason:
  prompt_payment_discount | one_time_discount | compensation | other, revenue_treatment: service_period | impact_month | defer_forward, notes? }`.
  Montos en **moneda de factura**; una línea negativa por línea afectada (cantidad 1, unitario = −monto, patrón NC32; mismo ítem y período, así
  `nc_discount_revenue_adjustment` la atribuye al emitirse), contrato = proporción del neto de la línea, IVA = neto × tasa de la original.
  `credit_type = discount`, `nc_revenue_treatment` = el pedido. Bloqueos: los de emitida + `exceeds_line` (lo pedido supera lo que queda de la
  línea tras las NC de descuento vigentes del mismo ítem y período). Respuesta `{ credit_note, lines[{ line_id, contract_item_id,
  original_amount, previously_credited, requested, remaining_after }], revenue_effect { treatment, total, by_month[] } (réplica de
  `oneOffRevenueEffect` con la fecha de la NC = hoy), rsm_from_month, warnings[], blockers[], can_apply }` (+ `applied, credit_note_id,
  event_id, invoice`). Evento `INVOICE_CREDIT_NOTE_CREATED` (el historial lo normaliza a `INVOICE_CREDIT_NOTE`). La nota de débito queda
  fuera (no pedida en esta etapa).
- **Lectura**: lista y detalle exponen `voided`, `related_documents[{ id, invoice_number, document_type, credit_type, status, issue_date, total,
  relation: credit_note | reissue | original }]` (ambos sentidos por `related_invoice_id`; el detalle agrega consolidada y dividida) y
  `split_reason`; el detalle, `credit_reason`.

## 4. API propuesta (módulo `contracts`, tras `SupabaseAuthGuard` + `HoldingScopeGuard` + `@HoldingId()`; BFF `app/api/contratos/[id]/facturas/...` con Zod espejo)

| Método y ruta | § | Cuerpo / efecto |
|---|---|---|
| `POST /contracts/:id/invoices/:invoiceId/send` | 3.1 | `{ dry_run?: false }` → reutiliza `InvoiceSchedulerService.sendInvoiceToOdoo` para una factura; responde `{ odoo_invoice_id, warnings }` o 409 con bloqueos. El payload a Odoo lleva solo las líneas visibles (`quantity <> 0 AND visible_line_id IS NULL`; una línea visible en OC parcial) y re-renderiza las descripciones con los valores finales |
| `POST /contracts/:id/invoices/:invoiceId/mark-issued` | 3.1 | `{ issue_date, invoice_number (≤100), fx_rate?, notes? }` (folio y fecha **obligatorios**, Decisión 6) → Emitida sin ERP (reemplaza `emit_invoice_manually`, sin división); solo registra (valoriza solo si estaba en spot; `fx_mismatch` si la tasa difiere); mismo permiso que editar el contrato |
| `POST /contracts/:id/invoices/:invoiceId/erp-withdraw` | 3.1 | **Gated** (Decisión 2): existe cuando Odoo cancele el borrador por API; hasta entonces no se expone en BFF ni UI (reemplaza `reset_invoice_odoo_draft`) |
| `PATCH /contracts/:id/invoices/fx` (+ `/fx/preview`) | 3.2 | `{ invoice_ids[], fx_policy, fx_rate?, target_net_amount?, reason? }` (reemplaza `apply_fixed_fx_to_contract` por factura) |
| `POST /contracts/:id/invoices/:invoiceId/reschedule` · `POST /contracts/:id/invoices/reschedule` | 3.3 | `{ issue_date, due_date?, reason }` · masivo `{ invoice_ids[], shift \| issue_date, reason }` |
| `POST /contracts/:id/invoices/:invoiceId/edit/preview` · `PUT /contracts/:id/invoices/:invoiceId` | 3.4 ✅ | `{ lines[{ id?, contract_item_id, description?, quantity, unit_price, discount_pct?, billing_period_start, billing_period_end, amount_basis?, exact_total?, one_off_discount? }], line_mode[], issue_date?, due_date?, client_entity_id?, invoice_terms_and_conditions?, notes?, auto_invoice?, deviation?: { type, reason, revenue_treatment? }, confirm_manual_overwrite? }` → preview `{ invoice { before, after }, lines[{ id, action, before, after, is_visible }], line_mode[], deviation, revenue_effect, warnings[], blockers[], can_apply }`; PUT = preview + `applied, event_id, adjustment_id, invoice`. 409 `deviation_reason_required` si falta motivo. Reemplaza `edit_pending_invoice`, `invoice_bulk_update_terms`, `invoice_reassign_entity` por factura |
| `POST /contracts/:id/invoices/:invoiceId/deviation` · `GET /contracts/:id/invoices/deviations` | 3.4 ✅ | `{ type, reason }` → fila en `invoice_adjustments` con la diferencia del conciliador + `INVOICE_DEVIATION_EXPLAINED` · lista de Por Emitir que se desvían sin motivo `{ data[{ invoice_id, invoice_number, issue_date, billing_period_start, billing_period_end, deviation }], total }` |
| `POST /contracts/:id/invoices/bulk-edit/preview` · `PATCH /contracts/:id/invoices/bulk-edit` | 3.4 ✅ | `{ invoice_ids[], invoice_terms_and_conditions?, client_entity_id?, auto_invoice? }` → `{ invoices[], updated[], skipped[], warnings[], can_apply }` (+ `applied, bulk_id, event_ids[]`) |
| `POST /contracts/:id/invoices/:invoiceId/erp-reset` · `POST /contracts/:id/invoices/erp-reset` | 3.1 ✅ | Restablecer borrador del ERP (una / masivo): vínculo al ERP en NULL + `INVOICE_ERP_DRAFT_RESET`; el borrador en Odoo se elimina allá (API pendiente con Leon) |
| `POST /contracts/:id/invoices/reorganize/preview` · `POST /contracts/:id/invoices/reorganize` · `GET /contracts/:id/invoices/schedule-lines` | 3.5 ✅ | `{ operations[] (merge, move_line, split_line, split_invoice, item_monthly, item_unify_pending, item_even_split, round_fix), reason?, deviation?: { type, reason } }` → `{ operations[], invoices[{ id, key, action, before, after, lines[] }], continuity, warnings[], blockers[], can_apply }` (+ `applied, event_id, created_invoice_ids, cancelled_invoice_ids`); 409 `deviation_reason_required` si cambia el total de un ítem. Tablero de lectura `schedule-lines`. Reemplaza `invoice_reschedule_items`, consolidar/desconsolidar de 1 contrato |
| `GET` · `PUT /contracts/:id/invoice-description-template` · `POST …/invoice-description-template/preview` | 3.6 ✅ | GET → `{ template, is_default, max_chars, sample }` · PUT `{ template \| null, apply_to_pending? }` → `{ template, is_default, updated_lines, skipped_locked }` · preview `{ template, line_id? }` → `{ line_id, text, length, max_chars, exceeds, pending_fields[] }` |
| `PATCH /contracts/:id/invoices/descriptions` (+ `POST …/descriptions/preview`) | 3.6 ✅ | `{ invoice_ids?, line_ids?, mode: 'apply_template' \| 'apply_blocks' \| 'set' \| 'unlock', template?, text?, include_locked? }` → preview `{ lines[], max_chars }` · apply `{ updated, skipped[], event_ids[] }` (reemplaza `invoice_items_bulk_update_description`) |
| `PUT /contracts/:id/invoices/:invoiceId/references` | 3.7a ✅ | `{ references[{ type, code, date?, name?, document_type_code? }], requires_references_for_billing? }` → `{ invoice_id, requires_references_for_billing, references[], warnings[] }` |
| `POST /contracts/:id/invoices/:invoiceId/partial-by-po/preview` · `POST …/partial-by-po` | 3.7b ✅ | `{ reference: { type: OC \| HES, code, date? }, amount_invoice_currency, allocation?[{ line_id, amount }], visible_line_text, reason }` → preview `{ proposal, covered_lines[], partial_line, visible_line, balance_lines[], covered_invoice, remainder_invoice, fx { …, fx_difference }, reference, rsm_from_month, warnings[], blockers[], can_apply }`; aplicar = preview + `applied, event_id, visible_line_id, remainder_invoice_id, invoice` ("Etapa 6 construida" en §3.7b) |
| `POST /contracts/:id/invoices/:invoiceId/void/preview` · `POST …/void` | 3.8 ✅ | `{ reason: issue_error \| client_request \| other, notes?, reissue, reissue_changes? (cuerpo de §3.4) }` → preview `{ invoice, credit_note, reissue, consumption_entries[], warnings[], blockers[], can_apply }`; aplicar = preview + `applied, credit_note_id, reissue_invoice_id, adjustment_id, event_ids[], invoice` (usa `insertMirrorCreditNote`; "Etapa 6 construida" en §3.8) |
| `POST /contracts/:id/invoices/:invoiceId/credit-note/preview` · `POST …/credit-note` | 3.8 / §8 ✅ | NC de descuento parcial sobre una emitida `{ lines?[{ line_id, amount? \| pct? }] \| pct?, reason, revenue_treatment, notes? }` → `{ credit_note, lines[], revenue_effect, rsm_from_month, warnings[], blockers[], can_apply }` (+ `applied, credit_note_id, event_id, invoice`) |

Reutilización: un `ContractInvoicesService` nuevo (junto a `consumption.service.ts`) con un solo `applyInvoiceChange(runner, plan)` que
comparte con modificaciones el recálculo de encabezado, la convención FX, la fusión por período, el **conciliador** (`detectPlanDeviation`) y
el evento; `billing-engine.ts` (períodos, vencimiento), un `description-template.ts` (render de bloques, herencia holding → contrato →
factura, límite por documento), `pricing-engine.ts`, `insertMirrorCreditNote`, `sendInvoiceToOdoo`. `Idempotency-Key` en `metadata` como en
cambios; errores `message` + `errors[{ field, message }]`; bloqueos 409 `{ code: 'blocked', blockers[], preview }`.

**Esquema (todo aditivo)**: ~~`invoices.fx_policy`, `fx_rate`, `fx_rate_date`, `fx_rate_source`~~ → **reutilizados, no se crean** (regla dura de Domi 29-09, etapas 1–2 construidas así): tasa en `invoices.fx_contract_to_invoice` (NULL = spot pendiente, valor = fija), origen y fecha en `invoice_items.fx_rate_source`/`fx_rate_date` de las líneas, confirmación en el evento `INVOICE_FX_CHANGED`; `fx_policy` (`same_currency | spot | fixed`), `fx_rate`, `fx_rate_source`, `fx_confirmed_at` e `issued_externally` (evento `INVOICE_ISSUED_EXTERNALLY`) son campos **derivados** de las respuestas · ~~`invoices.plan_deviation
jsonb`~~ → **no se crea** (etapa 4, Domi 30-09): motivo en `invoice_adjustments` (type discount | upsell | downsell | correction) · `invoices.erp_withdrawn_at` (3.1, gated) · ~~`invoice_items.source`~~ → `invoice_items.quantity_source = 'manual'` (3.4) ·
~~`invoice_items.is_visible`~~ → derivado de `quantity = 0` (3.4); `invoice_items.visible_line_id` (línea interna → su línea visible; 3.7b, **construida**: migración `1790690000000-InvoiceVisibleLine`, sin aplicar; `is_visible` = `quantity <> 0 AND visible_line_id IS NULL`) ·
`invoice_items.description_locked boolean default false` (3.6) · `contracts.invoice_description_template jsonb { blocks: [{ type, format?,
text? }] }` y `holdings.invoice_description_template jsonb` (herencia; 3.6) · `tax_document_types.description_max_chars int` (SII 80; CFDI y
PE a confirmar con Leon; 3.6). Se descarta `invoices.erp_single_line_text` (lo reemplaza la línea visible). Nuevos `event_type` en
`contract_lifecycle_events`: `INVOICE_SENT_TO_ERP`, `INVOICE_ISSUED_EXTERNALLY`, `INVOICE_ERP_WITHDRAWN`, `INVOICE_FX_CHANGED`,
`INVOICE_RESCHEDULED`, `INVOICE_EDITED`, `INVOICE_DEVIATION_EXPLAINED`, `INVOICE_ERP_DRAFT_RESET`, `INVOICE_NO_CHARGE`, `INVOICE_NO_CHARGE_REVERTED`, `INVOICES_REORGANIZED`, `INVOICE_DESCRIPTIONS_UPDATED`,
`CONTRACT_DESCRIPTION_TEMPLATE_CHANGED`, `INVOICE_REFERENCES_UPDATED`, `INVOICE_PARTIAL_BILLING`, `INVOICE_VOIDED`, `INVOICE_REISSUED`.
`GET /contracts/:id/invoices` agrega `plan_deviation` (kind, amount, has_reason) y `pending_balance` por fila; `GET …/:invoiceId` agrega
`fx_policy`, `fx_rate_source`, `erp_sync_state`, `plan_deviation`, `lines[].source`, `lines[].is_visible`, `lines[].visible_line_id`,
`lines[].description_locked`, `description_template_source (holding | contract | invoice)` y `history[]` para que la vista rápida no los infiera.

## 5. UI en el 360 (front-sapira, `/lab/contratos/[contratoId]` › Facturas)

- **Tabla** (`ContratoFacturasTab.tsx`): columna de selección (`DataTable` con `selectable`) + **menú ⋯ por fila** según estado: Por Emitir →
  *Editar borrador · Reprogramar · Tipo de cambio · Descripciones (constructor) · Referencias OC/HES · Facturar por OC · Enviar al ERP ahora ·
  Registrar emisión externa · Reorganizar (drawer con esta factura enfocada)*; *Retirar del ERP* **no aparece** hasta la Decisión 2; Emitida →
  *Referencias (si no se envió) · Anular / reemitir · Ver en Facturación*; Cancelada/NC → *Ver en Facturación*. Chips ERP: "Borrador en
  Odoo", "Enviada". **Columna "Desvío"**: chip por `plan_deviation.kind` (consumo · descuento · pendiente de modificación · corrección ·
  parcial OC) con Δ y motivo en tooltip, rojo si no tiene motivo. Filas con línea visible de OC: **desplegable** con las líneas internas por
  ítem y período (`is_visible = false` en gris, "no viaja al ERP"). **Barra de selección múltiple** (≥1 fila): *Tipo de cambio ·
  Descripciones (constructor) · Reprogramar (mover al mes siguiente) · Enviar al ERP · Reorganizar › juntar*, con conteo y resultado por fila.
- **Vista rápida** (`FacturaVistaRapidaDrawer.tsx`) como **punto de entrada a todo**: botones primarios por estado (*Enviar al ERP ahora* /
  *Editar borrador* / *Anular*), menú "Más" con el resto, y secciones "Tipo de cambio" (política, tasa, fuente, cambiar), "Referencias"
  (inline), "Desvío" (chip, motivo, enlace al evento o a "Crear modificación"), "Historial" (eventos nuevos: quién, cuándo, qué). Si la PE ya
  está en Odoo: aviso "enviada al ERP; para retirarla, coordinar con Leon" (sin botón). "Ver en Facturación" queda como enlace secundario.
- **Editor de borrador** (drawer 640 px, `FormDrawer`): encabezado (receptor `Combobox`, emisión, vencimiento, términos), tabla de líneas
  (ítem `Combobox` vigente, glosa con candado `description_locked`, período, cantidad, unitario, descuento, subtotal con toggle "fijar
  subtotal exacto", marca "oculta en el documento" si cantidad 0), totales en vivo en ambas monedas, **Vista previa** → si hay desvío, paso
  **"Motivo del desvío"** (radio consumo / descuento puntual / modificación pendiente / corrección + texto; "Crear modificación" abre
  Modificar contrato con fecha efectiva) → Confirmar. Sin `<select>` nativo.
- **Drawer "Reorganizar"** (ancho completo): dos columnas de facturas (PE activas; emitidas en gris como ancla) con líneas arrastrables;
  por línea *Mover a… · Dividir por fecha / monto / cuotas*; por factura *Juntar con… · Dividir por fecha · Nueva factura*; panel de **preview
  en vivo** (`reorganize/preview` con debounce): creadas/canceladas, continuidad por ítem antes → después (informativa), avisos heredados,
  bloqueos duros; mismo paso "Motivo del desvío". Reutiliza `ResultadoMasivo` y `CambioPreview` de `components/cambios/`.
- **Constructor de descripción** (drawer, §3.6): paleta de bloques de datos + "texto libre" que se arrastran y reordenan; selector de
  formato de período; vista previa en vivo con una línea real; contador `n / max_chars` (rojo al superarlo); bloques dinámicos con etiqueta
  "se completa al emitir"; **ámbito** (este contrato · las N seleccionadas · esta factura); casilla "incluir editadas a mano" (= volver a la
  plantilla); "Guardar como plantilla del contrato". El mismo bloque aparece en el **alta** (paso de facturación, opcional, precargado del holding).
- **Drawer "Facturar por OC"** (§3.7b): referencia + monto en moneda de factura → propuesta de líneas cubiertas (exacta o parcial, editable)
  · saldo por ítem y período "quedará pendiente de facturar" · texto de la línea visible (con contador) · aviso de consumo sin cerrar · FX
  resultante (`net_exact`) · Confirmar.
- **Diálogos chicos**: Tipo de cambio (spot / fijo con tasa / subtotal exacto; sugerencia del contrato), Reprogramar (fecha + vencimiento
  calculado + motivo), Referencias, Anular (motivo, reemitir sí/no, preview de NC y PE), Enviar / Registrar emisión externa (folio y fecha
  obligatorios; resumen + confirmar). Labels `select-text`, `MultiSelect`/`Combobox` de `components/ui`; el Historial enlaza cada evento a su fila.
## 6. Bugs y mejoras que se cierran

| Id | Qué | Con |
|---|---|---|
| Auditoría U1 · ROADMAP 23-09 #3 (Salvador, NSAgro) | Reestructurar reescribe cantidades (overrides y líneas netas) | §3.5 cambio mínimo por operaciones |
| Auditoría U2 · ROADMAP 23-09 #4 (Alicorp) | Validador bloquea por diferencias heredadas / induce cobrar de menos | §3.4/§3.5 conciliador de desvíos: no bloquea, pide motivo; `inherited_gap` como aviso |
| Auditoría B6 · S6-3 · §2c "reset puede duplicar" | Restablecer no toca Odoo, folio fantasma, PE varada, borrador duplicado | §3.1: `reset_invoice_odoo_draft` no se porta; Retirar del ERP solo cuando Odoo cancele por API (Decisión 2) |
| Auditoría B3 · S6-2 · U12 (11 PE) | "Fijo" sin tasa sale a spot en silencio | §3.1 bloqueo `fixed_fx_without_rate` al enviar; §3.2 política por factura |
| Auditoría B2 (12 PE) | IVA del header sin × fx | §3.2 y §3.4 header = Σ líneas en moneda de factura |
| "FX pegado" (79 PE) · sync/reschedule clonan FX | Facturas nuevas heredan la tasa de la última factura | §3.5 factura nueva con FX del contrato para su período; §3.2 spot borra la tasa |
| §2b `apply_fixed_fx_to_contract` (política antes de validar; fija todo el contrato) · S6-1 | FX por factura | §3.2 |
| Reestructurar: vencimiento NULL (18 PE) · +30 fijo · vencimiento ≤ emisión (91 PE) | Vencimiento desde condiciones de pago | §3.3, §3.5 |
| Regla 31-08 (scheduler solo mes en curso: Dalvi, Copec) · S6 propuesta 6 | PE rezagadas que la usuaria debe mover a mano | §3.1 Enviar ahora ignora el mes; §3.3 "mover al mes siguiente" masivo |
| ROADMAP 23-09 #8 · flexibilidad caso 6 (Alicorp OC parcial) | Sin flujo para OC de monto cerrado, cuadre manual por BD, saldo perdido | §3.7b propuesta + saldo pendiente + línea visible ↔ internas |
| Tanda 3 #2 (límite: textos manuales) · "generador debe incluir la cuenta" | Regenerar pisa glosas manuales / sin cuenta / sin formato | §3.6 constructor de descripción + `description_locked` |
| Glosa truncada por el DTE (SII `NmbItem` 80) · líneas con cantidad/consumo 0 viajan a Odoo · líneas `1 × total` para OC | Documento legal ≠ trazabilidad interna | §3.6 contador `description_max_chars`; §3.4/§3.7b `is_visible` + línea visible ↔ internas |
| Desvíos sin explicar (editadas en Odoo, cuadres manuales) | El 360 no sabe por qué una factura difiere del plan | §3.4 `plan_deviation` con motivo, chip y alerta "desvío sin motivo" |
| S4b "reasignar no actualiza RUT, IVA, export ni serie" | Receptor cambiado sin re-derivar fiscal | §3.4 receptor re-deriva |
| S4-1 "facturar primero, decidir después" · F2 · `edit_pending_invoice` 0 usos | Editar borrador como un todo con desvío conciliado | §3.4 |
| S4-6 consolidar eliminado · S4-14 sin división · ROADMAP #10 (NC en moneda equivocada, camino anulación) | Piezas viejas retiradas / NC espejo exacta | §3.5, §3.1, §3.8 |
| Medios #1 (fallos silenciosos al enviar) · Medios #5 (badge FX) · Tanda 2 "Tipo de cambio: 1" | Bloqueos explicativos antes de enviar; FX visible por factura | §3.1, §5 |
| Duplicar en cualquier estado · eliminar PE por DELETE · UPDATE de fecha sin permiso ni evento | Agujeros de trazabilidad | §1 (no existen en v2), §3.3 evento |
| Vista rápida "solo lectura, emitir/editar/anular llegan con Facturación" | Punto de entrada a todo | §5 |

Fuera de alcance: U3 (unificar, Facturación/M3), IVA 19% MX/PE al asociar cotización (ROADMAP #9, Complejos #1), downsell que cancela la
PE completa (#11, ya lo cubre `item_remove` v2), Bosch `end_date` (#2), cuadre Perú IVA de línea (sesión de cuadre), pago desde Odoo (#7, Leon).

## 7. Orden de construcción y decisiones

**Orden** (cada etapa entrega valor sola y cierra bugs; todas con preview, evento, tests Vitest/Jest y docu funcional):
1. **Base + Enviar / Registrar emisión externa** (§3.1) + `history[]` y menú ⋯ / vista rápida con botones (§5). Retirar del ERP se
   construye pero queda **oculto** hasta la confirmación de Leon (Decisión 2); mientras, aviso sin botón.
2. **Reprogramar** (§3.3) + **Tipo de cambio por factura** (§3.2) con la transición del guard del scheduler. Cierra B2/B3/FX pegado.
3. **Constructor de descripción** (§3.6: plantilla por contrato, `description_max_chars`, `description_locked`, bloque opcional en el alta)
   + **Referencias** (§3.7a). Las operaciones masivas más usadas, riesgo bajo. **✅ API construida 30-09** (ver "Etapa 3 construida" abajo).
4. **Editar borrador** (§3.4) con el **conciliador de desvíos**. **✅ API construida 30-09** ("Etapa 4 construida" en §3.4): `quantity_source =
   'manual'`, `is_visible` derivado, motivo en `invoice_adjustments`, descuento puntual con devengo (`nc_revenue_treatment` + sublínea `one_off`),
   sin cobro reversible, masivo de encabezado y **Restablecer borrador del ERP** (§3.1).
5. **Reorganizar** (§3.5) con el conciliador; se retiran Reestructurar y consolidar de 1 contrato. **✅ API construida 30-09** ("Etapa 5
   construida" en §3.5): operaciones + atajos por ítem + cuadre de redondeo, factura nueva desde el generador, continuidad por líneas y tablero
   `schedule-lines`; las funciones viejas quedan para retirar al switch.
6. **Anular / reemitir** (§3.8) y **Facturar por OC** (§3.7b) con línea visible ↔ internas (requiere el filtro `is_visible` hacia Odoo, §4).
   **✅ API construida 30-09** ("Etapa 6 construida" en §3.7b y §3.8): NC espejo exacta sin vencimiento, reemisión por la lógica del editor,
   consumos liberados, NC de descuento parcial con devengo, `invoice_items.visible_line_id` (única columna nueva, migración sin aplicar).
   Pendiente fuera de la API: el mapper de Odoo debe omitir las internas (`visible_line_id IS NOT NULL`; lo hace Domi).

**Decisiones (Domi 29-09)** — cierran los Supuestos de la primera versión:
1. **Reestructurar** se reemplaza por **Reorganizar (§3.5) + Editar borrador (§3.4)**; no se conserva el modo "Ajustar montos".
2. **Retirar del ERP** **no se muestra** hasta que Leon confirme que Odoo permite cancelar el borrador por API. ~~Mientras, aviso sin botón~~ →
   **30-09**: se construye "Restablecer borrador del ERP" (misma acción de `reset_invoice_odoo_draft` + evento), porque se usa todo el tiempo;
   el borrador en Odoo se elimina allá (aviso `erp_draft_remains`) hasta que exista el retiro por API.
3. **Desvío plan ↔ factura** = ~~columna `invoices.plan_deviation`~~ fila en `invoice_adjustments` (Domi 30-09, sin campos duplicados), visible
   como chip en la tabla de Facturas del 360 y en la vista rápida; los desvíos **sin motivo** se listan con `GET …/invoices/deviations`.
4. **Facturar por OC** = caso 6 de flexibilidad **tal cual**: monto en moneda de factura → propuesta de ítems que calzan (exacta o parcial a
   precio de lista, editable); saldo como líneas "pendientes de facturar" del mismo período, visibles + alerta; la diferencia de cambio del
   saldo se liquida al facturar lo pendiente; consumo sin cerrar advierte sin bloquear; evento `partial_billing`.
5. **Líneas visibles vs internas como regla general**: `invoice_items.is_visible` (cantidad/consumo cero → la fila queda, no se ve ni viaja
   a Odoo) y `document_line` visible ↔ `line_allocation` internas para OC (una sola línea visible a Odoo; desplegable en Sapira de las
   internas por ítem y período). La "línea informativa monto 0" queda **descartada**: toda línea va ligada a un ítem.
6. **Emisión manual sin integración** (`mark-issued`): folio y fecha **obligatorios**; mismo permiso que editar el contrato.

## 8. Pendientes fuera de las etapas (anotados, sin fecha)

- **Cambio de compañía emisora por factura** (Domi 30-09): el front viejo lo permite (`invoice_reassign_entity` acepta `p_new_company_id`);
  v2 solo cambia el receptor (§3.4) y Modificaciones deja la emisora fuera. Queda pendiente y se ve junto con el **asiento de
  intercompany**, con el que está relacionado. No construir antes de esa revisión.
- **"Ajustar a lo emitido" NO se porta** (decisión de Domi 30-09): el botón del front viejo (`InvoiceAdjustModal`) quedó mal hecho y
  existía para cuadrar Sapira cuando en el ERP se emitía algo distinto. Con la flexibilidad de v2 (editar la factura por emitir con
  motivo, descuento puntual, referencias, reorganizar) la diferencia se resuelve **antes** de emitir, en Sapira. Principio: corregir de
  raíz en vez de sumar funcionalidades de cuadre. El aviso de desvío heredado (`inherited`) solo informa; no abre un flujo de ajuste.
- **No existen notas de crédito "sueltas"** (decisión de Domi 30-09; corrige §2, que dejaba la NC parcial y la ND en Facturación): toda NC
  nace asociada a una factura de un contrato y por un motivo, y los tres motivos se resuelven desde el contrato:
  1. **Modificación del contrato** (downsell, baja): NC automática del bloque de Modificaciones.
  2. **Error con reemisión**: anular con NC espejo y reemitir (§3.8, etapa 6).
  3. **Descuento puntual**: sobre una factura **por emitir**, el descuento por línea con tratamiento de devengo (§3.4, etapa 4); sobre una
     factura **ya emitida**, una NC de descuento parcial con el mismo tratamiento (`nc_revenue_treatment`: período de servicio · mes del
     documento · diferido hacia adelante). Este último camino **entra en la etapa 6** junto con anular/reemitir (misma pieza
     `insertMirrorCreditNote`, con monto parcial por línea): **✅ construido 30-09** (`POST …/:invoiceId/credit-note`, §3.8). La nota de
     débito sigue la misma regla (asociada a una factura y con motivo); no se construyó en la etapa 6 (sin pedido concreto).
- **Facturas unificadas entre contratos: no se portan, se resuelven de raíz** (decisión de Domi 30-09; corrige §2 y §6, que las dejaban
  en Facturación "hasta M3 + ruta declarada"). La unificación existe porque hoy un contrato no admite ítems en más de una moneda y las
  usuarias parten el acuerdo en varios contratos para después unir sus facturas; esa solución no les funciona bien (guard U3, líneas en
  cero, caso BAT). La solución es **flexibilidad caso 2**: ítems en distintas monedas dentro de un mismo contrato, facturados en una
  sola moneda con el método de FX de cada línea (`flexibilidad-con-trazabilidad.md` §2, A.3). Es un cambio del **modelo del contrato**
  (alta, ítems, motor de facturación, FX por línea), no de la pestaña Facturas: se diseña como bloque propio **antes de
  Modificaciones** (orden decidido por Domi 30-09, para que los cambios de precio/cantidad nazcan sobre el modelo definitivo). Domi
  tiene dudas sobre el enfoque: ese bloque **parte con una revisión de cómo lo resuelve la industria** (CRM y suscripciones suelen exigir
  una moneda por oportunidad/orden; plataformas de usage billing como Zenskar o Maxio admiten moneda por ítem) antes de decidir el modelo. Las facturas ya unificadas en producción siguen intocables en v2 (bloqueo `unified_invoice`) hasta migrarlas.
- **Líneas en cero hacia el ERP: hecho** (Domi 30-09, cambio puntual en el envío con aviso a Leon): `mapInvoiceToOdooFormat`
  (`src/modules/invoices/invoice-scheduler.service.ts`) omite las líneas con cantidad 0 cuando la factura tiene al menos una línea con
  cantidad distinta de cero; si todas están en cero envía igual que antes. Cubierto por `invoice-scheduler.service.spec.ts`. Ya no es un
  pendiente de integración; detalle para Leon en `cambios-integracion-para-leon.md`.
- **Una NC no vence** (Domi 30-09): nace de una factura y se cierra con ella. Hallazgo: las 26 NC emitidas de producción están en
  "Vencida" porque la tarea programada `check-overdue-invoices` (Supabase, repo viejo) no excluye NC; por eso ninguna NC de descuento
  clasificada ajustaba el devengo (la función exigía `Emitida`). Corregido para v2 en `nc_discount_revenue_adjustment`: cuenta la NC
  en cualquier estado emitido (Emitida/Enviada/Vencida/Pagada). **Hecho en la etapa 6**: las NC creadas por la API nacen **sin
  `due_date`** (`insertMirrorCreditNote`: anular, NC de descuento, modificaciones y consumo; la tarea filtra por vencimiento, así no las toca) y
  la anulada no cambia de estado (NC + factura se cierran juntas). La corrección de la
  tarea del repo viejo y de los 26 estados queda a criterio de Domi (no es necesaria para v2).
- **Cierre de la factura anulada y referencia de la NC** (Domi 01-10, construido): al anular, la original pasa a `Cancelada` (como la
  función legacy `cancel_invoice_with_credit_note`): queda neteada en KPIs y fuera de vencimientos y cobranza; antes/después en el evento
  `INVOICE_VOIDED`. Toda NC creada desde el contrato (anulación y descuento) nace con una fila en `invoice_references` que apunta a su
  factura como la NC electrónica: tipo y folio del documento original, código SII del motivo (1 = anula documento, 3 = corrige montos) y
  la razón; viaja a Odoo con las referencias de siempre. **Doble descuento en devengo resuelto un paso antes**: la original anulada queda
  `Cancelada`, y la función `nc_discount_revenue_adjustment` ya excluye `Cancelada`, así que su descuento puntual deja de contar sin tocar
  la función; la reemisión trae el suyo. Pendiente (Leon, emisión de NC hacia Odoo): cuando la NC de anulación se emite, pasa también a
  `Cancelada` (par cerrado, como las 74 NC de anulación de producción); la NC de descuento sigue su estado emitido normal.
