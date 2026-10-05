# Mapa v2 · Contratos (módulo `contracts` + `/lab/contratos`)

> 25-09-2026 · Domi + Claude. Estrategia acordada con Domi (25-09): **construir la v2 al lado de lo viejo**. Endpoints y
> lógica nuevos, rediseñados (no copias de lo que funciona a medias), sobre las **mismas tablas**; lo del front viejo no se
> toca y se retira módulo por módulo al switch. Fuentes: [`auditoria-contratos.md`](./auditoria-contratos.md) (S1–S8 y
> sus decisiones), [`manual-modificaciones-contratos.md`](./manual-modificaciones-contratos.md),
> [`flexibilidad-con-trazabilidad.md`](./flexibilidad-con-trazabilidad.md), [`mejoras-y-brechas.md`](./mejoras-y-brechas.md),
> [`spec-tablas-por-modulo.md`](./spec-tablas-por-modulo.md), `sapira-ai/docs/ROADMAP-OPERATIVO.md` y las memorias de
> soporte. Registro de lo ejecutado: [`saneamiento-contratos.md`](./saneamiento-contratos.md). Pricing (modelos de precio,
tramos y consumo): [`spec-pricing-v2.md`](./spec-pricing-v2.md), construido en §2f.

## 1. Cómo se construye (reglas del módulo)

1. **Misma base, esquema aditivo.** v2 escribe en `contracts`, `contract_items`, `invoices`, `invoice_items`,
   `revenue_schedule_monthly` porque las leen el RSM, el scheduler de Odoo, Reportes, el Dashboard y el front viejo
   mientras conviva. Lo nuevo (día de ciclo, términos de pago, tipo de documento, eventos) entra como **columnas o
   tablas nuevas**; nada se renombra ni se borra hasta el switch.
2. **La lógica vive en la API**, en servicios con **una transacción por operación** y **preview antes de persistir**
   (mismo cálculo, sin escribir). Una función SQL nueva solo si la atomicidad lo exige, con nombre de operación, nunca
   `_v2`. Las funciones viejas quedan intactas y anotadas "reemplazada por X".
3. **Costura con los triggers heredados** (✅ Domi 30-09, construida: §4 y [`activacion-costura-triggers.md`](./activacion-costura-triggers.md);
   ahora es **todo** trigger legacy, no solo candidatos, salvo invariantes): la API abre cada transacción con
   `SET LOCAL sapira.writer = 'api'` y los triggers que hoy **rellenan o pisan** datos se hacen a un lado cuando la ven,
   porque v2 escribe el valor explícito. El front viejo nunca la setea → su comportamiento no cambia. Ya es un patrón de
   la casa (`sapira.bypass_period_guard`, `sapira.skip_currency_validation`, `sapira.bypass_end_date_guard`).
   Candidatos (ver §4): `standardize_invoice_items`, `trigger_generate_invoices_on_status_change` /
   `trigger_generate_invoices_on_contract_signed`, `set_contract_item_end_date`, `inherit_auto_renew_from_quote_item`,
   `trg_set_contract_item_categoria`, `set_booking_date_on_activate`. **No** se saltan los invariantes (moneda
   consistente, guard de período cerrado). La auditoría legacy (`contract_change_log`) sí se salta: el historial v2 es el evento.
4. **RSM explícito.** Cada operación v2 termina llamando `revenue_schedule_rebuild(contrato, desde_mes)` en la misma
   transacción; no depende de triggers condicionados al holding de la sesión.
5. **Evento siempre.** Toda operación deja un evento en `contract_lifecycle_events` con usuario, motivo, tipo
   normalizado (`UPSELL`, `CROSS_SELL`, `DOWNSELL`, `RENEGOTIATION`, `CHURN`, `RENEWAL`, `REACTIVATION`,
   `CORRECTION`, `ACTIVATION`…), fecha efectiva, delta de MRR, ítems afectados y origen (`manual` | `quote:<id>`).
6. **Holding** por `HoldingScopeGuard` + `@HoldingId()` (regla única de `autorizacion-y-tenancy.md`).
7. **Flexibilidad con trazabilidad**: lo no emitido se edita libre y se regenera; los desvíos quedan como evento con
   motivo; solo bloquean los invariantes (emitido inmutable, período cerrado, tenancy, holding). El desbalance
   plan ↔ facturado ↔ devengado **no se impide: se marca** en el 360 (alerta de 4 patas).
8. **Switch = cerrar la puerta vieja.** `migrated: true` + el front viejo del módulo redirige al nuevo. Recién ahí
   `REVOKE`/`DROP` de lo reemplazado (§5), con el procedimiento del 24-09.

## 2. Operaciones

Veredicto: **Nueva** = lógica v2 en la API · **Delega** = el endpoint llama la función existente tal cual · **Se quita**
= no se construye en v2. "Lunes" = alcance propuesto para el lunes 28-09 9:00.

### 2a · Lectura

| # | Operación v2 | Cómo funciona | Hoy | Veredicto | Evita de raíz | Lunes |
|---|---|---|---|---|---|---|
| L1 | Lista de contratos | Paginada y filtrada en servidor (estado, cliente, razón social, compañía, producto, **vencimiento por ítem**, con factura en ERP), orden, columnas, vistas guardadas, export; estado calculado como en Clientes | `select *` sin filtro ni paginación en el navegador | Nueva | "próximos a vencer" por fecha del contrato (Tanda 2) | ✅ |
| L2 | KPIs | MRR **sin** pendiente de renovar (S5-3) y pendiente como tarjeta aparte; `HoldingMetricsService` | 3 cálculos distintos | Nueva (reusa servicio) | dos cifras de MRR para el mismo mes | ✅ |
| L3 | Contrato 360 | Encabezado, **ítem madre** por producto+cuenta (regla CIS: vigentes iniciados, ajustes de precio aportan 0) con desplegable de ítems y **tipo de ítem**, facturas, historial (eventos normalizados), resumen RSM, documentos con URL firmada, alertas (4 patas, FX sin tasa, sin partner Odoo, ítem sin producto) | Varias lecturas directas del front | Nueva | tipo de ítem perdido (U7), bloqueos silenciosos (Medios #1) | ✅ |

**Estados y lista (Domi 25-09).**
- **Estado guardado vs mostrado**: `contracts.status` solo lo cambian acciones explícitas (crear → En revisión,
  activar → Activo, contracción total → Cancelado; pausar → Pausado cuando exista S2-12). El estado **mostrado** se
  calcula al leer, nunca se guarda ni lo cambia un cron (el `auto_expire_contracts` nunca corrió): Borrador ·
  Vigente · **Por renovar** (algún ítem recurrente terminó sin renovar ni baja; el ex "Ítem vencido (renovación
  parcial)") · **Vencido** (terminaron todos, reversible solo si se renueva, S2-1) · **Pausado** (reservado: el
  modelo, los filtros y la tarjeta ya lo consideran, hoy 0) · Cancelado. Sin estados de workflow (S1-9, S2-11).
- **Pestañas = listas distintas**: Contratos | Suscripciones (Stripe). Legacy y MRR legacy van a su vista (S8, al
  final). El estado es filtro: tarjetas clicables + opción múltiple en el panel.
- **Tarjetas que filtran**: Por renovar, Vencen en 30 días, Vencidos, Borradores (el número = lo que muestra la
  tabla al hacer clic; una activa a la vez, con chip). MRR y Pendiente de renovar son montos: no filtran.
  Cubre TiMining 29-07 #8 (vencimiento por ítem) y #10 (pendientes: renovaciones).
- **Filtros avanzados** en panel lateral (Clientes queda con el básico): los 16 del front viejo (estado, vencimiento,
  cliente, tipo, valor, fechas de inicio y fin, multiempresa, multimoneda, país del cliente y de la razón social,
  compañía, producto, auto-envío, auto-emisión, con factura en ERP) + razón social, moneda y próximo vencimiento;
  selección múltiple con el componente estándar (`docs/reglas-desarrollo/componentes-seleccion.md` en front-sapira).

**Contrato 360 (Domi 25-09, referencias 1g y 1h del mockup O2C).** Encabezado con línea de vida (Borrador → Activo →
Renovación/Vencimiento → Cerrado) y franja de datos clave. Pestañas: **Resumen** personalizable (mismo estándar que
Clientes: widgets de resumen financiero, próxima factura con bloqueos, vínculos, estado de cobro, FX aplicado, estado
vigente por producto, etc.) · Ítems · Facturas (cronograma por período + vista de facturas) · Devengo · Historial (con
Documentos dentro). **Consumos solo si el contrato declara un modelo de precio por uso**: el tipo de ítem "Variable/Fijo"
es master data de cada holding y no gobierna comportamiento; la declaración es el modelo de precio del ítem (Pricing v2,
§2f: `prices.quantity_type = fixed | metered`, `overview.facts.uses_usage_pricing`). Sin ítems medidos la pestaña no se muestra.

### 2b · Creación y activación

| # | Operación v2 | Cómo funciona | Hoy | Veredicto | Evita de raíz | Lunes |
|---|---|---|---|---|---|---|
| C1 | Crear contrato (manual o desde cotización Firmada) | Borrador en **una transacción**. Pide lo que hoy falta: moneda y política FX de facturación (S1-3, default moneda del contrato + spot), política FX de compañía si difiere (S1-17), **términos de pago** (default de la razón social, S1-4), **tipo de documento** sugerido por país emisor vs receptor (S1-7), **día de ciclo** explícito (S3-16), agrupación juntas/por ítem guardada (S1-10). Ítems con **producto obligatorio**, tipo, frecuencia, inicio y término (S1-12); moneda del ítem = la del contrato (S1-2); auto-renovación como viene y respetando lo desmarcado (S1-5). Número correlativo por compañía y prefijo (S1-1). Preview del calendario antes de guardar | Inserts sin transacción desde el front (`useProgressiveContractCreation`), schema Zod que nunca corre, términos y tipo de documento perdidos | Nueva | ítems sin producto (ROADMAP 12, CTR-2026-184), términos perdidos (Medios #11), número hex duplicado (Medios #7), auto-renovación forzada, agrupación no guardada | ✅ |
| C2 | Activar (uno o masivo) | Valida (tasa de IVA de la compañía, FX de compañía confirmado, ítems completos); **genera las facturas con el generador v2** (§3) en la misma transacción **antes** de pasar a Activo (el trigger viejo ve facturas y se salta; con la costura, ni corre); booking intacta si existe (S2-7); rebuild RSM; evento `ACTIVATION` | `bulk_activate_contracts` / `mark_contract_signed_safe` + triggers de activación + `generate_missing_invoices_for_contract` | Nueva | Activo sin facturas (S2-6), `due +30` (SAT MX), `export_type` fijo (Complejos #4), one shot en cada período (U6), Bianual = 12, historial duplicado, `bulk_confirm_fx_policy` pisando `fixed_period` | ✅ |
| C3 | Duplicar | — | `useContractLifecycle` | Se quita (S1-14) | — | — |
| C4 | Workflow de aprobación | Solo Borrador → Activo (S1-9); los pasos configurables se ocultan (S2-11) | `workflow_steps`, `mark_contract_signed_safe` | Se quita por ahora | — | — |
| C5 | Borrar | Solo Borrador y **lógico** (con evento) (S2-9) | DELETE físico desde el navegador | Nueva | borrados sin auditoría | ✅ |

**Endpoints de C2, C5 masivo y configuración masiva (26-09).**
- `POST /contracts/activate/preview` `{ ids }` (1–100): por contrato `can_activate`, `blockers[{ code, message }]`
  (`not_found`, `not_draft`, `has_invoices` (no legacy ni canceladas), `has_legacy_invoices`, `no_client_entity`, `no_company`, `no_tax_rate`, `no_items`,
  `items_without_product`, `incomplete_items`, `currency_mismatch`, `fx_company_policy_missing`, `fixed_fx_without_rate`,
  `no_invoices`; `fixed_fx_without_rate` = alguna factura sin tasa en `contract_fx_period_rates` que cubra el inicio de su
  período, directa contrato→factura o inversa como 1/tasa), `warnings`, `invoices_count`, `first_issue_date`, `total_to_invoice` (neto), `currency`,
  `document_type` y `sample` (3 primeras facturas del generador). No escribe.
- `POST /contracts/activate` `{ ids }`: solo los sin bloqueos, **una transacción por contrato** con la marca
  `sapira.writer = 'api'` (30-09). Orden: facturas Por Emitir (encabezado = Σ líneas) y sus líneas **con** `contract_item_id`
  en el INSERT (patrón B retirado), grupo, condiciones y montos en moneda del sistema → con el contrato aún en borrador:
  booking si es null (S2-7), moneda de la compañía emisora y FX a sistema (antes del estado: el guard de período protege
  `fx_rate_to_system` en vigentes) → `status = 'Activo'` → `revenue_schedule_rebuild(id, NULL)` → evento `ACTIVATION`. Sin
  `contract_invoices` ni `bypass_period_guard`. Campo por campo (regla v2 o réplica, y lo que cambia frente al front viejo):
  [`activacion-campos-api.md`](./activacion-campos-api.md). Responde
  `{ activated, skipped, failed }`. Con FX fijo, `fx_contract_to_invoice` y los montos en moneda de factura se llenan
  con esa tasa como la rama fija de `apply_fixed_fx_to_contract` (monto × fx; IVA y total del encabezado redondeados).
- `POST /contracts/bulk-delete` `{ ids }` (1–500): misma regla que `DELETE /contracts/:id`, una transacción; los que no
  califican vuelven en `skipped` con el motivo. Sin la columna `deleted_at` (migración `1790358766159` pendiente) → 409.
- `PATCH /contracts/bulk-settings` `{ ids, auto_send_to_odoo?, auto_invoice? }`: una transacción, evento
  `SETTINGS_CHANGED` por contrato que cambia (`metadata.before/after`), S6-10 (emisión automática exige envío al ERP).
- `GET /contracts` busca además por RUT sin puntos ni guion, número de cotización y producto de cualquier ítem; devuelve
  `totals { contracts, mrr, total_value_system, currency }` sobre todo el conjunto filtrado; `limit` hasta 500.

**Alta v2 · documento tributario, condiciones de factura y edición de borrador (28-09, código listo, sin aplicar).**
- **Catálogo `tax_document_types`** (tabla compartida, sin holding; migración `1790620000000-CreateTaxDocumentTypes` +
  seed `003-tax-document-types.sql` + policy de lectura para autenticados): documentos por país ISO-2 con `code` oficial
  (CL 33/34/110/61/56/111/112 · PE 01/03/07/08 · MX CFDI-I/CFDI-E · CO FE/NC) y filas genéricas `*` (`FACTURA`,
  `FACTURA_EXPORTACION`) para países sin catálogo; `kind` = `invoice | export_invoice | credit_note | debit_note | receipt`.
  El contrato guarda `tax_document_type_id` (FK) y **`document_type` sigue siendo la familia derivada** (`export_invoice` →
  `FACTURA_EXPORTACION`, resto → `FACTURA`): `export_type`, IVA del generador y lectores viejos no cambian.
- `GET /contracts/form-options?client_entity_id=`: `companies[]` trae `country_code` (ISO-2 desde el texto libre de
  `companies.country`), `tax_document_types[]` (los de su país; si no tiene, los genéricos; solo `invoice | export_invoice`)
  y `suggested_tax_document_type_id` (exportación si la razón social del query es de otro país, factura local si no); más
  `tax_document_types` (unión) y `document_types` (familias, compatibilidad). Sin el seed aplicado, todo eso viene vacío.
- `POST /contracts` y `POST /contracts/preview`: `tax_document_type_id?` (UUID). Debe estar entre los documentos de la
  compañía emisora → si no, 400 `errors[{ field: 'tax_document_type_id', message: 'El documento tributario no corresponde al
  país de la compañía emisora' }]`. Omitido: se guarda el sugerido y `document_type` se deriva de él (el `document_type` del
  body solo manda cuando el catálogo está vacío). `invoice_terms_and_conditions?` (≤ 5.000) se escribe al crear.
- `POST /contracts/activate/preview` devuelve además `document_type_label` (nombre del documento del catálogo o de la
  familia) y `tax_document_type { id, code, name } | null`; `GET /contracts/:id` y `/overview.facts.billing` exponen lo mismo.
- `PATCH /contracts/:id/terms` `{ invoice_terms_and_conditions: string | null }`: borradores y contratos vigentes (Activo,
  pausado); Cancelado → 409. Evento `TERMS_UPDATED` (`metadata.before/after`). **Solo el contrato**: el trigger
  `invoices_fill_terms_from_contract` copia el texto **al insertar** una factura con el suyo en NULL, así que las Por Emitir
  existentes conservan el que tenían (`pending_invoices_updated: false`; cambiarlas es F2, factura por factura).
- `GET /contracts/:id/form` → `{ id, contract_number, status, created_at, form }` con `form` en la forma exacta del body de
  crear (monedas, políticas y tasas FX por propósito, condición de pago, documento tributario, día de ciclo, condiciones,
  ítems con `id`, precio anual como `annual_unit_price + price_entry_mode`); 409 si no es borrador.
- `PUT /contracts/:id` (solo En revisión, sin facturas): body = `CreateContractDto` + `items[].id`; mismas validaciones que
  crear (contexto del holding, FX y UF, cotización) y **una transacción**: encabezado (conserva `contract_number`,
  `quote_id`, `created_at`, `type` y banderas de la cotización; 400 si el body trae otro número u otra cotización), ítems por
  `id` (con id UPDATE, sin id INSERT, ausentes DELETE; ítem ajeno → 400 `items.N.id`; ítem con `quantities` → 409), tasas
  fijas reemplazadas (ambas finalidades), evento `DRAFT_UPDATED` (`metadata.changed_fields`, `before/after`, `items
  {updated, inserted, deleted}`). Devuelve el 360. Triggers que corren en el UPDATE de ítems: `set_contract_item_end_date`
  (recalcula el mismo fin que se escribe), `auto_calculate_pricing_fields` (mensual/período, como al crear),
  `update_contract_term`; la categoría solo la pone un BEFORE INSERT, así que el UPDATE la recalcula con
  `calculate_contract_item_categoria` cuando cambia el producto. Cambio de moneda del contrato: `sapira.skip_currency_validation`
  solo en esa transacción (los dos validadores exigen coincidencia por sentencia; al final todos los ítems quedan en la
  moneda nueva). Guards de período y auditoría se saltan solos en borradores.

### 2c · Facturas del contrato

| # | Operación v2 | Cómo funciona | Hoy | Veredicto | Evita de raíz | Lunes |
|---|---|---|---|---|---|---|
| F1 | Generador único (§3) | Una sola pieza para crear Por Emitir: al activar, al modificar y al renovar | 6 generadores (2 front, 4 SQL) | Nueva | ver §3 | ✅ |
| F2 | Editar borrador | La Por Emitir se edita libre como un todo (líneas, cantidades, precio, descuento, fechas, receptor, glosa) sin pasar por el contrato (S4-1); cada línea **sigue ligada a su ítem**; el desvío plan ↔ facturado queda como evento con motivo y se **marca** | `edit_pending_invoice` (0 usos), Reestructurar, bulk sueltos | Nueva | "no me deja", Reestructurar como única salida, líneas `1 × total` | ✅ |
| F3 | Aplicar cambios (S4-2) | Recibe el estado objetivo y aplica el **cambio mínimo**: emitidas intocables, líneas no afectadas no se reescriben, ediciones manuales no se pisan sin confirmar, consumos registrados y líneas netas se respetan, FX nunca clonado, header = Σ líneas, evento. Lo usan editar ítems, modificaciones y el "repartir distinto" que hoy hace Reestructurar | `sync_invoices_for_contract_item`, `invoice_reschedule_items`, `check_contract_item_continuity` | Nueva | U1, U11, U2, FX pegado (79 PE), cuenta perdida en la glosa (Tanda 3 #2) | Parcial (lo que usen C/M) |
| F4 | Editar ítems (corrección) | Envía **solo los campos cambiados** (el fin como campo explícito); corrige glosa, cuenta, tipo, unidad, booking, y cantidad/precio si fue error de carga; deriva a Modificar si cambia el MRR hacia adelante, hay emitidas afectadas o cambia la frecuencia; ítems con consumos avisan y conservan su cantidad del período (S7-7); preview + F3 | UPDATE directo que reenvía todo + sync por ítem | Nueva | fin recalculado al guardar (Bosch), neteo deshecho, cambio comercial por "editar" | ✅ |
| F5 | Tipo de cambio | Política y tasa **por factura** (S6-1); "fijo" sin tasa nunca se envía (S6-2, U12); una línea que se suma a una PE hereda su FX | `apply_fixed_fx_to_contract` (fija todo el contrato), guard del scheduler | Nueva (con Facturación) | fijo sin tasa a spot en silencio, FX de contrato mal usado | ✅ 29-09 (F8) |
| F6 | Enviar al ERP ahora | `POST /contracts/:id/invoices/:invoiceId/send-now` (+ `/preview`): bloqueos del 360 (`already_sent`, `erp_send_disabled`, `no_erp_integration`, `no_erp_partner`, `needs_reference`, `item_without_product`, `fixed_fx_without_rate`, `tax_rate_missing`, `not_pending`…) → 409; si pasa, `InvoiceSchedulerService.sendInvoiceById` (mismo envío del scheduler para UNA factura, origen `manual`, sin la regla del mes en curso). `{ sent, status, odoo_invoice_id, message, blockers, warnings, event_id, invoice }`. Evento `INVOICE_SENT_MANUALLY` solo si Odoo devolvió el borrador | Solo el scheduler (`POST /invoices/scheduler/send`, mes en curso) | Nueva | PE fuera del mes que nadie envía (B6 parcial) | ✅ 29-09 |
| F7 | Registrar emisión externa | `POST …/:invoiceId/mark-issued` (+ `/preview`) `{ invoice_number, issue_date, fx_rate?, notes?, reason? }`: Por Emitir → `Emitida` (sin columna nueva: `issued_externally` se deriva del evento), vencimiento por condición de pago del contrato (si no, la de la razón social; MX +1 mes), montos valorizados (fija → su tasa; spot → `fx_rate` del body; sin tasa → bloqueo `fx_rate_missing`), `revenue_schedule_rebuild` desde el mes más temprano entre período y emisión. Aviso `erp_auto_send` (contrato con auto-envío) y bloqueo `sent_to_erp_draft`. Evento `INVOICE_ISSUED_EXTERNALLY` | `emit_invoice_manually` (con división) | Nueva | división que copiaba moneda de factura al contrato (S4-14) | ✅ 29-09 |
| F8 | Reprogramar | `POST …/:invoiceId/reschedule` (+ `/preview`) `{ issue_date, apply_to?: this \| this_and_following, reason? }` y `POST /contracts/:id/invoices/reschedule-bulk` (+ `/preview`) `{ invoice_ids[], shift_months (1–12) \| issue_date }`: `scheduled_at = issue_date = nueva`, **conserva `original_issue_date`** (`COALESCE`), `due_date` por condición de pago (`billing-engine.computeDueDate`), período/líneas/RSM intactos. `this_and_following` corre las PE posteriores al mismo día del mes elegido, cada una en su mes (recortado al fin de mes); el masivo aplica a las que pasan y devuelve `skipped[]`. Un evento `INVOICE_RESCHEDULED` por factura (antes/después, `bulk_id`) | `UPDATE invoices` directo del front (pisa `original_issue_date`), `reschedule_invoice_safe`, `invoice_reschedules` | Nueva | fecha original perdida, vencimiento ≤ emisión, `+30` fijo | ✅ 29-09 |
| F8b | Tipo de cambio por factura | `POST …/:invoiceId/fx` (+ `/preview`) `{ policy: spot \| fixed \| net_exact, rate?, target_net_amount?, reason? }` y `POST /contracts/:id/invoices/fx-bulk` (+ `/preview`) `{ invoice_ids[], policy, rate? }` (`net_exact` una sola): **sin columnas nuevas** (regla de Domi 29-09): la tasa va en `invoices.fx_contract_to_invoice` (NULL = spot pendiente, valor = fija), el origen en `invoice_items.fx_rate_source`/`fx_rate_date` (manual \| net_exact) de las líneas recalculadas y la confirmación (cuándo/quién/política) solo en el evento; `fx_policy` en las respuestas es derivado (`same_currency` \| `spot` \| `fixed`); recalcula líneas (× tasa; spot → NULL) y encabezado (`headerAmounts`: IVA en moneda de factura, B2). `net_exact` = matemática de `apply_fixed_fx_to_contract` (fx = neto ÷ Σ cantidad × unitario, redondeo a la línea mayor, unitario sin redondear). **No toca `contracts.fx_invoice_policy`**. Bloqueos: comunes + `same_currency`, `uf_invoice_currency`, `sent_to_erp_draft`, `fixed_fx_without_rate`, `no_priced_lines`. Evento `INVOICE_FX_CHANGED` | `apply_fixed_fx_to_contract` | Nueva | política de todo el contrato pisada por una factura, fijo sin tasa, FX clonado | ✅ 29-09 |
| F9 | Constructor de descripción | `GET /contracts/:id/invoice-description-template` → `{ template, is_default, max_chars, sample }`; `POST …/invoice-description-template/preview` `{ template, line_id? }` → `{ line_id, text, length, max_chars, exceeds, pending_fields[] }`; `PUT …/invoice-description-template` `{ template \| null, apply_to_pending? }` → `{ template, is_default, updated_lines, skipped_locked }` (400 si la muestra supera `max_chars`; evento `CONTRACT_DESCRIPTION_TEMPLATE_CHANGED`); `POST /contracts/:id/invoices/descriptions/preview` y `PATCH /contracts/:id/invoices/descriptions` `{ invoice_ids?, line_ids?, mode: apply_template \| apply_blocks \| set \| unlock, template?, text?, include_locked? }` → preview `{ lines[{ line_id, invoice_id, before, after, length, exceeds, locked, pending_fields, skipped_reason? }], max_chars }` · apply `{ updated, skipped[{ line_id, reason }], event_ids[] }` (un evento `INVOICE_DESCRIPTIONS_UPDATED` por factura). Plantilla en `contracts.invoice_description_template`, protección en `invoice_items.description_locked`, límite en `tax_document_types.description_max_chars` (migración `1790670000000`, sin aplicar). El generador (§3) renderiza la glosa con la plantilla; sin plantilla, idéntica a hoy | `invoice_items_bulk_update_description` (editar/prefijar/sufijar) | Nueva | glosa manual pisada al regenerar, sin cuenta, glosa truncada por el DTE (SII 80) | ✅ 30-09 (API) |
| F10 | Referencias OC/HES por factura | `PUT /contracts/:id/invoices/:invoiceId/references` `{ references[{ type: OC \| HES \| OTHER, code, date?, name?, document_type_code? }], requires_references_for_billing? }` → `{ invoice_id, requires_references_for_billing, references[], warnings[] }`: juego completo de las filas propias de `invoice_references` (OC = SII 801); Por Emitir y emitidas sin ERP (409 `sent_to_erp`). Evento `INVOICE_REFERENCES_UPDATED` | INSERT/DELETE directos del front en `invoice_references` | Nueva | referencias sin traza, `needs_reference` sin salida en el 360 | ✅ 30-09 (API) |
| F11 | Editar una Por Emitir (F2) | `POST …/:invoiceId/edit/preview` y `PUT /contracts/:id/invoices/:invoiceId` (spec facturas §3.4, "Etapa 4 construida"): líneas por `id` (sin `id` = nueva de un ítem vigente; omitidas quedan igual; nunca se aplana; `exact_total`; cantidad 0 = oculta), glosa protegida, presentación por tramo ↔ una fila (`line_mode`, esta factura o también el precio del contrato y las siguientes), fechas (conserva `original_issue_date`), receptor (re-deriva RUT, IVA, exportación; aviso `document_type_review`), términos, notas, emisión automática. Moneda de contrato → convención FX de la factura; encabezado = Σ líneas; devengo si cambió un monto. Línea tocada → `quantity_source = 'manual'` (consumos, modificaciones y plantillas no la pisan: `manual_edit_kept`). Evento `INVOICE_EDITED` | `edit_pending_invoice` (0 usos, FX 1), `invoice_bulk_update_terms`, `invoice_reassign_entity` | Nueva | aplanar a `1 × total`, receptor sin RUT/IVA, FX 1 que pisaba montos | ✅ 30-09 (API) |
| F12 | Conciliador de desvíos | Por ítem y período, plan (motor + consumos, menos otras facturas vigentes) vs. LÍNEAS; nunca bloquea: `deviation { has_deviation, total_diff, by_item[], inherited, changed, reason_required }`; aplicar un desvío nuevo exige `deviation { type: discount \| upsell \| downsell \| correction, reason }` (409 `deviation_reason_required`) y deja la fila en `invoice_adjustments`. `POST …/:invoiceId/deviation` explica uno heredado (`INVOICE_DEVIATION_EXPLAINED`); `GET /contracts/:id/invoices/deviations` lista las PE que se desvían sin motivo. **Descuento puntual** por línea (`one_off_discount` % o monto; `discount_pct` combinado; sublínea `one_off` en `pricing_breakdown`) con devengo `service_period \| impact_month \| defer_forward` en `invoices.nc_revenue_treatment` y `nc_discount_revenue_adjustment` | Validador "no empeorar" (Alicorp), `plan_deviation` propuesto | Nueva | U2, desvíos sin explicar, descuento como línea negativa | ✅ 30-09 (API; asset sin aplicar) |
| F13 | Sin cobro | Todas las líneas en 0 (edición o consumo 0) → `Cancelada` con `INVOICE_NO_CHARGE` (líneas conservadas); consumo o edición > 0 → vuelve a Por Emitir con `INVOICE_NO_CHARGE_REVERTED`. Derivado de eventos (`no_charge` en lista y detalle); otras canceladas no se reactivan | PE en 0 viajando o `empty_invoice` | Nueva | facturas en 0 enviadas al ERP | ✅ 30-09 (API) |
| F14 | Masivo de encabezado y Restablecer borrador del ERP | `POST …/invoices/bulk-edit/preview` + `PATCH …/invoices/bulk-edit` `{ invoice_ids[], invoice_terms_and_conditions?, client_entity_id?, auto_invoice? }` (bloqueadas en `skipped`, `bulk_id`). `POST …/:invoiceId/erp-reset` y `POST …/invoices/erp-reset` (masivo): `odoo_invoice_id`/`sent_to_odoo_at`/`sent_at` en NULL + `INVOICE_ERP_DRAFT_RESET`; aviso `erp_draft_remains` (borrar el borrador en Odoo por API: Leon) | `invoice_bulk_update_terms`, `reset_invoice_odoo_draft` (sin evento) | Nueva | reset sin traza | ✅ 30-09 (API) |
| F15 | Reorganizar el cronograma (F3 para facturas) | `POST /contracts/:id/invoices/reorganize/preview` y `POST /contracts/:id/invoices/reorganize` `{ operations[], reason?, deviation? }` con operaciones (spec facturas §3.5, "Etapa 5 construida"): `merge`, `move_line` (a otra PE o a una nueva), `split_line` (fecha · monto · cuotas con montos distintos), `split_invoice`, atajos `item_monthly`, `item_unify_pending`, `item_even_split`, `round_fix`. Cambio mínimo (solo las líneas nombradas; cantidad conservada, unitario = subtotal ÷ cantidad), factura nueva desde las reglas del generador (receptor, documento, IVA, vencimiento, FX del contrato para su período; `split_reason = 'reorganize'`), vacía → `Cancelada`, filas por tramo juntas, manuales se mueven sin re-montarse, emitidas ancla (`overlaps_issued`), continuidad por ítem por LÍNEAS antes → después (motivo solo si cambia el total de un ítem). Evento `INVOICES_REORGANIZED`. Lectura `GET /contracts/:id/invoices/schedule-lines` para el tablero | Reestructurar (`invoice_reschedule_items`, `check_contract_item_continuity`), `consolidate_invoices_simple` / `unconsolidate_invoices_simple` de un contrato | Nueva | U1 (cantidades reescritas), U2 (validador por headers), header clonado (vencimiento NULL, FX pegado), DELETE físico al consolidar | ✅ 30-09 (API) |
| F16 | Anular con NC espejo y reemitir | `POST …/:invoiceId/void/preview` y `POST …/:invoiceId/void` `{ reason: issue_error \| client_request \| other, notes?, reissue, reissue_changes? }` (spec facturas §3.8, "Etapa 6 construida"): NC espejo exacta (`insertMirrorCreditNote`: IVA guardado de cada línea, ambas monedas, tasa, receptor; `credit_type = cancellation`; Por Emitir, **sin vencimiento**, `related_invoice_id`); la emitida no cambia de estado (`voided` derivado de la NC de anulación); reemisión Por Emitir por la lógica del editor (copia exacta o `reissue_changes`; `related_invoice_id`, `split_reason = 'reissue'`, "Reemplaza a F-xxxx", referencias copiadas); consumos del período a la reemisión o libres; bloqueos `already_voided`, `not_issued`, `credit_note`, `unified_invoice`, `legacy_invoice` (sin `period_closed` desde 03-10); aviso `paid_invoice_voided`. Eventos `INVOICE_VOIDED` + `INVOICE_REISSUED`; devengo del mes del período | `create_credit_note_safe` (cancellation), `cancel_invoice_with_credit_note` | Nueva | NC con IVA en moneda de contrato y FX invertido (ROADMAP #10), NC que vence, original y NC "Canceladas" fuera de los KPIs | ✅ 30-09 (API) |
| F17 | NC de descuento parcial sobre una emitida | `POST …/:invoiceId/credit-note/preview` y `POST …/:invoiceId/credit-note` `{ lines?[{ line_id, amount? \| pct? }] \| pct?, reason, revenue_treatment: service_period \| impact_month \| defer_forward, notes? }`: montos en moneda de factura, una línea negativa por línea (cantidad 1, mismo ítem y período), `credit_type = discount`, `nc_revenue_treatment`; bloqueo `exceeds_line` (lo que queda tras NC de descuento previas); `revenue_effect` en la vista previa. Evento `INVOICE_CREDIT_NOTE_CREATED` | `create_credit_note_safe` (discount) desde Facturación | Nueva | NC "suelta" sin factura ni motivo (§8: no existen) | ✅ 30-09 (API) |
| F18 | Facturar por OC (línea visible ↔ internas) | `POST …/:invoiceId/partial-by-po/preview` y `POST …/:invoiceId/partial-by-po` `{ reference, amount_invoice_currency, allocation?, visible_line_text, reason }` (spec facturas §3.7b, "Etapa 6 construida"): propuesta exacta (≤ 12 líneas) o parcial a precio de lista; una línea visible (cantidad 1, unitario = OC, montos en 0) + internas con `invoice_items.visible_line_id`; referencia OC/HES; saldo a una Por Emitir nueva (`split_reason = 'partial_by_po'`); neto exacto y `fx_difference`; aviso `open_consumption`. Evento `INVOICE_PARTIAL_BILLING`. La factura por OC queda fija (`partial_billing_invoice` en editar líneas, reorganizar y FX) | OC cargada a mano, factura partida en Reestructurar | Nueva | caso 6 (Alicorp): OC por monto que no calza con los ítems | ✅ 30-09 (API; migración sin aplicar; mapper Odoo pendiente) |


**Borrador en 360 › Facturas (30-09):** `GET /contracts/:id/invoices/preview` calcula al vuelo las facturas que generará un borrador (su `form` → el mismo `preview` del wizard, misma respuesta; 409 `not_draft` si no es borrador); v2 no escribe `contract_invoices` (era la vista previa del front viejo).

Etapas 1–2 de [`spec-facturas-en-contrato-360.md`](./spec-facturas-en-contrato-360.md) (F6–F8b): `contract-invoices.ts` (lógica pura) +
`contract-invoices.service.ts` (una transacción por operación con `sapira.writer = 'api'`, `FOR UPDATE` del contrato y de la factura, evento con
`metadata.invoice_id` que lee `history[]` del detalle; `preview` = mismo cálculo sin escribir). **Sin esquema nuevo** (regla dura de Domi 29-09:
nunca columnas, funciones ni endpoints que dupliquen algo existente): todo lo que la spec §4 pedía como columna se **deriva** — `fx_policy` =
`same_currency` (monedas iguales) \| `spot` (conversión y `fx_contract_to_invoice` NULL) \| `fixed` (con valor); `fx_rate` = `fx_contract_to_invoice`;
`fx_rate_source` = `invoice_items.fx_rate_source` más frecuente de las líneas (v2 escribe `manual` \| `net_exact` + `fx_rate_date`); `fx_confirmed_at` =
`created_at` del último `INVOICE_FX_CHANGED`; `issued_externally` = existe `INVOICE_ISSUED_EXTERNALLY` de la factura; `erp_sync_state` = `none` \|
`draft` \| `sent` por `odoo_invoice_id` + estado. Decisiones tomadas al construir: (1) mientras no exista "Retirar del ERP" (§3.1, etapa siguiente),
una PE con `odoo_invoice_id` **bloquea** (`sent_to_erp_draft`) reprogramar, FX y emisión externa, en vez de avisar; (2) `reason`/`notes` son
opcionales y van al evento (no se exige motivo ante avisos, a diferencia de `changes`); (3) `INVOICE_SENT_MANUALLY` en lugar de
`INVOICE_SENT_TO_ERP` de la spec, por pedido de la etapa; (4) `GET /contracts/:id/invoices/:invoiceId` suma `fx_policy`, `fx_rate`, `fx_rate_source`,
`fx_confirmed_at`, `issued_externally`, `erp_sync_state` e `history[]`; la lista suma `fx_policy`, `fx_rate`, `issued_externally`,
`original_issue_date`. Guard del scheduler (U12/B3) sobre datos existentes: `calculateInvoiceAmountsAtIssue` con `contracts.fx_invoice_policy =
'fixed'`, monedas distintas y `fx_contract_to_invoice` NULL **se detiene** (omitida con aviso `exchange_rate`), nunca sale a spot en silencio; con
política `spot` la tasa pegada no se usa (Banco Central, como antes). Esto cubre desde ya las 11 PE expuestas al 24-09. Pendiente de la etapa 1:
`erp-withdraw` (decisión #10 de Leon sobre cancelar el borrador en Odoo); mientras, **Restablecer borrador del ERP** (F14, 30-09) desvincula la
PE con evento y el bloqueo `sent_to_erp_draft` lleva `action: 'erp_reset'`.

Etapa 5 (F15, 30-09): `invoice-reorganize.ts` (pura) + `contract-invoice-reorganize.service.ts`. Reemplaza Reestructurar y consolidar/desconsolidar
de un contrato (Decisión 1 de la spec facturas: Reorganizar + Editar borrador, sin modo "Ajustar montos"); **sin columnas nuevas** (usa
`invoices.split_reason`/`split_from_invoice_id` existentes). `invoice_reschedule_items`, `check_contract_item_continuity` y los dos de consolidación
de un contrato quedan para retirar al switch (§5).

### 2d · Modificaciones (S3, manual de modificaciones)

| # | Operación v2 | Cómo funciona | Hoy | Veredicto | Evita de raíz | Lunes |
|---|---|---|---|---|---|---|
| M1 | **Modificar contrato** (una sola entrada) | "Valores nuevos completos" por ítem (cantidad, unitario mensual o anual, descuento, frecuencia, fin) + fecha efectiva + origen (manual o cotización). Un solo cálculo (fórmula unificada del delta, manual §8) decide UPSELL / DOWNSELL / RENEGOTIATION; **CROSS-SELL** si el producto no existe en el contrato. Ítem de ajuste acumulativo con `related_item_id`; hereda tipo, método, moneda y política del padre como **defaults editables** (S3-19, obs. 3); termina con el contrato (D-B); primer tramo proporcional por días en upsell/cross-sell en la factura del ciclo, o factura suelta si la usuaria lo elige (S3-5, S3-17); downsell sin prorrateo, rige desde el próximo período (S3-5/6); downsell al 100% se deriva a M2 (S3-7); opción de **línea neta** en upsell (S3-14); facturas vía F1/F3 agrupando **por período**, excluyendo unificadas; preview obligatorio "se suma a la factura X / se crea nueva"; aviso de posible duplicado (misma dirección, producto y fechas); cotización pasa a "Contrato creado" solo al final | `UpsellingModal` e `AssignToContractModal` inline (6 tablas sin transacción), `create_contract_cross_sell` → `approve_contract_amendment`, `apply_quote_downsell_to_contract`, `ContractionModal` en 7 modos | Nueva | período "1 a 1" (23-09 #1), ancla al booking (Bosch), plazo sin acotar (S04191, 20 de 44), UPSELL de producto nuevo, moneda/FX de la cotización (U10, S02656), IVA 19% fijo (129 MX + 37 PE), merge por fecha exacta, facturas del ítem nuevo no generadas (Stanhome), sin evento ni usuario (duplicado S04191), downsell sin descuento (Sinba), doble prorrateo en RSM (Bosch −10,51), dos ejes que pierden el término cruzado (STG) | ✅ |
| M2 | Contracción (churn total o de un ítem) | Early (fecha ≤ fin) vs non-renewal (fin + 1). **Manda el inicio del ítem CHURN** (U5): `churn_date`, cortes y NC usan esa fecha; en las Por Emitir **se quita solo la línea del ítem** y se recalcula el header (ROADMAP #11); emitidas del período con NC **espejo exacto de la original** en moneda y FX (ROADMAP #10); ítems con MRR 0 no bloquean; contrato Cancelado si no quedan recurrentes; motivo de catálogo | `apply_contract_contraction` | Nueva | U5 / La Mascota, PE entera cancelada (Stanhome, NSAgro), 13 NC en moneda equivocada | ✅ |
| M3 | Renovar (uno o varios ítems, atómico) | Una operación (S3-8); nunca sobre ítems renovados, cancelados o con churn; cambio de precio = RENEWAL al precio anterior + ajuste explícito (S3-15); facturas con F1 (tipo de documento, vencimiento por términos, último período proporcional S4-16); actualiza fin del contrato = **el más próximo** de los recurrentes vigentes (S2-13) y `total_value` | `create_contract_renewal` v2, una llamada por ítem | Nueva | `export_type = 1` fijo, `+30`, fin y TV sin actualizar (27 de 33) | Si alcanza; si no, después |
| M4 | Reactivar | `reactivate` (spec §9.3.2): churn no vigente → anular; vigente en mes abierto → revertir (PE del tramo; NC emitidas quedan); mes cerrado → REACTIVATION nuevo. Contrato vuelve a Activo; evento original `reversed_by` | Solo SQL nuestro | Nueva | "revertir churn" por SQL | ✅ 01-10 (API, B2-3) |
| M5 | Cambiar razón social | Actualiza `client_entity_id` + PE pendientes (RUT, IVA, tipo de documento, serie) con evento (Medios #13) | Solo BD | Nueva | swap manual (Ransa SV) | Después |
| M6 | Pausar / reanudar | `pause` / `resume` (spec §9.3.3): por ítem, `contract_item_pauses`; PE del tramo fuera (prorrateo por días en los bordes), emitidas `keep \| void`; devengo y MRR 0 en el tramo (momentum PAUSE/RESUME); `extend_term` corre el fin; estado derivado Pausado | Workaround RENEWAL+DOWNSELL | Nueva | sub-bug B del RSM | ✅ 01-10 (API, B2-5) |
| M7 | Auto-renovación con confirmación | Job `contracts-auto-renewal` (06:00) propone (`RENEWAL_PROPOSED` + notificación), nunca renueva; confirmar = `renewal` con origin `renewal_proposal`; omitir con motivo; `billing_conditions.auto_renew` apaga | Cron legacy (desprogramado) | Nueva | renovaciones silenciosas / cron que fallaba siempre | ✅ 01-10 (API, B2-4) |

**Modificaciones v2 construidas (28-09, código listo): `POST /contracts/:id/changes/preview` y `POST /contracts/:id/changes`.**
Spec: [`spec-modificaciones-contrato-v2.md`](./spec-modificaciones-contrato-v2.md) §4. Un solo servicio (`contract-changes.service.ts`) y un
solo cálculo puro (`contract-changes.ts` → `planChange`) para preview y aplicar; body `{ effective_date, origin { manual | quote:id },
reason?, reason_id? (churn_reasons), notes?, change { type, … } }`; header opcional `Idempotency-Key` (se guarda en `metadata`,
Supuesto 5). Aplicar = una transacción: `set_config('sapira.writer','api')` → `FOR UPDATE` del contrato → contexto → plan → ítems
(categoría, fin y precios explícitos; el fin se fija con un UPDATE posterior porque `set_contract_item_end_date` lo recalcula) →
facturas (cambio mínimo sobre Por Emitir activas no legacy/unificadas/NC; emitidas nunca: NC espejo) → encabezado (`total_value`,
fin más próximo con `sapira.bypass_end_date_guard` + evento) → `revenue_schedule_rebuild(contrato, mes)` → evento con before/after
→ etapa "Contrato creado" si el origen es cotización. Bloqueos → 409 `code: blocked` + preview; advertencias sin `reason`/`notes` → 400.

| Tipo | Qué hace | Categoría / evento |
|---|---|---|
| `billing_conditions` | `auto_renew` (§9.3.5, B2-4: enciende/apaga `auto_renew` en los recurrentes vivos que difieren; `fields_after.auto_renew_items`), `payment_terms` (solo contrato + aviso de PE que conservan el vencimiento, S4-10), `invoice_terms_and_conditions` (solo contrato; con `apply_to_pending: true` también las PE activas desde la fecha, reglas del masivo de facturas: omitidas con motivo en `pending_terms.skipped`, un `INVOICE_EDITED` por factura con `bulk_id`), `tax_document_type_id` o `document_type` (contrato + PE desde la fecha: documento, `export_type`, IVA recalculado), `auto_send_to_odoo`/`auto_invoice` (S6-10; PE desde la fecha), `requires_references_for_billing`, `group_invoices_by_period` (solo lo nuevo), `invoice_currency` + `fx_invoice_policy` + `fx_invoice_rates` (PE desde la fecha: moneda, FX fijo valorizado o NULL en spot; UF bloquea; fijo sin tasa bloquea; tasas nuevas se agregan con `purpose = 'invoice'`) | `CONDITIONS_UPDATED` (sin ítems ni RSM) |
| `change_entity` | `client_entity_id` del **mismo cliente** o `new_entity { legal_name, tax_id, country, address?, email?, payment_terms? }` (§9.3.10: busca por identificador normalizado en el holding; del cliente → la usa con aviso `entity_already_exists`; de otro cliente → blocker `entity_belongs_to_other_client`; no existe → `client_entities` + `client_entity_clients` `is_primary = false` en la misma transacción); `client_id` → 400 (fuera, §9.1 #10); contrato + PE con emisión desde la fecha (receptor, RUT); sin catálogo re-deriva el documento por país (aviso), con catálogo solo avisa; guard de período del contrato como bloqueo | `ENTITY_CHANGED` (`metadata.entity_created`) |
| `item_remove` | early (efectiva ≤ fin): espejo con la categoría, **inicio = fecha efectiva** (U5), `qty × unit = −MRR`, fin del original; non-renewal: solo `churn_date`. PE: se quita solo la línea del ítem con período ≥ fecha, la que contiene la fecha se prorratea por días, encabezado = Σ líneas, sin líneas → Cancelada; emitidas con período ≥ fecha → NC espejo exacto (moneda, FX, IVA, receptor) por los días no consumidos, nace Por Emitir. DOWNSELL si quedan otros productos, CHURN si era el último (con aviso: el estado no cambia solo) | `DOWNSELL` / `CHURN`, subtipo `early` / `non_renewal` |
| `contract_cancel` | Todos los recurrentes vivos como `item_remove` + `status = 'Cancelado'`, `churn_date`, `churn_reason(_id)`. **Decisión por factura** (§9.3.1, B2-1): el preview devuelve `invoice_decisions_required[{ invoice_id, invoice_number, issue_date, status_group: pending\|issued, amount_after_effective, options, default, reason_hint, action }]` y `effective_date_suggestions[{ effective_date, reason: last_issued_period\|current_period, message }]`; el body manda `change.invoice_decisions[{ invoice_id, action }]` (Por Emitir: `emit` = completa con aviso `billed_beyond_effective_date` \| `cancel` = regla de la baja, la facturada por OC se cancela entera; emitida: `keep` sin NC \| `void` NC proporcional); falta alguna → blocker `invoice_decision_required`. Las líneas a mano entran a la misma decisión (se retira `manual_lines_pending`). Pactos programados de los ítems → `cancelled` (`item_ended`) | `CHURN`, subtipo `contract_cancel`, `metadata.invoice_decisions` |
| `renewal` | N ítems atómico (S3-8): RENEWAL desde `fin + 1` con `renews_item_id`, `term_months` o `end_date` (meses enteros), frecuencia/método como defaults editables (S3-19); el original y sus ajustes co-terminados quedan con `renewed_by_item_id` (la renovación parte del valor del ítem madre). **Precio nuevo** (§9.3.4, B2-2): `items[].quantity|unit_price|price_entry_mode|discount_value` → RENEWAL al valor vigente + ajuste UPSELL/DOWNSELL (`related_item_id` = RENEWAL, mismo inicio/fin) + pacto `on_renewal` `applied`; línea neta por período ligada al RENEWAL. **Pactos** `on_renewal` `scheduled` del ítem y del contrato se aplican en el acto (`scheduled_change_decisions[{ scheduled_change_id, action: apply\|skip, value?, reason? }]`; índice sin dato → `index_value_missing`). **FX**: `fx_invoice_rates[]`/`fx_item_rates[]` nuevas o extensión de la tasa "de todo el contrato" por propósito y par (op `extend_fx_rates`, aviso `fx_rate_extended`, `fx_rates_extended[]` en el preview); sin cobertura → `fixed_fx_without_rate` con el par. Facturas con el generador v2, fusionadas con la PE del mes; fin del contrato = el más próximo; retroactiva avisa; `current_month` → 400 | `RENEWAL` (subtipo `price_change` con ajuste) |
| `item_add` | Solo Activo (S3-1). CROSS-SELL si el producto no está en el contrato, UPSELL de ítem nuevo con aviso si está (Supuesto 2, `related_item_id` al base vivo); hereda tipo, unidad, frecuencia y método del relacionado o del primer recurrente; inicio = fecha efectiva (o posterior); fin default = fin del contrato y se acota a él con aviso (D-B); valor = tramo inicial por días + períodos completos (Σ facturas = TV); `first_period_invoice` `cycle` (tramo en la factura del ciclo) o `immediate` (factura suelta el día de inicio, S3-17); fusión por receptor, moneda, documento y mes de emisión con la PE existente (hereda su FX, S6-2); `items[].price?: PriceSpec` (Pricing v2, misma validación que al crear: tramos, métrica del holding, medido + Anticipado → 400 salvo seat) se guarda en `prices` (owner = contract, v1) y el ítem lo apunta con `price_id`; el generador tarifa sus líneas con el motor y `unit_price` queda como mensual equivalente. Cotización: `quote_already_applied` y `new_business_quote_on_existing_contract` (S3-3) | `CROSS_SELL` / `UPSELL` |
| `item_change` | Valores nuevos completos `(q, p, desc)` sobre el ítem madre del `item_id` → fórmula unificada (`ΔMRR`, ancla; STG −20 × −2,56 = +51,20). UPSELL parte el día efectivo y prorratea el primer tramo (línea propia fusionada o `net_line`); DOWNSELL parte en el **próximo inicio de período** sin prorrateo (S3-5/6) y reescribe la línea base de las PE al neto (S3-14). Bloquea `issued_after_effective_date` con la fecha sugerida. **Frecuencia/plazo** (§9.3.7, B2-2): `items[].billing_frequency`/`term_months` → corte al próximo inicio de período (`end_date` = corte − 1, valor = mensual × meses, `renewed_by_item_id`), RENEWAL con la frecuencia/plazo nuevos (+ ajuste si cambia el precio), pacto `applied` (`billing_frequency` = meses / `term`), PE del original desde el corte sin su línea. `items[].quote_item_id` queda en el ajuste. `end_date` → 400 | `UPSELL` / `DOWNSELL` / `RENEWAL`, subtipo `quantity` / `price` / `RENEGOTIATION` (`metadata.reterm`) / `price_step` / `index` (pactos) |
| `reactivate` | §9.3.2 (B2-3): `items?[{ item_id, quantity?, unit_price? }]` (sin lista = lo que canceló la cancelación). (a) churn > hoy → anular (borra el espejo y su devengo, limpia churn, cancela NC Por Emitir de la baja, rehace PE de lo no cubierto); (b) vigente en mes abierto → revertir (igual + PE del tramo acreditado por NC emitidas, aviso `credit_notes_issued_kept`); (c) mes cerrado → REACTIVATION nuevo desde la fecha efectiva (clasificación a nivel cliente: UPSELL/CROSS-SELL si el cliente tiene otro contrato vigente). Cancelado → `Activo`; el evento de baja original recibe `metadata.reversed_by`. Blockers `not_cancelled`, `period_closed` | `CHURN_REVERSED` (a/b) / `REACTIVATION` (c); `reactivation[]` en el preview |
| `item_add` · ciclo propio y cotización | §9.3.9: `items[].billing_cycle: contract\|own` (`own` ⇒ `billing_anchor_day` = día de inicio, sin tramo prorrateado, factura en su propia fecha y solo se funde con una PE de la misma fecha exacta). Cotización: `items[].quote_item_id` completa producto, cantidad, precio o modelo, descuento, frecuencia, método, inicio (S3-4) y moneda de la cotización; el ítem queda con `quote_item_id` | `CROSS_SELL` / `UPSELL` |
| `pause` | §9.3.3 (B2-5): `{ items?[{ item_id }] (sin lista = recurrentes vivos), pause_start? (= fecha efectiva), pause_end? (null = hasta reanudar, ≤ fin del ítem), extend_term?, invoice_decisions? }`. Fila `contract_item_pauses` por ítem **y por sus ajustes vivos** (`scheduled` si empieza después de hoy, si no `active`; `pause_event_id`). PE: línea fuera si todo su período cae en la pausa; borde → prorrateo por días y el período se corta (`billing_period_start`/`end`); en medio → baja el monto; vacía → Cancelada; consumo registrado se conserva con aviso. Emitidas que cubren días pausados → `invoice_decisions_required` (`keep \| void`, default `void` = NC por los días); falta → `invoice_decision_required`. `extend_term` con fin conocido corre el fin del ítem en los días pausados en el acto (tramo nuevo con el generador; fin del contrato con bypass si es el más próximo). Preview `pauses[]`; MRR después sin los pausados a la fecha. Blockers `item_already_paused`, `pause_overlaps`, `period_closed`, `invoice_decision_required` | `PAUSE`, subtipo `open` / `fixed`, `metadata { pause_start, pause_end, extend_term, pauses, invoice_decisions }` |
| `resume` | §9.3.3 (B2-5): `{ items?[{ item_id }] (sin lista = todos los pausados), resume_date? (= fecha efectiva) }`. Cierra la pausa vigente o futura: `pause_end = resume_date − 1`, `ended` (una que aún no empezaba → `cancelled`, aviso `pause_cancelled`); `resume_event_id`. PE desde la reanudación con el generador (solo días sin factura, fusión F3). `extend_term` → el fin se corre en los días pausados menos lo ya corrido al pausar con fin conocido (reanudar antes lo devuelve: baja de líneas desde el nuevo fin). Blockers `not_paused`, `period_closed` | `RESUME` (subtipo `extend_term`), `metadata { resume_date, pauses }` |
| `item_update` | §9.2 (01-10): `{ items[{ item_id, account? }] }` (la UI manda todos los ítems del producto + cuenta), datos no comerciales del ítem (hoy la cuenta: se recorta, vacía = NULL; al menos un campo, distinta de la actual). Escribe `contract_items.account`; sin ítems espejo, sin ΔMRR, sin RSM, sin precios. Regenera con la plantilla del contrato (`ContractInvoiceDescriptionsService.regenerateLines`) la glosa de las líneas Por Emitir del ítem que no estén protegidas (`description_locked`), editadas a mano, visibles de factura por OC ni con borrador en el ERP; emitidas intactas. Preview `items_after[{ item_id, product_name, account_before, account }]`, aviso `pending_descriptions_updated` (con el conteo; **informativo**: no pide motivo, `INFORMATIVE_WARNINGS` del servicio) y `possible_duplicate` (los ítems que se mueven juntos desde la misma cuenta no cuentan) (mismo producto + cuenta + inicio). Estados: Activo, Por renovar, Vencido, Pausado. Blocker `item_not_found` | `ITEM_UPDATED` (subtipo `account`), `metadata { items[{ item_id, account_before, account_after }], pending_descriptions_updated, descriptions_regenerated }` |
| `renewal` · confirmar propuesta | §9.3.5 (B2-4): `origin { type: 'renewal_proposal', event_id }` (solo con `renewal`, 400 si no); la propuesta debe ser del contrato y estar abierta (blocker `renewal_proposal_not_open`); al aplicar queda `metadata.status = confirmed`, `confirmed_by_event_id`, `event_status = Completed`. Precio y pactos editables como cualquier renovación | `RENEWAL` (`metadata.origin`) |
| `price_adjustment` | **No es un cambio**: 400 (el reajuste es un pacto, §9.3.6) | — |

**Ajustes pactados (R1, §9.3.6, B2-2)**: `GET/POST /contracts/:id/scheduled-changes`, `PATCH …/:changeId` (solo `scheduled`, 409
`scheduled_change_not_editable`), `POST …/:changeId/skip|cancel { reason }` (every_n_months: omite solo la próxima), `POST
…/:changeId/apply/preview|apply` (on_renewal → `renewal`; precio/cantidad/índice en fecha → `item_change` desde el próximo inicio de
período, sin prorrateo; plazo/frecuencia → §9.3.7; el evento es el del cambio con `metadata.scheduled_change_id` y la fila guarda
`applied_event_id`). Alta: `CreateContractDto.scheduled_changes[]` (`item_key` del formulario; PUT reemplaza los `scheduled`). Eventos
`SCHEDULED_CHANGE_CREATED|UPDATED|SKIPPED|CANCELLED`. El detalle (`GET /contracts/:id`) expone `scheduled_changes[]` y los ítems
`billing_anchor_day`. Cotizaciones: `GET /quotes/:id/contract-targets` (contratos Activos del cliente con sugerencia `item_change`/`item_add`
por ítem cotizado, blockers y avisos). Migración `1790710000000-ContractModificationsBlock2` **sin aplicar** (ver spec §9.4).

**Auto-renovación y pactos por vencer (B2-4, §9.3.5–§9.3.6)**: `ContractsScheduler` (`contracts.scheduler.ts`, `America/Santiago`,
`CONTRACT_JOBS_ENABLED=false` apaga) → `ContractRenewalsService`. **`contracts-auto-renewal` (06:00)**: por holding (try/catch), ítems
recurrentes `auto_renew` sin renovar ni churn de contratos `active | pending_renewal` con `end_date ≤ hoy + holding_settings.auto_renewal_notice_days`
→ un evento `RENEWAL_PROPOSED` por contrato (`event_status Pending`, `created_by` = actor sistema `00000000-…`, `metadata { status: open,
proposal_keys (ítem:fin), items, preview (compacto, solo lectura), pacts (on_renewal), notice_days, created_by_system }`), idempotente por
ítem y fin revisado con el contrato `FOR UPDATE`, + notificación `contract_renewal_proposed`. **Nunca renueva.** **`contracts-scheduled-changes`
(05:30)**: pactos `on_date` / `every_n_months` `scheduled` con fecha ≤ hoy + aviso → `SCHEDULED_CHANGE_DUE` (`metadata { scheduled_change_id,
due_date, due_key, index { code, value_missing, percent } , blockers }`), idempotente por pacto y fecha, + notificación
`contract_scheduled_change_due`; aplicar sigue manual (`…/scheduled-changes/:id/apply`, que en `every_n_months` crea la hija `applied` y
avanza `next_effective_date`). Endpoints: `GET /contracts/renewal-proposals` → `{ data[{ event_id, contract_id, contract_number,
client_name, contract_currency, status, items[], end_date, days_to_end, renewal_start, monthly_total, preview, pacts, created_at }], counts {
open, renew_in_30_days, overdue } }` (KPI "Renuevan en 30 días"; solo ítems aún pendientes); `POST /contracts/:id/renewal-proposals/:eventId/dismiss
{ reason }` → `RENEWAL_PROPOSAL_DISMISSED` (404 `renewal_proposal_not_found`, 409 `renewal_proposal_not_open`). El detalle expone
`renewal_proposals[]` (abiertas) y `pauses[]`; `GET /contracts/:id/items` trae `pauses[]` por ítem (`active_today`).

Bloqueos (409): `not_active`, `period_closed` (+ paso "reabrir en Configuración"), `issued_after_effective_date`, `item_already_churned`,
`item_already_renewed`, `unified_invoice_in_range`, `fixed_fx_without_rate`, `quote_already_applied`, `new_business_quote_on_existing_contract`,
`uf_invoice_currency`, `invoice_decision_required`, `entity_belongs_to_other_client`, `not_cancelled`, `index_value_missing`,
`scheduled_change_not_scheduled`, `renewal_proposal_not_open`, `item_already_paused`, `pause_overlaps`, `not_paused`. Avisos B2:
`billed_beyond_effective_date`, `entity_already_exists`, `fx_rate_extended`, `credit_notes_issued_kept`, `pause_cancelled`,
`extend_term_on_resume`. Advertencias (piden motivo): `possible_duplicate`, `unpaid_invoice_prorated`, `pending_invoices_keep_old_terms`,
`pending_invoices_keep_grouping`, `quantity_overrides_present`, `mrr_zero_items_skipped`, `term_exceeds_contract_capped`,
`upsell_of_existing_product`, `downsell_from_next_period`, `retroactive_renewal`, `adjustments_absorbed`, `contract_without_live_items`,
`document_type_changed`, `document_type_review`, `generator` (avisos del generador).

Supuestos aplicados además de los de la spec (se confirman con Domi): "PE desde la fecha efectiva" = Por Emitir activas con `issue_date ≥
effective_date`; la NC espejo nace Por Emitir (S4-8 con Leon) con `credit_reason` churn/downsell; `item_remove` del último ítem **no**
cambia `status` (solo `contract_cancel`, regla "acción explícita" de Domi 25-09); el valor (`final_price`) de un UPSELL/CROSS-SELL con
tramo inicial es el real por días (Σ facturas = TV, manual #8) y `term_months` el entero de meses cubiertos, mientras que en DOWNSELL/CHURN
es `ΔMRR × término` porque el trigger deriva el mensual de `final / term`; la renovación absorbe los ajustes vivos co-terminados
partiendo del valor del ítem madre (manual #13, 0 casos); `booking_date` de los ítems nuevos = fecha efectiva; en `renewal` se copia
`price_id`; el espejo de una baja sigue a su base en el ítem madre (`buildItemGroups`: si la base ya churneó, el espejo tampoco cuenta;
manual §10). Lado RSM (01-10, asset sin aplicar): `revenue_schedule_rebuild_contract_ccy` prorratea CHURN/REACTIVATION por días (U5), usa
`monthly_price` como mensual (sin doble prorrateo, S5-16) y el rebuild parcial continúa el acumulado (U8); verificación en
[`cobertura-contratos-v2.md`](./cobertura-contratos-v2.md) §6.

### 2e · Estados y vencimiento

| # | Operación v2 | Cómo funciona | Veredicto | Lunes |
|---|---|---|---|---|
| E1 | Vencimiento | Ítem vencido sin decisión = "Pendiente de renovar" con alertas crecientes; cuando vencen todos, Expirado reversible (S2-1, S5-4) | Nueva | Después |
| E2 | Auto-renovación | **Propone** N días antes (30 por defecto, por holding) y la usuaria confirma (S2-2/3). El cron viejo no se arregla (decisión #5) | Nueva | Después |
| E3 | Vencimiento de la factura | Una sola regla, `billing-engine.computeDueDate(issue_date, contracts.payment_terms ?? client_entities.payment_terms, país)`: la usan el generador (activación), la complementaria/reemisión por consumo y desde el 29-09 **reprogramar** y **emisión externa** (F7/F8): el vencimiento se recalcula siempre que cambia la emisión de una PE; nunca `+30` fijo salvo sin condición y fuera de México | Nueva | ✅ 29-09 |

> Estados y avisos de las facturas del contrato (desvío plan ↔ factura, saldo pendiente por OC, PE enviada al ERP sin retiro): [`spec-facturas-en-contrato-360.md`](./spec-facturas-en-contrato-360.md) §3.4, §3.7b, §3.1.

### 2f · Pricing v2 (modelos de precio, tramos y consumo) — etapas 1, 2 y 3 (catálogo en API), código listo (28-09)

Spec: [`spec-pricing-v2.md`](./spec-pricing-v2.md). Construido en `src/modules/contracts/` sin tocar otros módulos.

| # | Pieza | Qué hace | Dónde |
|---|---|---|---|
| P1 | Esquema aditivo | `billable_metrics`, `prices` (con `invoice_line_mode` y `charge_flat_when_free`), `consumption_entries` (con `invoice_id` → factura que lleva el consumo), `consumption_entry_revisions`; `contract_items.price_id`; `invoice_items.pricing_breakdown` + `quantity_source`; `invoice_items_quantity_check` pasa a `>= 0` (consumo 0 deja la línea en 0). RLS por holding (espejo de `holding_access_contract_items`) | entities `entities/contratos/{billable-metric,price,consumption-entry,consumption-entry-revision}.entity.ts`, migración `1790630000000-CreatePricingV2`, `rls/holding_access_{billable_metrics,prices,consumption_entries,consumption_entry_revisions}.sql` |
| P2 | Motor puro | `validatePriceSpec` (§3.1), `resolveQuantity` (§3.7), `priceLine` (gratis → tramos → descuento → mínimo → tope, redondeo §3.6 con residuo en el último tramo; `charge_flat_when_free` §3.5), `pricingGlosa`/`splitInvoiceLines`/`distributeTax` (presentación §3.8). `generateInvoices` llama al motor por cuota cuando el ítem tiene `price` ≠ standard fijo; la línea lleva `quantity_source` y `pricing.breakdown`; con `invoice_line_mode = per_tier` la cuota produce varias líneas (`line_group`, `line_part`) | `pricing-engine.ts`, `billing-engine.ts` |
| P3 | Alta y activación | `items[].price` (PriceSpecDto) en `POST /contracts`, `POST /contracts/preview`, `PUT /contracts/:id`; se guarda en `prices` (`owner = contract`, v1 activo) y el ítem lo apunta; editar con otro precio crea v2 (`supersedes_price_id`) y archiva v1 (evento `PRICE_CHANGED`). `POST /contracts/price-preview` para la vista previa en vivo. `metered` + Anticipado → 400 salvo `seat`; `price_id` de catálogo → 400 (etapa 3). La activación persiste `quantity_source` y `pricing_breakdown` por línea | `contract-drafts.service.ts`, `contract-activation.service.ts`, `dtos/create-contract.dto.ts`, `price-rows.ts` |
| P4 | Consumos (etapa 2) | `PUT /contracts/:id/items/:itemId/consumption/:periodStart` (upsert con revisión y motivo obligatorio desde la 2), `POST …/consumption/preview`, `POST …/consumption/bulk` (1–500 filas, una transacción por fila), `GET /contracts/:id/consumption` (entries + `quantities` viejas como `legacy`, ítems con precio/métrica/períodos, pendientes, `invoice.is_complementary`), `GET /contracts/:id/consumption/pending` y `GET /consumption/pending` (paginado). Recálculo §4.3 de la Por Emitir del período según `invoice_line_mode` (una fila reescrita o el conjunto `per_tier` reemplazado) + encabezado + `revenue_schedule_rebuild(contrato, mes)` + evento `CONSUMPTION_RECORDED`/`CONSUMPTION_CORRECTED`; `apply_as` (spec §4.4; alias `on_issued`, `block` = `recompute`): con la emitida, `recompute` → 409 `consumption_period_issued` con `issued_invoice`/`additional_amount`/`additional_allowed` (`item_not_metered` en ítems estándar); `additional` → factura complementaria Por Emitir con una línea por la diferencia (`CONSUMPTION_ADDITIONAL_INVOICE`), **también con la Por Emitir del período** (29-09: la del período no se toca, la nueva nace con fecha de hoy y vencimiento según condición de pago; `complements_invoice` en la respuesta); `reissue` → NC espejo (`insertMirrorCreditNote`, `issue_error`/`cancellation`) + factura nueva del período (`CONSUMPTION_REISSUE`); sin línea → 409 `period_out_of_item`; solo anuladas → guarda sin recalcular. **Ítems estándar** (29-09): aceptan cantidad con la Por Emitir (cantidad × unitario del período de la línea, glosa intacta, `priceStandardLine`); el `GET /:id/consumption` los lista con `accepts_consumption`. `consumption_entries.invoice_id` guarda qué factura lleva cada consumo | `consumption.ts` (reglas puras), `consumption.service.ts`, `consumption.controller.ts`, `dtos/consumption.dto.ts`, `contract-changes.service.ts` (`insertMirrorCreditNote`) |
| P5 | Métricas facturables | `GET/POST /billable-metrics`, `GET/PATCH /billable-metrics/:id`, `POST /billable-metrics/:id/archive` (409 con precios activos); `prices_count` y `last_sync_at` (última entry `dwh`/`api`). Solo `manual`/`csv` funcionales | `billable-metrics.service.ts`, `billable-metrics.controller.ts`, `dtos/billable-metric.dto.ts` |
| P6 | 360 | `overview.facts.uses_usage_pricing`; la pestaña Consumos lee `GET /:id/consumption` | `contract-360.service.ts`, `contract-360.ts` (`buildConsumption`) |
| P7 | Catálogo de precios (etapa 3) | `prices.owner = catalog` versionado por holding: `GET /prices` (paginado, filtros, orden por lista blanca, `contracts_count`), `GET /prices/:id` (+ `versions[]` de la cadena producto + moneda y `contracts[]`), `POST /prices` (borrador, `version` siguiente), `PATCH /prices/:id` (solo borrador), `POST /prices/:id/publish` (archiva la activa anterior, `supersedes_price_id`, transacción), `POST /prices/:id/archive` (permitido con contratos: `warnings[]`), `POST /prices/:id/new-version`. `items[].price_id` en `POST/PUT /contracts` e `item_add`: el catálogo debe estar activo, ser del mismo producto y de la moneda del contrato, y no venir con `price`; el contrato recibe una **copia** `owner = contract` (v1, `list_price_id`, nombre del catálogo) y nunca apunta al catálogo, así publicar o archivar no toca contratos. `form` devuelve `price` + `list_price_id`; en PUT, otro catálogo o otro spec crea la versión siguiente de la copia. Columna nueva `prices.notes` (en la migración `1790630000000`, sin aplicar). Pendiente: pantalla "Planes y precios" en front-sapira, tramos en cotizaciones | `prices.service.ts`, `prices.controller.ts`, `dtos/price.dto.ts`, `catalog-prices.ts` (lectura y reglas compartidas), `contract-drafts.service.ts`, `contract-changes.ts`, `contract-changes.service.ts`, `price-rows.ts` (`list_price_id` en `PRICE_COLUMNS`) |

**Triggers verificados en QA (solo lectura, 28-09)** para el UPDATE de `invoice_items` del recálculo: `update_invoice_items_updated_at`
(BEFORE UPDATE, solo `updated_at`) y `sync_invoice_item_contract_id` (BEFORE INSERT OR UPDATE, sale porque `contract_item_id` no
es NULL); `standardize_invoice_items` y `auto_populate_invoice_item_fields` son BEFORE INSERT. En el UPDATE del encabezado:
`auto_populate_invoice_fx_to_system` (recalcula los montos en moneda del sistema desde `amount_contract_currency`, deseado),
`auto_populate_invoice_tax_rate` (solo si `tax_rate` es NULL), `trg_rsm_on_invoice_change` (sale: Por Emitir no está en los
estados que afectan `billed_*`, por eso el rebuild es explícito) y `sync_invoice_items_on_invoice_update` (solo status/fecha).
**Actualizado 30-09 (costura construida, sin aplicar):** con la marca, `fx_to_system`, `tax_rate`, `sync_invoice_item_contract_id`,
`trg_rsm_on_invoice_change` y los BEFORE INSERT salen sin hacer nada; la API escribe los montos en moneda del sistema
(`refreshInvoiceSystemAmounts`) y las líneas nacen con `contract_item_id` (§4).

**Decisiones de Domi (28-09, spec §8)**: DTE una línea o una por tramo → configurable por precio (`invoice_line_mode`, pregunta 2);
factura emitida → dos caminos (`on_issued = additional | reissue`, pregunta 4); cargo fijo con todo gratis → configurable
(`charge_flat_when_free`, pregunta 5); `metered` + Anticipado prohibido salvo `seat` (pregunta 6, confirmado). **Supuestos
que siguen abiertos (Domi analiza)**: mínimo comprometido por período de la línea (pregunta 1); línea medida sin consumo =
cantidad base del ítem con advertencia (pregunta 3); `amount_override` = monto final menos descuento si aplica, sin
tramos ni mínimo/tope; `volume` toma el tramo por la cantidad total y tarifa la cantidad después de las gratis; lo
**medido** no se prorratea en un período parcial (el consumo ya es el del tramo; aviso); `contract_value` suma lo fijo y, en
lo medido, el mínimo por período; `standard` fijo con `price` se calcula como hoy; `last_sync_at` de la métrica = última entry `dwh`/`api`.

## 3. El generador v2 (una sola pieza)

Entradas: contrato (día de ciclo, agrupación, términos de pago, moneda y política FX de facturación, tipo de documento)
+ ítems. Reglas:

- **Períodos** desde el día de ciclo; `fin = siguiente inicio − 1 día`; período de la línea = período de servicio de su
  ítem, calculado en una sola función.
- **Frecuencias** de una tabla única (Bianual = 24, S4-11); Anticipado emite al inicio, Vencido al inicio del siguiente;
  la factura del mes M puede juntar anticipados de M con vencidos de M−1 (S3-13).
- **No recurrentes** una sola vez (U6).
- **Sin término** (S1-12 / M5, 29-09): un recurrente con `term_months` NULL y sin `end_date` es indefinido (el DTO lo acepta
  solo si es recurrente; un pago único siempre lleva plazo). **Supuesto**: el generador factura un horizonte de **12
  períodos** de la frecuencia del ítem desde su inicio (`INDEFINITE_HORIZON_PERIODS`), mide el valor del ítem sobre ese
  mismo horizonte (`price`/`final_price`, `total_value`) y devuelve `warning_codes: ['indefinite_horizon']` e
  `indefinite_until` (última fecha cubierta); la activación lo muestra ("Sin término · facturas generadas hasta …") y no
  bloquea. El ítem queda con `end_date` NULL y el contrato sin `contract_end_date`; `derived_status` ya trata el fin NULL
  como vigente. Generar los períodos siguientes (ampliar el horizonte) queda para un bloque posterior.
- **Montos**: cuota con 2 decimales y la diferencia en la última (S1-11); línea = cantidad × unitario × (1 − descuento)
  con precio de lista y descuento visibles, nunca `1 × total`; header = Σ líneas.
- **Prorrateo** (decisión de Domi 30-09, reemplaza el supuesto "sin prorrateo" de los ítems con modelo de precio; S4-16):
  el **día de ciclo** es el día del mes en que empiezan los períodos (default: día del inicio del primer ítem recurrente);
  no es la fecha de cierre ni el inicio del servicio. Si difiere del día de inicio del ítem, el **primer período** va del
  inicio al día anterior al siguiente día de ciclo y cobra `monto del período completo × meses cubiertos / meses de la
  frecuencia`, donde un mes parcial cuenta `días del tramo / días del mes de ciclo que lo contiene` (Mensual: 15 → 31 de
  enero con día de ciclo 1 = 17/31; Anual: el mismo tramo = 17/31 de un mes, es decir 1/12 × 17/31 del año). El fin sigue
  respetando plazo o `end_date`: si no cae en un fin de período, el **último** también es parcial y se prorratea igual.
  Aplica al estándar y a los modelos de precio con cantidad fija (subtotal y desglose × fracción); lo medido no se prorratea.
  Las líneas parciales llevan `prorated: true` y `prorated_days`, la advertencia "Primer período prorrateado: N días" (o
  "Último…") y el código `prorated_period`; el tramo inicial va en la factura del primer ciclo.
- **MRR de la vista previa** (30-09): `totals.mrr` = Σ `items[].monthly_equivalent` de los recurrentes; mensual equivalente =
  monto de un período completo ÷ meses de la frecuencia, con la cantidad del ítem (lo medido: la cantidad base) y su
  descuento (mínimo y tope incluidos). El formulario muestra este MRR y el valor del contrato del motor, no una estimación
  local. `contract_items.unit_price` de un ítem con modelo de precio se guarda de modo que `monthly_price = unitario ×
  cantidad × (1 − descuento)` sea ese mismo mensual (`equivalentMonthlyUnit`), así el MRR del 360 coincide con el de la
  vista previa.
- **Moneda**: misma moneda → FX 1 y montos llenos; con conversión → montos en moneda de factura NULL (se valorizan al
  emitir o con la tasa fija de la factura); nunca mixto, nunca clonado.
- **Fiscal**: tipo de documento del contrato (sugerido por país emisor vs receptor) → `document_type` + `export_type`
  coherentes; IVA desde la compañía y la regla del país (Colombia: 0 en Por Emitir, lo aplica Odoo).
- **Vencimiento** = emisión + términos de pago (México: emisión + 1 mes); nunca `+30` fijo.
- **Glosa** "PRODUCTO Cuenta X - Periodo dd/mm/aaaa a dd/mm/aaaa", solo guion `-`.
- **Agrupación**: juntas por mes de emisión o por ítem según el contrato; fusión solo con Por Emitir activas, no legacy,
  no unificadas ni NC.
- Escribe con `sapira.writer = 'api'` (standardize no pisa) y devuelve el preview idéntico a lo que persiste.

## 3b. Tipo de cambio (modelo FX v2, Domi 28-09)

- **Una sola regla para toda tasa guardada:** "1 [from] = rate [to]". Fila directa (`from` = moneda del contrato) → se
  **multiplica**; fila inversa (`from` = otra moneda, `to` = moneda del contrato) → `1 / rate`. La inversa queda solo por
  datos viejos: v2 escribe siempre contrato → otra moneda. Misma regla que `invoices.fx_contract_to_invoice` y
  `apply_fixed_fx_to_contract` (multiplican).
- **`contract_fx_period_rates.purpose`** (`company` | `invoice`, default `company`): la tabla guarda las tasas fijas de
  devengo en moneda de la compañía (`fx_company_policy = 'fixed_period'`) y las de facturación (`fx_invoice_policy =
  'fixed'`). Leen solo `company`: `revenue_schedule_apply_fx_for_contract` (rama `fixed_period`, ahora directa × tasa e
  inversa 1/tasa, igual que `monthly_avg`), `calculate_contract_fx_rate` y `bulk_confirm_fx_policy`. Lee solo `invoice`:
  la activación v2 (y la vista previa al crear, con las tasas del body).
- **`companies.fx_company_policy`**: política por defecto de la compañía para el devengo de contratos en otra moneda;
  hoy solo `monthly_avg`. **Un FX fijo se define solo por contrato** (`fixed_period` + tasas `company` propias): la
  política de la compañía nunca crece a `fixed_period`. El contrato la copia al crearse (`company_default`; en el
  wizard, "Usar la política de la compañía (promedio mensual)"). Se editará en Configuración del holding →
  configuración de las compañías cuando ese módulo migre (no ahora).
- **Al crear (C1)**: `invoice_currency` (default la del contrato); `fx_invoice_policy` obligatoria si difiere;
  `fx_invoice_rates[]` ≥ 1 si es `fixed`; `fx_company_policy` `company_default` | `fixed_period` (+ `fx_company_rates[]`)
  solo si la moneda del contrato ≠ la de la compañía. Una tasa sin fechas cubre el contrato; fin > inicio y sin solapes.
  Los `*_confirmed_at` quedan en `now()` cuando la política aplica. Todo en la transacción del borrador.
- **UF (CLF) nunca es moneda de facturación** (Domi 28-09): `invoice_currency = CLF` → 400 ("La UF no se factura…"). Un
  contrato en UF sin moneda de facturación se factura en CLP si la compañía es CLP; si no, es obligatoria. Al activar,
  un borrador viejo con moneda de facturación CLF (o en UF sin ella) → bloqueo `uf_invoice_currency`.
- **Al activar (C2)**: cada factura toma la tasa `invoice` que cubre el inicio de su período; si alguna no tiene →
  bloqueo `fixed_fx_without_rate`. Contrato viejo con `fx_company_policy` NULL y otra moneda → `fx_company_policy_missing`.
- **Corrección de datos**: las 5 tasas CLF → CLP de Hanka Robotics (0.000025, cargadas al revés y compensadas por la
  inversión vieja del RSM) pasan a 40.000 con la migración `1790610000001`, que exige el asset nuevo ya aplicado y
  reconstruye el RSM de esos contratos: el devengo no cambia. SimpliRoute CTR-2026-215 queda fuera (lo revisa Domi).
- **Orden de despliegue**: migración `1790610000000` → assets (3 funciones) → migración `1790610000001` → código.
  `fx.entities.spec` queda en rojo hasta aplicar en producción y refrescar el snapshot (GUIA).
- **Multimoneda (MM1–MM3, construido 01-10, sin aplicar; [`spec-multimoneda-contrato.md`](./spec-multimoneda-contrato.md))**: tres monedas
  (ítem, contrato, factura). Con `contracts.requires_multicurrency_billing` un ítem lleva su moneda (`contract_items.currency`, precio en la
  misma, 400 `price_currency_mismatch`). Tasas por **par y propósito** en `contract_fx_period_rates`: `invoice` = moneda del ítem → factura
  (`fx_invoice_rates[].from_currency`), `item` = moneda del ítem → contrato, fija y pactada (MRR, TCV, devengo; `fx_item_rates[]`). La regla
  "sin fechas = todo el contrato" se evalúa por `(propósito, from, to)`.
  - **Esquema**: migración `1790700000000-MulticurrencyContract` (CHECK `purpose` + `item` y comentario de columna; `down` se niega con
    tasas `item`). Assets: `validate_contract_item_currency_consistency` (ítem ≠ contrato solo con el flag), `validate_contract_currency_consistency`
    (con el flag permite; `true → false` con ítems en otra moneda → RAISE; bypass del borrador intacto), `change_contract_currency` (rechaza
    multimoneda), `revenue_schedule_rebuild_contract_ccy` (ítems en otra moneda × tasa `item` del mes con el asset nuevo
    `contract_item_fx_rate`; sin tasa, montos NULL y `calc_version = 'missing_fx_rate'`, nunca 1; **sin vueltas**: ítem en la moneda de la
    compañía o del sistema escribe esas columnas con su monto directo y `revenue_schedule_apply_fx_for_contract` no las recalcula). Orden:
    migración → 6 assets (+ `revenue_schedule_apply_fx_for_contract`) → código.
  - **Generador**: valorización **por línea** (`PreviewLine.currency`, `fx`, `fx_rate_source`, `amounts_invoice_currency`): mismo par → 1;
    fija → tasa del par al inicio del período de la línea; spot → NULL. Residuo por par a su línea mayor; IVA por línea en moneda de factura;
    encabezado en moneda de factura = Σ líneas o NULL si alguna es spot; `fx` del encabezado = la del único par convertidor, NULL con dos o
    más. Encabezado en moneda de contrato, `totals.contract_value`, `mrr` e `items[].monthly_equivalent` con la tasa `item` (los ítems traen
    además `currency`, `item_fx_rate`, `*_item_currency`). Pares sin tasa en `fx_missing`.
  - **Activación**: `currency_mismatch` solo sin el flag; bloqueos por par `item_fx_rate_missing` y `fixed_fx_without_rate` (con el par).
    Con política spot ya no bloquea (`multicurrency_spot_send_pending` quitado con MM4, 01-10). Cada línea nace con su moneda de ítem y su tasa.
  - **Envío al ERP (MM4, 01-10)**: `calculateInvoiceAmountsAtIssue` valoriza por par al emitir (spot del día de cada par, tasas fijadas por
    línea se respetan, falta una tasa → `fx_rate_missing` y no se envía; encabezado = Σ líneas). Cambio puntual en código de Leon,
    avisado en [`cambios-integracion-para-leon.md`](./cambios-integracion-para-leon.md) §4.
  - **Modificaciones**: tipo nuevo `multicurrency { enabled }` (eventos `MULTICURRENCY_ENABLED` / `MULTICURRENCY_DISABLED`; apagar con ítems
    en otra moneda → `foreign_currency_items_present`); `item_add.items[].currency` (desde cotización: la de la cotización),
    `fx_item_rates`, `fx_invoice_rates`, `enable_multicurrency` (sin flag → `multicurrency_not_enabled`); `billing_conditions` por par (400
    con el par sin tasa); ΔMRR, MRR y TCV convertidos; encabezados recalculados por par; NC espejo con la moneda y la tasa de cada línea
    original. Renovación: la extensión de las tasas por par queda para el bloque 2.
  - **360**: `POST …/invoices/:id/fx` y `fx-bulk` aceptan `rates_by_pair { 'USD>CLP': tasa }`; `net_exact` solo con un par (400
    `net_exact_multi_pair`). El detalle de factura expone por línea `currency`, `fx`, `fx_rate_source`; contrato y factura exponen
    `requires_multicurrency_billing` y `fx_item_rates`. Consumo: la línea recalculada conserva su moneda y su par.
  - **Operaciones sobre Por Emitir (cierre de brechas, 01-10)**: editor (una y masivo), presentación por tramo ↔ una fila, descuento puntual,
    reorganizar (todas las operaciones), facturar por OC, reemisión de la anulación y facturas nuevas de consumos (complementaria y
    reemisión) valorizan **cada línea con su par** con el mismo cálculo que el motor (`revalueByPair` en `multicurrency.ts` sobre
    `valuateLinesByPair`; encabezado = Σ líneas con `multicurrencyHeader`; FX del encabezado NULL con dos o más pares; spot → NULL). Tasa de
    la línea: la suya si conserva su moneda; si se mueve o nace, la fijada por factura para el par (`manual` / `net_exact`), si no la fija
    pactada del período, si no NULL. Persistencia común `revalueMulticurrencyInvoices` (`multicurrency-invoices.ts`): solo Por Emitir de
    contratos con el flag (sin el flag la edición no hace ninguna consulta extra), nunca unificadas ni facturadas por OC (su neto exacto
    manda). Facturar por OC en un documento con líneas en dos o más monedas → blocker `net_exact_multi_pair`; con una sola moneda la visible
    nace en ella y el saldo se revaloriza por par. La reemisión copia moneda y tasa **de cada línea** (como la NC espejo). La glosa (plantilla
    y regeneración de descripciones) toma la moneda y la tasa de la línea. Vista previa por par en editor, masivo y reorganizar; facturar por
    OC y las siguientes recompuestas por tramo se valorizan al aplicar.
  - **Consolidación opcional (MM5, §7) e historial unificado (§9), construido 01-10**: `GET /contracts/:id/invoices/:invoiceId/consolidation-candidates`,
    `POST /contracts/invoices/consolidations/preview`, `POST /contracts/invoices/consolidations` `{ invoice_ids[] (2–50), notes? }` y
    `POST /contracts/invoices/consolidations/:invoiceId/undo { reason }` (`contract-invoice-consolidation.service.ts` + `invoice-consolidation.ts`).
    Documento `Unificada` nuevo con **copias** de las líneas (prefijo `CTR-… - `, `contract_id` por línea, tasa por par; spot entero si una
    línea que convierte es spot), aporte por contrato y contrato principal = mayor aporte; orígenes `is_active = false` +
    `consolidated_into_invoice_id`; eventos `INVOICE_CONSOLIDATED` / `INVOICE_CONSOLIDATION_UNDONE` por contrato (texto libre, sin CHECK: la
    migración no cambia). Deshacer → consolidado `Cancelada`, orígenes reactivados. Listado y detalle de factura: `legacy_unified` y
    `contributions[]` en `Unificada`/`Consolidada` (legacy = sin evento `INVOICE_CONSOLIDATED`); todas las demás operaciones siguen
    bloqueando con `unified_invoice` (también el consolidado v2: se deshace y se vuelve a operar).

## 4. Triggers compartidos: qué se hace

**Regla (Domi 30-09):** la lógica de negocio vive en la API; Postgres conserva solo invariantes. Toda transacción v2 que escribe
fija `sapira.writer = 'api'` como primera sentencia (`setApiWriter`) y cada trigger legacy de la lista sale sin hacer nada; la API
escribe cada campo. El front viejo nunca fija la marca. Construido el 30-09, sin aplicar: lista exacta, orden `--only` y prueba en
QA en [`activacion-costura-triggers.md`](./activacion-costura-triggers.md) § Construido; regla en
[`logica-en-api-triggers.md`](../reglas-desarrollo/logica-en-api-triggers.md).

| Trigger | Qué hace hoy | v2 (con la marca) | Front viejo |
|---|---|---|---|
| `standardize_invoice_items` (BEFORE INSERT) | Pisa cantidad/unitario/subtotal de toda línea con ítem | No-op; **patrón B retirado**: la línea nace con `contract_item_id` | Igual |
| `trigger_generate_invoices_on_contract_signed` (unificado) | Genera facturas legacy al insertar o pasar a Firmado/Activo si no hay | No-op (v2 crea las facturas); el duplicado `generate_invoices_on_contract_active` se elimina por migración | Igual (ahora `SECURITY DEFINER`) |
| `auto_populate_invoice_item_fields`, `sync_invoice_item_contract_id` | Copian cabecera/producto; adivinan el ítem por descripción | No-op; la API escribe estado, fecha, producto, monedas e ítem | Igual |
| `set_contract_item_end_date`, `inherit_auto_renew_from_quote_item`, `trg_set_contract_item_categoria` | Fin, auto-renovación (pisa `false`), categoría | No-op; la API los manda explícitos | Igual (S1-5 diferido) |
| `auto_calculate_pricing_fields` (contract_items y quote_items) | Mensual, período, anual | No-op; `pricingFields()` en la API (regla del trigger salvo sus bugs: anual con descuento, pago único, monto fijo sin término; [`activacion-campos-api.md`](./activacion-campos-api.md)) | Igual |
| `update_contract_term` | `contracts.term = MAX(term_months)` | No-op; `syncContractTerm()` | Igual |
| `set_booking_date_on_activate`, `set_contract_company_currency`, `auto_calculate_contract_fx` | Booking al activar, moneda de compañía, FX a sistema del contrato | No-op; la activación los escribe (S2-7) y los cambios recalculan el FX con la condición del trigger | Igual |
| `auto_populate_invoice_tax_rate`, `auto_populate_invoice_fx_to_system`, `invoices_fill_terms_from_contract`, `assign_invoice_group_id` | IVA, montos a moneda del sistema, condiciones, grupo | No-op; la API escribe los cuatro (`refreshInvoiceSystemAmounts` tras cada INSERT/UPDATE) | Igual |
| `trigger_revenue_schedule_on_contract_activation`, `trigger_rsm_on_*` (ítems, facturas, cantidades) | Rebuild del RSM | No-op; rebuild explícito. **U9 aplicado en el asset**: holding de la fila | Se arregla para ambos (U9) |
| `trg_audit_contract_changes` | `contract_change_log` en contratos vigentes | No-op; el historial v2 es `contract_lifecycle_events` | Igual |
| `validate_fx_before_firmado` | Exige FX confirmado al pasar a Firmado | No-op; a retiro con doble confirmación | Igual |
| `sync_invoice_items_amounts_from_quantities` + restore | Sync de consumos, toca NC | **Fix compartido U13** (pendiente) | Se arregla para ambos |
| `revenue_schedule_rebuild_contract_ccy` | Rebuild parcial reinicia el acumulado | **Fix compartido U8** + rebuild completo (OK aparte) | Se arregla para ambos |
| **Invariantes**: `trg_00_period_guard_contracts` (+ ítems), `validate_contract_currency_trigger`, `validate_contract_item_currency_trigger`, `prevent_end_date_update_when_active` | Guard de período, monedas, fin de contrato activo | **Corren igual** (no leen la marca); el fin del contrato lo mueve la API con su bypass explícito y evento | Igual |

## 5. Se retira al switch de Contratos (anotado, no se toca antes)

`bulk_activate_contracts`, `mark_contract_signed_safe`, `generate_missing_invoices_for_contract` y los 2 triggers de
generación (si ningún otro camino los usa), `create_contract_cross_sell` + `approve_contract_amendment` +
`recalc_revenue_for_contract`, `apply_quote_downsell_to_contract`, `apply_contract_contraction`,
`create_contract_renewal` (+ cron `auto-renew-contract-items`, `process_auto_renewals`, `execute_auto_renewal_for_item`,
`get_items_pending_auto_renewal`; los reemplazan los jobs `contracts-auto-renewal` / `contracts-scheduled-changes` de la API, B2-4),
`sync_invoices_for_contract_item`, `invoice_reschedule_items`, `check_contract_item_continuity` (los reemplaza Reorganizar, F15),
`consolidate_invoices_simple` / `unconsolidate_invoices_simple` de un contrato (F15),
`regenerate_contract_invoices_from_items` / `_for_restructure`, `bulk_restructure_contract_start_dates`,
`change_contract_currency`, `change_contract_commercial_client`, `bulk_confirm_fx_policy`, `apply_fixed_fx_to_contract`,
`migrate…` ya retirada. Y los triggers de la costura, cuando nada escriba sin ella. Cada uno con la doble confirmación.

## 6. Esquema aditivo que pide Contratos v2

| Cambio | Para qué | Nota |
|---|---|---|
| `contracts.billing_anchor_day` (smallint) | Día de ciclo explícito (S3-16) | Backfill = día de `MIN(start_date)` de recurrentes (lo que hoy se deriva) |
| `contracts.payment_terms` (jsonb, misma forma que `client_entities.payment_terms`) | Vencimiento (S1-4, Medios #11) | Default desde la razón social |
| `contracts.document_type` | Tipo de documento del contrato (S1-7) | Deriva `export_type`; hoy es la **familia** derivada del documento del catálogo |
| `tax_document_types` (tabla) + `contracts.tax_document_type_id` | Documento tributario por país (33/34/110, 01, CFDI-I…) elegido en el alta (S1-7) | Migración `1790620000000` + seed 003; catálogo compartido, lectura para autenticados |
| `contracts.deleted_at` | Borrado lógico (S2-9) | |
| UNIQUE (compañía, número) | Correlativo (S1-1) | Antes resolver los 2 duplicados de prod (CTR-2026-200, 210): **dato, lo revisa Domi** |
| `invoices.fx_policy` (+ tasa por factura) | FX por factura (S6-1) | **No se crea** (Domi 29-09, sin duplicar): se deriva de `fx_contract_to_invoice` + monedas; origen en `invoice_items.fx_rate_source`; confirmación en el evento `INVOICE_FX_CHANGED` (F8b) |
| `billable_metrics`, `prices`, `consumption_entries`, `consumption_entry_revisions` (tablas) + `contract_items.price_id` + `invoice_items.pricing_breakdown` / `quantity_source` | Pricing v2 etapas 1 y 2 (§2f, [`spec-pricing-v2.md`](./spec-pricing-v2.md) §2) | Migración `1790630000000` + 4 policies RLS; única transición: `invoice_items_quantity_check` a `>= 0` |
| `contracts.invoice_description_template` (jsonb) + `invoice_items.description_locked` (bool, default false) + `tax_document_types.description_max_chars` (int) | Constructor de descripción (F9, spec facturas §3.6) | Migración `1790670000000` (sin aplicar; CL = 80 por UPDATE y seed 003). La API no se despliega antes de aplicarla |
| CHECK `invoice_adjustments_type_check` + `correction` · `invoice_items_quantity_source_check` + `manual` · `invoices_nc_revenue_treatment_check` + `service_period` | Editar una PE (F11–F13, spec facturas §3.4) | Migración `1790680000000` (sin aplicar; **sin columnas**: `plan_deviation`, `source` e `is_visible` no se crean) + asset `nc_discount_revenue_adjustment` (descuento puntual y `service_period`). Orden: migración → asset → API |
| `invoice_items.visible_line_id` (uuid NULL, FK a `invoice_items` ON DELETE SET NULL, índice parcial) | Facturar por OC (F18, spec facturas §3.7b) | Migración `1790690000000-InvoiceVisibleLine` (sin aplicar; única columna nueva de la etapa 6: `is_visible` sigue derivado = `quantity <> 0 AND visible_line_id IS NULL`). Orden: migración → API; el mapper de Odoo debe omitir las internas antes de enviar una factura por OC |
| CHECK `contract_fx_period_rates_purpose_check` + `item` | Multimoneda: tasa pactada ítem → contrato (spec multimoneda §3) | Migración `1790700000000-MulticurrencyContract` (sin aplicar; sin columnas nuevas) + assets de validadores, `change_contract_currency`, RSM y `contract_item_fx_rate`. Orden: migración → assets → API |

## 7. Decisiones para Domi (y Leon)

1. ✅ Domi 30-09 — **Costura `sapira.writer`** (§1.3 y §4): lógica de negocio en la API, triggers solo invariantes; toda
   transacción v2 fija la marca. Construida (API + 23 assets + U9 + generación unificada), sin commit y sin aplicar; el REVOKE de
   `generate_missing_invoices_for_contract` espera OK (el front viejo la llama por rpc). Ver
   [`activacion-costura-triggers.md`](./activacion-costura-triggers.md) § Construido.
2. ✅ Domi 25-09: **las facturas nacen al activar** y el cronograma (`contract_invoices`) es solo la **vista previa
   antes de activar**: v2 no lo escribe (la vista previa sale del generador en memoria). Después de activar mandan las
   facturas (`invoices`). Lectores de `contract_invoices` post-activación en el front viejo: solo el panel de vendedores
   (`useVendedorAnalytics`, Medios #9, ya cuestionado) y el detalle viejo; en v2 esos reportes leen `invoices`.
   El 360 v2 nunca llama "cronograma" a las facturas reales ("Facturas por período").
3. ✅ Domi 25-09: editar borrador (F2) entra en v2; **Reestructurar no se descarta**: se decide al construir, viéndolo
   (puede delegar en las funciones actuales o reemplazarse por F2/F3). → **Decidido 29-09 y construido 30-09**: se reemplaza por Reorganizar (F15)
   + Editar borrador (F11).
4. **Alcance del lunes** (columna "Lunes"): Contratos = L1–L3, C1, C2, C5, F1, F2, F4, M1, M2; M3 si alcanza. Lo
   demás, después del switch o con enlace temporal al front viejo solo si no corrompe datos v2.
5. AGENTS.md dice que Facturación operativa vive en Vite; si Facturas entra el lunes, se actualiza esa regla.
