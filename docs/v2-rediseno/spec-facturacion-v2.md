# Spec · Facturación v2 (vista operativa por holding · `/lab/facturacion`)

> 01-10-2026 · Domi + Claude (sesión de spec, solo lectura: sin código, sin base, sin git). Estado: **borrador para Domi**.
> Siguiente módulo después de Contratos y Revenue/Métricas. Misma forma que [`spec-revenue-y-metricas.md`](./spec-revenue-y-metricas.md) y
> [`spec-facturas-en-contrato-360.md`](./spec-facturas-en-contrato-360.md) (etapas 1–6 construidas por contrato).
> Fuentes: front-sapira `AGENTS.md`; [`ROADMAP-V2.md`](../../ROADMAP-V2.md) (el `00-plan-y-metodo.md` que cita AGENTS.md ya no existe: se
> fusionó en el roadmap el 21-09); [`spec-multimoneda-contrato.md`](./spec-multimoneda-contrato.md) §4/§7/§9;
> [`spec-modificaciones-contrato-v2.md`](./spec-modificaciones-contrato-v2.md) §9; [`cobertura-contratos-v2.md`](./cobertura-contratos-v2.md);
> [`mapa-v2-contratos.md`](./mapa-v2-contratos.md) F1–F18; [`cambios-integracion-para-leon.md`](./cambios-integracion-para-leon.md);
> [`auditoria-contratos.md`](./auditoria-contratos.md) S4/S4b/S6; [`plan-coexistencia-funciones.md`](./plan-coexistencia-funciones.md) §2c;
> front viejo `sapira-ai/src/pages/Facturacion.tsx` + `src/components/facturacion/**` (61 archivos, ~16,5 k líneas); API `src/modules/{invoices,
> contracts,odoo,sii,factura}`; entities `src/databases/postgresql/entities/facturacion/*`; Next `app/(protected)/admin/empresas-sii/**`,
> `app/api/{factura,sii}/**`, `lib/app-links.ts`. Conteos de producción: los de la auditoría (no se consultó la base en esta sesión).

## 0. Punto de partida en v2 (lo que ya existe)

**Por contrato (módulo `contracts`, tras `SupabaseAuthGuard` + `HoldingScopeGuard` + `@HoldingId()`; `contracts.controller.ts:729-1499`)**
| Pieza | Archivo : función | Qué hace |
|---|---|---|
| Lista y detalle | `contracts.service.ts` (`GET :id/invoices`, `GET :id/invoices/:invoiceId`) + `contract-360.ts:368-406` | Paginado por contrato con conteos por estado, bloqueos (`needs_reference`, `fixed_fx_without_rate`, `no_erp_partner`, `item_without_product`, `past_issue_date`), `erp_sync_state`, `erp_reset_available`, `plan_deviation`, `voided`, `related_documents[]`, `legacy_unified`, `contributions[]`, `history[]` |
| Enviar al ERP ahora | `contract-invoices.service.ts` → `InvoiceSchedulerService.sendInvoiceById` (`POST :id/invoices/:invoiceId/send-now[/preview]`) | Bloqueos de F6 (`already_sent`, `erp_send_disabled`, `no_erp_integration`, `no_erp_partner`, `needs_reference`, `item_without_product`, `fixed_fx_without_rate`, `fx_rate_missing`, `tax_rate_missing`, `not_pending`, `credit_note_send_pending`) |
| Registrar emisión externa | idem (`…/mark-issued[/preview]`) | Folio + fecha obligatorios; solo registra (no reescribe líneas valorizadas; `fx_mismatch`) |
| Reprogramar | `…/:invoiceId/reschedule[/preview]`, `…/reschedule-bulk[/preview]` | Conserva `original_issue_date`, vencimiento por condición de pago, evento |
| Tipo de cambio | `…/:invoiceId/fx[/preview]`, `…/fx-bulk[/preview]` | spot / fixed / net_exact por factura y por par (`rates_by_pair`) |
| Editar borrador · desvíos · masivo de encabezado | `contract-invoice-edit.service.ts`, `invoice-edit.ts` (`PUT …/:invoiceId`, `…/edit/preview`, `…/deviation`, `GET …/deviations`, `…/bulk-edit[/preview]`) | Conciliador plan ↔ factura, motivo en `invoice_adjustments`, sin cobro (`INVOICE_NO_CHARGE`) |
| Restablecer borrador del ERP | `…/:invoiceId/erp-reset`, `…/invoices/erp-reset` (masivo ≤200) | Limpia vínculo Odoo + `spot_reset`; aviso `erp_draft_remains` |
| Reorganizar | `contract-invoice-reorganize.service.ts` (`…/reorganize[/preview]`, `GET …/schedule-lines`) | merge / move_line / split_line |
| Descripción y OC/HES | `contract-invoice-descriptions.service.ts`, `invoice-description.ts`; `PUT …/:invoiceId/references` | Plantilla, `description_locked`, referencias |
| Facturar por OC | `contract-invoice-partial-po.service.ts` (`…/partial-by-po[/preview]`) | Línea visible ↔ internas (`visible_line_id`) |
| Anular/reemitir · NC de descuento | `contract-invoice-void.service.ts`, `invoice-void.ts` (`…/void[/preview]`, `…/credit-note[/preview]`) | NC espejo (`insertMirrorCreditNote`, siempre `Emitida`, sin `due_date`, fila en `invoice_references` con código SII 1/3); original → `Cancelada` |
| Consolidación (socio) | `contract-invoice-consolidation.service.ts`, `invoice-consolidation*.ts` (`GET …/consolidation-candidates`, `POST /contracts/invoices/consolidations[/preview]`, `…/:invoiceId/undo`) | Entre contratos, mismo receptor/moneda/mes/documento; legacy de solo lectura |
| Multimoneda por línea | `multicurrency-invoices.ts` (`revalueByPair`, `valuateLinesByPair`), `consumption.ts` (`headerFromLines`) | Encabezado = Σ líneas, nunca mixto |

**Módulo `invoices` (Leon)**: `invoice-scheduler.service.ts` (`getInvoicesToSend`, `sendInvoiceToOdoo`, `sendInvoiceById`,
`mapInvoiceToOdooFormat`, `calculateInvoiceAmountsAtIssue` / `calculatePairAmountsAtIssue`, `NON_SENDABLE_DOCUMENT_TYPES`), cron horario
`invoice-scheduler.scheduler.ts:33`, `POST /invoices/scheduler/send`, `GET /invoices/scheduler/{status,jobs,job/:jobId,report,debug-*}`;
`invoices.controller.ts`: `POST /invoices/bulk-update-currency` (sin holding, S6: no se usa en v2), `PATCH /invoices/:id/auto-invoice`,
`PATCH /invoices/contract/:contractId/bulk-auto-invoice`, `GET /invoices/odoo-sended-logs[/export]` (CSV; logs en Mongo). Ese controlador
solo tiene `SupabaseAuthGuard` (lee `x-holding-id` crudo, sin `HoldingScopeGuard`). Tras crear en Odoo y emitir, `sendInvoiceById` deja la
factura en **`Emitida`** con cualquier `electronic_status` de Odoo (`accepted`, `rejected`, `not_required`, `sent`; `rejected` solo se informa
como error y **no se guarda**: no hay columna de estado electrónico). `odoo-webhook.service.ts` (`determineInvoiceStatus`): `posted + not_paid →
Enviada`, cualquier otro `payment_state` → `Pagada`. Lecturas cercanas: `GET clients/:id/invoices` y `client-entities/:id/invoices`
(`client-metrics.service.ts`, `OPEN_INVOICE_STATUSES = ['Emitida','Enviada','Vencida']`, sin Por Emitir); no hay lista por holding, KPIs
de facturas, export de facturas ni job de recordatorios (las tablas `invoice_emails` / `invoice_collection_*` solo se leen en
`client-activity.service.ts`). Catálogo fiscal: `tax_document_types` (`country_code, code, name, kind invoice|export_invoice|credit_note|
debit_note|receipt, is_electronic, description_max_chars`).
**SII/DTE (Leon)**: `sii.controller.ts` (`GET /sii/companies`, `POST /sii/companies/:companyId/factura-integration`; certificado, CAF, folios y
configuración están **deprecados** aquí porque viven en api-factura; entities `sii_configurations`, `sii_certificates`, `sii_cafs`); servicio externo de emisión (`FACTURA_API_URL`) consumido desde Next por `app/api/factura/**` (`dte`, `dte/create`,
`dte/send`, `dte/:id/{estado,pdf,xml}`, `caf`, `folios`, `certificates`, `dte-types`) con `X-Factura-Company-Id`. **No hay vínculo
`invoices` ↔ DTE** en la base: la emisión electrónica nativa todavía no lee facturas de Sapira. Sin SUNAT ni CFDI nativos (PE y MX salen por Odoo).
**Front nuevo**: `ContratoFacturasTab.tsx` (DataTable + `DataTableBulkBar`: *Reprogramar · Tipo de cambio · Enviar al ERP · Restablecer
borrador*), `detalle/FacturaVistaRapidaDrawer.tsx` (`FacturaAcciones`, Referencias, Líneas, Consumo; recibe `contratoId`),
`detalle/facturas/**` (diálogos de acción, edición, nc-oc, reorganizar, consolidación, proforma), `nuevo/FacturasPreview.tsx`,
`components/data-table/*`, `metricas/components/shared/StickyToolbar`, `components/agents/{AgentLauncher,InsightsSheet}`.

## 1. Inventario del front viejo (`sapira-ai` › `/facturacion`)

Lecturas: todo `.from()` directo (`invoices` 35, `revenue_schedule_monthly` 19, `invoice_items` 13, `bank_movements` 9, `invoice_payments` 8,
`invoice_references` 6…) y RPC (`emit_invoice_manually`, `emit_invoice_safe`, `create_credit_note_safe`, `edit_pending_invoice`,
`reschedule_invoice_safe`, `unify_invoices_multi_contract`, `unconsolidate_invoices_simple`, `get_next_invoice_number`, `get_cutoff_date`,
`reopen_period_from`); edge functions `send-proforma`, `send-collection`. Sin paginación de servidor en KPIs (corte 1.000 filas).

| Pantalla / pieza | Qué hace | Dato y de dónde | Veredicto | Bugs vistos |
|---|---|---|---|---|
| Pestañas (`pages/Facturacion.tsx:170-199`) | Facturas · Facturas Legacy · Conciliación bancaria · Cuentas por cobrar | — | **Mejorado**: Facturas · Por emitir · Cobranza · Notas de crédito; Legacy y Conciliación fuera (§2) | — |
| KPIs (`FacturacionKPIs.tsx`, `KPIsPeriodFilter.tsx`) | Total facturado, subtotal, pagado, pendiente por facturar, CxC, CxC vencidas | `.from('invoices')` sumado en navegador | **Mejorado** (§4.1): por moneda/sistema, NC neteadas, endpoint | Suma monedas distintas; NC y Canceladas mezcladas; corte 1.000 |
| Lista (`FacturasList*.tsx`, `facturasFilters.ts`, `useFacturacionDataWithPeriod.ts`) | Tabla + calendario, ~16 filtros avanzados y presets (Vencidas, Pendientes de emisión, Pagadas este mes, Exportación, NC, Suscripciones), vistas guardadas, export | `invoices` + joins, realtime que recarga todo | **Mejorado**: DataTable paginada en servidor; se conservan filtros y presets útiles | Corte 1.000 (`max_rows`); filtro `currency` roto; paginación siempre deshabilitada; `toISOString()` |
| Menú por fila (`FacturasListTable.tsx:363-372`) | Ver · Enviar proforma · Emitir · Reagendar · Registrar pago · Cobranza · NC · **Duplicar** · Cancelar · **Eliminar** | RPC + UPDATE/DELETE directos | Ver/Emitir/Reagendar/NC → **vista rápida reutilizada**; Proforma, Pago, Cobranza → **se portan**; Duplicar y Eliminar → **se eliminan** (S4: sin trazabilidad); Cancelar PE → sin cobro / Terminar (contrato) | Duplicar en cualquier estado; DELETE físico |
| Emitir (`InvoiceEmitModal.tsx`, `useInvoiceManualEmission.ts`) | Emisión manual con folio (`get_next_invoice_number`) y **división** | `emit_invoice_manually`, `emit_invoice_safe` | **Reemplazado** por `mark-issued` (S4-14: sin división) | División copia moneda de factura a moneda de contrato |
| Masivos (`InvoiceBulkActions.tsx`, 1.253 l.) | emit · payment · references · descriptions · collection · unify/ununify | `bulk_emit_*` (marca "Enviada" sin enviar), INSERT directos | emit/references/descriptions → **endpoints del contrato por lote**; payment, collection → **se portan**; unify → **se elimina** (multimoneda + consolidación v2) | `bulk_emit` marca Enviada sin ERP; unificar pierde OC/HES |
| Ver factura (`InvoiceViewModal.tsx`, `InvoiceRelatedDocsSection.tsx`, `InvoiceReferencesSection.tsx`) | Detalle, referencias editables, documentos relacionados | `.from()` | **Reemplazado** por `FacturaVistaRapidaDrawer` | Referencias INSERT/DELETE sin evento |
| Crear/editar (`InvoiceFormModal.tsx`, `InvoiceEditModal.tsx`, `useInvoiceForm.ts`) | Factura manual suelta; editar PE | INSERT directo; `edit_pending_invoice` (0 usos) | **Se elimina** factura suelta (Q1); editar = editor del 360 | Sin contrato ni devengo |
| Ajustar a lo emitido (`InvoiceAdjustModal.tsx`) | Cuadrar con el ERP | `adjust_issued_invoice` (0 usos) | **Se elimina** (360 §8, decisión 30-09) | — |
| NC (`CreditNoteModal.tsx`) | Anular o descontar | `create_credit_note_safe` (112 NC) | **Reemplazado** por `void` / `credit-note` del contrato | IVA en moneda de contrato; `p_nc_fx_rate` invertida; NC "Vencida" |
| Unificar (`UnifyInvoicesModal.tsx`) | Unir contratos | `unify_invoices_multi_contract` (14, SimpliRoute) | **Se elimina**; histórico de solo lectura | U3 ($0 en Odoo) |
| Reagendar (`InvoiceRescheduleModal.tsx`, `InvoiceRescheduleHistory.tsx`) | Mover fecha + historial | `reschedule_invoice_safe`, `invoice_reschedules` | **Reutilizado** (`reschedule`); historial = eventos | Vencimiento ≤ emisión |
| FX (`FxPreviewModal.tsx`, `useExchangeRate.ts`) | Vista previa de tasa | `exchange_rates` | **Reutilizado** (`fx` del contrato) | — |
| Proforma (`InvoiceProformaModal.tsx`) | Correo con proforma | `send-proforma`, `invoice_emails` (`template = proforma`) | **Se porta** a la API (§5) reutilizando `ProformaDialog` del lab | Edge function con service role |
| Pago (`PaymentModal.tsx`, `BulkPaymentModal.tsx`, `paymentService.ts`, `PaymentHistoryPanel.tsx`) | Registrar pago(s), parciales | `invoice_payments` → trigger `after_invoice_payment_change` → `recalc_invoice_status` | **Se porta** (endpoint) | §9 B-F3/B-F4 |
| Cobranza (`CollectionModal.tsx`) | Correo de cobro | `send-collection`, `invoice_collection_logs`, `invoice_collection_settings` | **Se porta** (§4.5) | Plantillas sin variables validadas |
| Cuentas por cobrar (`reports/ARAgingReport.tsx`) | Antigüedad 0 · 1-30 · 31-60 · 61-90 · 90+ por cliente | `.from()` en navegador | **Mejorado** (endpoint, por moneda) | Suma monedas; sin `due_date` cuenta como vencida |
| Calendario por cliente (`InvoicesCalendarByClient.tsx`) | Facturas por mes × cliente | `.from()` | **Mejorado** como vista "Calendario" de Por emitir (F5) | — |
| Conciliación bancaria (`conciliacion/**`, `ConciliacionBancaria.tsx`) | Cartola, mapeo de columnas, match | `bank_movements`, `bank_upload_batches`, `bank_column_mappings` | **Fuera** (Q4) | Motor en navegador |
| Facturas Legacy (`tabs/FacturasLegacyTab.tsx`, `LegacyInvoiceDetailModal.tsx`) | Importadas históricas | `invoices_legacy`, `invoice_items_legacy` | **Fuera**: solo lectura en app vieja hasta la migración de datos | — |
| Cierre de período | Reabrir | `get_cutoff_date`, `reopen_period_from` | **Fuera** (Configuración) | — |

## 2. Alcance v2 y lo que NO entra

**Entra** (todo por BFF `app/api/facturacion/*` → `api-sapira`; Supabase solo auth; holding demo Hanka hasta producción):
1. **Lista por holding** de todas las facturas y NC (paginada, filtros, KPIs, vistas guardadas, export XLSX).
2. **Por emitir** (cola de trabajo): PE del período con bloqueos calculados y acciones por lote.
3. **Vista rápida reutilizada** (la de Contrato 360) como único lugar de una factura.
4. **Notas de crédito**: lista (siempre ligadas a su factura), con estado de emisión electrónica.
5. **Cobranza**: pagos (registrar, parcial, masivo, anular registro), antigüedad AR, vencidas.
6. **Recordatorios**: proforma y correo de cobro manual; recordatorios automáticos por holding (`invoice_collection_settings`).
7. **Estado ERP** (Odoo) y **estado de emisión electrónica** como columnas/filtros derivados.
8. **Insights** (agente) con el contexto de la vista.

**No entra (y por qué)**:
| Fuera | Por qué |
|---|---|
| Crear factura suelta, duplicar, eliminar PE | Toda factura nace de un contrato (S4-2, "no NC sueltas" 30-09); duplicar/eliminar = agujero de trazabilidad |
| Editar/reorganizar/OC/FX/descripciones en Facturación | Single path: viven en el contrato y se abren desde la vista rápida |
| "Modificar facturación" (condiciones, receptor del contrato) | Vive en el contrato (`billing_conditions`, `change_entity`) |
| Unificar / desunificar | Reemplazado por multimoneda + consolidación v2 (360) |
| NC/ND sin factura, ND | Decisión 30-09; ND espera la matriz fiscal (S4-9) |
| Emisión electrónica nativa (DTE desde `invoices`), NC a Odoo como `out_refund`, Retirar del ERP por API | Integraciones de **Leon** (S4-8, #22, Decisión 2): Facturación solo muestra el estado y el pendiente |
| Conciliación bancaria y estado de pago desde Odoo más allá del webhook | Carril León / estratégico (ROADMAP #7); Q4 |
| Facturas Legacy (`invoices_legacy`), suscripciones Stripe como emisor | Datos históricos / otro origen: solo lectura en app vieja |
| Cierre/reapertura de períodos | Configuración |

## 3. Modelo y estados (como existen en datos)

**Estado (`invoices.status`, CHECK)**: `Por Emitir · Emitida · Enviada · Pagada · Vencida · Cancelada · Consolidada · Dividida`.
`Unificada` **no es estado**: es `invoice_type` (`Manual · Automatica · Consolidada · Importada · Suscripción · Unificada`); los orígenes
consolidados quedan `is_active = false` con `consolidated_into_invoice_id`.

| Estado | Cómo se llega hoy (quién escribe) | Sale hacia |
|---|---|---|
| Por Emitir | Generador v2 (activación, modificaciones, horizonte, reemisión, consumo) | Enviada (Odoo `posted`), Emitida (`mark-issued`), Cancelada (sin cobro, terminar, consolidación deshecha) |
| Emitida | `mark-issued` (sin ERP: **camino principal**, 2 de 3 clientes sin ERP, S4-14); envío a Odoo con emisión (`sendInvoiceById`, incluso `rejected`); toda NC de la API | Enviada (webhook `posted`), Pagada / Vencida (`recalc_invoice_status`), Cancelada (anulada) |
| Enviada | Webhook Odoo `posted + not_paid` (contabilizada en el ERP) | Pagada (webhook o pagos), Vencida (`mark_overdue_invoices`, solo desde Enviada) |
| Pagada | Webhook (cualquier `payment_state` ≠ `not_paid`) o Σ pagos confirmados ≥ total | — (se revierte solo si se anula un pago: Q3) |
| Vencida | `mark_overdue_invoices` (Enviada, no NC, `due_date < hoy`); `recalc_invoice_status` (desde Emitida/Enviada con pago parcial) | Pagada |
| Cancelada | Anular (original), sin cobro (`INVOICE_NO_CHARGE`), consolidado deshecho, legacy | — |
| Consolidada / Dividida | Legacy (consolidar 1 contrato, división) | Solo lectura |

**Lecturas derivadas que expone la API (sin columnas nuevas)**:
- `document_kind`: `invoice` (`FACTURA`, `FACTURA_EXPORTACION`, `Invoice`, NULL) · `credit_note` (`NC`) · `debit_note` (`ND`); NC con `credit_type`
  (`cancellation` · `discount`) y `credit_reason`. Tipo fiscal visible = `document_type` (fuente única S4-7) + `export_type`.
- `erp_state`: el `erp_sync_state` del 360 tal cual (`none` · `draft` = vínculo y Por Emitir · `sent` = vínculo y emitida) + `not_applicable`
  (compañía sin `odoo_integration_id`, razón sin `odoo_partner_id`, o NC/ND hasta Leon). Se reutiliza la función del 360.
- `electronic_state` (emisión legal): `pending_emission` (NC/ND: `electronic_emission_pending` / `electronicEmissionOf` del 360; PE con
  `auto_invoice` y fecha vencida sin enviar) · `issued_erp` (folio vía Odoo: CL SII, PE SUNAT, MX CFDI los timbra Odoo; el resultado
  `accepted/rejected` de Odoo hoy no se persiste: B-F12) · `issued_external` (evento `INVOICE_ISSUED_EXTERNALLY`) · `not_issued`
  (Por Emitir) · `voided` (anulada por NC). Sin estados SII/SUNAT/CFDI propios hasta que exista el vínculo invoice ↔ DTE (Leon, §11).
- `payment_state`: `unpaid` · `partial` (0 < Σ pagos confirmados < total) · `paid` · `overdue` (no pagada y `due_date < hoy`) · `n/a` (Por Emitir,
  Cancelada, NC). Calculado de `invoice_payments` (`confirmed = true`), **no** del `status` (que no tiene "parcial").
- `blocked_reasons[]` de Por Emitir: los de `contract-360.ts` + los de `send-now` (§5.3).
- `voided`, `related_documents[]`, `legacy_unified`, `plan_deviation`: los del 360, en lote.

## 4. Vistas y flujos (`/lab/facturacion`, tema claro, `components/ui`)

### 4.1 Facturas (lista por holding) — por defecto: mes en curso por fecha de emisión, todas menos Canceladas
- **Barra fija** (`StickyToolbar`): rango de meses (`YYYY-MM`) por *emisión* o *vencimiento* · compañía · moneda de lectura (sistema/compañía,
  regla 1.1 de Revenue) · búsqueda (folio, cliente, contrato) · filtros en panel lateral: estado, `document_kind`, `erp_state`, `electronic_state`,
  `payment_state`, cliente, razón social, contrato, moneda de factura, con bloqueo, con desvío sin motivo, consolidada/unificada.
- **KPIs** (cada uno con "¿cómo se calcula?"): Facturado del período (emitidas activas − NC, por moneda de factura y total en sistema) ·
  Por emitir (monto y n°; con bloqueo) · Por cobrar (emitidas no pagadas − pagos parciales) · Vencido (monto, n°, días promedio) · Cobrado del
  período · NC pendientes de emisión electrónica. Totales en moneda de sistema con `unconverted` aparte (sin `amount_system_currency` → no suma).
- **Tabla** (`DataTable`, paginada en servidor, columnas elegibles, vistas guardadas como `ContratosVistasMenu`, estado en URL): folio, documento,
  cliente/razón social, contrato (link al 360), compañía, emisión, vencimiento, estado, ERP, emisión electrónica, pago, moneda/TC, total, saldo,
  chips (bloqueo, desvío, NC, consolidada, OC). Clic → **vista rápida**.

### 4.2 Por emitir (cola de trabajo)
Lista de PE activas con `COALESCE(issue_date, scheduled_at)` en el rango (default: hasta fin de mes) agrupada en **Listas** (sin bloqueos) /
**Con bloqueo** (agrupadas por código, con la acción que lo resuelve) / **Rezagadas** (emisión < hoy; S6 propuesta 6) / **En el ERP como borrador**.
Bloqueos (§5.3): `needs_reference` (OC/HES) → Referencias; `fixed_fx_without_rate` / `fx_rate_missing` → Tipo de cambio; `period_closed` →
Reprogramar; `sent_to_erp_draft` → Restablecer; `no_erp_partner`, `item_without_product`, `tax_rate_missing` → enlace a Configuración/Clientes.
Acciones por lote = §4.7. Vista "Calendario" (mes × cliente) del viejo como alternativa de lectura (F5). **Construido (01-10):** dos vistas
**Lista · Calendario** (`?vista=calendario`); el calendario es la misma cola (`GET /billing/to-issue?until=<fin del mes «Hasta»>`, sin API nueva)
en la grilla del mes por fecha de emisión, solo lectura: clic en un día lista sus facturas (fila → vista rápida); las de meses anteriores van
aparte. Los conteos por grupo y los motivos de bloqueo son chips que acotan la cola (`group`, `blocker_code`; en la URL `grupo`, `motivo`) y un
bloqueo en la fila filtra por su motivo; los conteos siguen siendo los de toda la cola.

### 4.3 Vista rápida reutilizada (single path)
`FacturaVistaRapidaDrawer` con `contratoId = row.contract_id` (cada fila lo trae): mismas acciones por estado que en el 360 (Enviar al ERP ahora,
Registrar emisión externa, Editar borrador, Reprogramar, Tipo de cambio, Referencias, Facturar por OC, Restablecer, Anular/reemitir, NC de
descuento, Consolidar) y mismas mutaciones (`app/api/contratos/[id]/facturas/*`). Facturación **agrega** dos secciones: **Pagos** (lista,
registrar, anular registro) y **Correos** (proforma, cobro, recordatorios enviados). "Ver en Facturación" se oculta cuando ya se está en
Facturación; aparece "Abrir contrato". Tras cada acción se invalida la query de la lista de Facturación y la del contrato.
**Pendiente de OK (01-10):** el drawer no expone prop para ocultar "Ver en Facturación" (apunta a la app actual vía `facturacionHref`); el cambio
de una línea en Contratos está descrito en `front-sapira/app/(protected)/lab/facturacion/README.md` y no se aplicó.
**Enlace profundo:** `/lab/facturacion?invoice=<id>[&tab=]` abre la vista rápida de esa factura (`GET /billing/invoices/:invoiceId`); abrir o
cerrar la vista rápida mantiene `invoice` en la URL. Helper `facturaHref` (índice del lab e Insights).

### 4.4 Notas de crédito
Lista de `document_type = 'NC'` (y ND históricas) con factura acreditada (folio, link a su vista rápida), contrato, `credit_type`/`credit_reason`,
`nc_revenue_treatment`, total, `electronic_state`. Sin "Nueva NC": se crea desde la factura (anular o NC de descuento, en la vista rápida). Las
NC pendientes de emisión electrónica se cuentan en un aviso: "N notas de crédito esperan la emisión hacia el ERP (Leon)".

### 4.5 Cobranza
- **Antigüedad AR** por cliente y moneda: no vencido · 1-30 · 31-60 · 61-90 · 90+ (sin `due_date` = columna "Sin vencimiento", no vencida).
- **Registrar pago** (una o varias facturas del mismo cliente y moneda): monto, fecha, método, referencia; parcial permitido; excedente bloquea
  (`overpayment`). Pago en otra moneda → 400 `payment_currency_mismatch` (v1; ver Q3).
- **Anular registro de pago** (no DELETE): `confirmed = false` + evento; recalcula estado.
- **Correo de cobro** (una o lote): destinatarios desde `client_contacts` de la razón social, plantilla del holding, vista previa, log en
  `invoice_collection_logs`.

### 4.6 Recordatorios
Configuración por holding (`invoice_collection_settings`: `dunning_enabled`, `reminder_days_before[]`, `reminder_days_after[]`, plantillas) y
**job** diario de la API (no edge function) que envía y registra en `invoice_collection_logs` (`channel = email`, `metadata.kind = reminder`).
Apagado por defecto (Q5). Proforma: envío manual desde la vista rápida (`invoice_emails`, `template = proforma`).

### 4.7 Acciones masivas (barra `DataTableBulkBar`, resultado por fila con `ResultadoMasivo`)
*Reprogramar · Tipo de cambio · Enviar al ERP · Restablecer borrador* (las mismas del 360, ahora **entre contratos**: la BFF/API agrupa por
`contract_id` y llama al endpoint por contrato), más *Registrar emisión externa* (solo fila a fila: folio obligatorio), *Registrar pago*
(mismo cliente/moneda), *Enviar correo de cobro*, *Exportar selección*. Nada masivo edita líneas.

### 4.8 Exportación
XLSX (encabezados, o encabezados + líneas) de la vista filtrada, generado en la API (streaming, sin corte); mismo patrón que
`use-export-detalle.ts` de Revenue. Se mantiene `GET /invoices/odoo-sended-logs/export` como reporte de envíos.

## 5. API (módulo nuevo `billing` en `api-sapira`; BFF `front-sapira/app/api/facturacion/*`)

Guards `SupabaseAuthGuard` + `HoldingScopeGuard`, `@HoldingId()` (nunca `holding_id` en query/body). Paginado `{ data, total, items,
currentPage, pages, limit }` (`items` = `total`, compatibilidad con la casa; la BFF lo pasa tal cual por `lib/api/pagination.ts`).
**Construido el 01-10 (sin commit, sin aplicar): formas exactas, códigos y brechas en [`mapa-v2-facturacion.md`](./mapa-v2-facturacion.md) §3–§7.** Errores `message`
+ `errors[{ field, message }]`; bloqueos 409 `{ code: 'blocked', blockers[], preview? }`. SQL con `DataSource.query` y filtros comunes
(patrón `metrics`); lógica de lectura reutiliza `contract-360.ts` (bloqueos, `erp_sync_state`), `invoice-consolidation-read.ts` y `voidedSql`.

### 5.1 Nuevos GET (forma final)
| Ruta | Query | Respuesta |
|---|---|---|
| `GET /billing/invoices` | `from,to` (`YYYY-MM`), `date_field=issue\|due`, `status`, `document_kind`, `erp_state`, `electronic_state`, `payment_state`, `company_id`, `client_id`, `client_entity_id`, `contract_id`, `invoice_currency` (listas por coma), `blocked`, `deviation_unexplained`, `include_cancelled`, `include_inactive`, `q`, `sortBy`, `sortOrder`, `page`, `limit≤200` | paginado; fila `{ id, contract_id, contract_number, client_id, client_name, client_entity_id, client_entity_name, company_id, company_name, invoice_number, document_type, document_kind, export_type, credit_type, credit_reason, nc_revenue_treatment, invoice_type, invoice_series, status, issue_date, scheduled_at, due_date, contract_currency, invoice_currency, fx_contract_to_invoice, amount_contract_currency, amount_invoice_currency, vat, total_invoice_currency, total_system_currency, paid_amount, balance, payment_state, is_overdue, days_overdue, erp_state, electronic_state, plan_deviation, voided, issued_externally, related_invoice_id, related_invoice_number, consolidated_into_invoice_id, is_active, is_legacy, auto_invoice, odoo_invoice_id, has_contract, blocked_reasons[], to_issue_group, issue_path, related_documents[], legacy_unified, contributions[] }`. `payment_state`: `unpaid · partial · paid · overdue · not_applicable` |
| `GET /billing/invoices/summary` | mismos filtros (período default: mes en curso) | `{ currency, period, by_currency[{ currency, billed, credited, net, pending_issue, pending_issue_unvalued, receivable, overdue, collected, unconverted_invoices }], system{ currency, billed, credited, net, pending_issue, receivable, overdue, collected }, counts{ pending_issue, blocked, overdue, overdue_avg_days, nc_pending_emission }, unconverted{ invoices, reason } }` (`receivable`/`overdue` = saldo a hoy) |
| `GET /billing/to-issue` | `until` (default fin de mes), `group`, `blocker_code`, filtros comunes | paginado de fila + `group: ready\|blocked\|late\|erp_draft`, `issue_path: erp\|external`, `blocked_reasons[{ code, message, next_step, action }]`, `warnings[]` + `until`, `groups{ ready, blocked{ count, by_code }, late, erp_draft }`, `truncated` |
| `GET /billing/credit-notes` | filtros comunes + `credit_type` | paginado `{ …fila, credited_invoice{ id, invoice_number, status, issue_date } }` + `counts{ pending_emission }` |
| `GET /billing/receivables/aging` | `as_of`, `company_id`, `client_id`, `currency`, `detail=invoices` | `{ as_of, currency, buckets\|null, by_currency[{ currency, buckets, total, invoices, total_system, last_payment_date, max_days_overdue, avg_days_overdue }], clients[…mismo detalle por cliente y moneda], system{ currency, buckets, total, unconverted }, invoices[]? }`, buckets `not_due, d1_30, d31_60, d61_90, d90_plus, no_due_date`; `invoices[]` (con `detail=invoices`) = una fila por factura con saldo para el reporte Cuentas por cobrar |
| `GET /billing/subscription-invoices` | filtros comunes, orden, paginado, `charge_state` | Facturas de suscripción (Stripe), solo lectura, con plan, período, estado del cobro y enlace al documento; `counts` por estado (ver `mapa-v2-facturacion.md`). Las lecturas aceptan `source=contract\|subscription\|other` |
| `GET /billing/calendar` | filtros comunes (sin `from`/`to`), `granularity=month\|week\|day`, `start`, `end`, `scope=invoices\|to_issue`, `group_by=client\|contract` | Calendario de facturación: filas × columnas con celdas (monto por moneda, sistema, conteo por estado, primeras 20 facturas) y totales por columna y generales (ver `mapa-v2-facturacion.md`) |
| `GET /billing/invoices/:invoiceId` | — | la fila de `GET /billing/invoices` (con `blocked_reasons[]`, `to_issue_group`, `issue_path`, `related_documents[]`, `legacy_unified`, `contributions[]`; incluye Canceladas e inactivas) + `payments_summary{ currency, total, paid, balance, payment_state, payments_count, voided_count, other_currency_count, last_payment_date }`; 404 si no es del holding. `VIEW_FACTURACION` |
| `GET /billing/invoices/:invoiceId/payments` | — | `{ invoice{ id, invoice_number, status, currency, total, paid, balance, payment_state, due_date }, payments[{ id, amount, currency, payment_date, method, reference, notes, confirmed, counts, created_by{ id, name }, created_at, bank_movement_id, voided_at, void_reason }] }` |
| `GET /billing/invoices/:invoiceId/emails` | — | `[{ id, kind: proforma\|invoice\|reminder\|collection, recipients[], subject, sent_by{ id, name }, sent_at, status }]` |
| `GET /billing/collection-settings` | — | `{ dunning_enabled, email_from, bcc, reminder_days_before[], reminder_days_after[], email_subject_template, email_body_template, exists, updated_at }` (sin fila: defaults, apagado) |
| `GET /billing/filters` | — | `{ companies[], clients[], client_entities[], currencies[], contracts[], statuses[], document_kinds[], erp_states[], electronic_states[], payment_states[], credit_types[] }` |
| `GET /billing/invoices/export` | filtros + `detail=header\|lines` | XLSX (stream; `jszip`, sin dependencia nueva) |

### 5.2 Nuevos POST/PUT (forma final)
| Ruta | Body | Efecto |
|---|---|---|
| `POST /billing/payments/preview` · `POST /billing/payments` | `{ allocations[{ invoice_id, amount }] (1–100), currency, payment_date, method?, reference?, notes? }` | Todo o nada. Inserta `invoice_payments` (`confirmed = true`, moneda y autor explícitos) en una transacción con `setApiWriter`, recalcula el estado en la API (§6.7) y evento `INVOICE_PAYMENT_REGISTERED` por factura con contrato. Respuesta `{ allocations[{ invoice_id, invoice_number, contract_id, amount, before, after, blockers[] }], blockers[], total_amount, currency, can_apply }` (+ `applied, payment_group_id, payment_ids[], event_ids[]`). Bloqueos: `not_issued`, `credit_note`, `cancelled`, `overpayment`, `payment_currency_mismatch`, `period_closed`, `client_mismatch` |
| `POST /billing/payments/:paymentId/void` | `{ reason }` | `confirmed = false` (nunca DELETE), estado hacia atrás, `INVOICE_PAYMENT_VOIDED`; `{ payment_id, invoice_id, voided, before, after, event_id }`; `already_voided`, `period_closed` |
| `POST /billing/invoices/:invoiceId/proforma` | `{ recipients[], subject?, message?, pdf_base64?, filename? }` | Correo con el resumen de `invoiceDetail` del 360 y el PDF de `proforma-pdf.ts` adjunto si viene (la API no dibuja PDF); fila por destinatario en `invoice_emails`. El front lo manda siempre que puede (`proformaAttachment`: `buildProformaModel` + `drawProformaPdf` de Contratos sobre el detalle del contrato); si no se puede dibujar, sale solo el resumen |
| `POST /billing/collections/preview` · `POST /billing/collections` | `{ invoice_ids[] (≤200), recipients_mode: entity_contacts\|custom, recipients?[], subject?, message? }` | Un correo por cliente (contactos del cliente; `bcc` de la configuración); `invoice_collection_logs` + `INVOICE_COLLECTION_SENT`; `skipped` con motivo (`no_contacts`, `paid`, `not_issued`, `credit_note`, `cancelled`, `not_found`) |
| `PUT /billing/collection-settings` | `{ dunning_enabled, reminder_days_before[], reminder_days_after[], email_from?, bcc?, email_subject_template, email_body_template }` | Upsert por holding; variables de plantilla validadas (400) |
| `POST /billing/to-issue/send-now` · `/reschedule` · `/fx` (+ `/preview`) · `/erp-reset` | `{ invoice_ids[] (≤200), …body del endpoint del contrato }` | **Fan-out** por `contract_id` en serie hacia `ContractInvoicesService`; `{ bulk_id, operation, preview, contracts, results[{ invoice_id, invoice_number, contract_id, ok, blockers[], warnings[], message? }], summary{ ok, failed } }` |

### 5.3 Reutilizados tal cual (vía vista rápida, BFF existente `app/api/contratos/[id]/facturas/*`)
Todos los de §0 (send-now, mark-issued, reschedule, fx, edit, deviation, bulk-edit, erp-reset, reorganize, descriptions, references,
partial-by-po, void, credit-note, consolidations). **Códigos de bloqueo** que la cola muestra (unión, sin inventar nuevos):
`not_pending`, `unified_invoice`, `legacy_invoice`, `credit_note`, `credit_note_send_pending`, `period_closed`, `sent_to_erp_draft`
(`action: erp_reset`), `already_sent`, `erp_send_disabled`, `no_erp_integration`, `no_erp_partner`, `needs_reference`, `item_without_product`,
`fixed_fx_without_rate`, `fx_rate_missing`, `tax_rate_missing`, `past_issue_date` (aviso, no bloquea el envío manual), `open_consumption` (aviso).
Facturación agrega solo los de pagos (`not_issued`, `cancelled`, `overpayment`, `payment_currency_mismatch`).

## 6. Reglas

1. **Single path**: una factura se opera en su vista rápida; la lógica vive en `contracts`. `billing` solo lee, hace fan-out y opera pagos/correos.
2. **Holding**: `HoldingScopeGuard` + `x-holding-id` de `apiClient`; toda consulta filtra `invoices.holding_id` y joins por holding.
3. **Permisos** (construido 01-10): lectura = `VIEW_FACTURACION`; pagos, cobranza, proforma, recordatorios y fan-out = `EDIT_FACTURACION`;
   super admin siempre (`BillingPermissionGuard`). Las acciones de factura en la vista rápida usan los endpoints del contrato (360).
4. **Período cerrado** (`accounting_period_cutoff`): bloquea mutaciones con fecha en período cerrado (emisión, NC, pago) → `period_closed`.
5. **Multimoneda**: montos por `invoice_currency`; totales en sistema con `total_system_currency`; filas sin conversión en `unconverted`, nunca
   × 1.0. PE spot muestran "se valoriza al emitir" (monto NULL), no 0.
6. **Consolidadas**: aparece **el consolidado** (activo) con chip y `contributions[]`; los orígenes (`is_active = false`) no se listan salvo
   filtro "incluir orígenes". Legacy unificadas: solo lectura (`unified_invoice`).
7. **Estado por pagos**: v2 no llama `recalc_invoice_status` sobre una Por Emitir (bug B-F3); recalcula solo emitidas: Σ ≥ total → Pagada;
   parcial → mantiene `Emitida`/`Enviada` (o `Vencida` si `due_date < hoy`); `payment_state = partial` lo muestra.
8. **NC**: nunca Por Emitir, nunca Pagada/Vencida, sin `due_date`, excluidas de AR y de vencidas; netean "Facturado" del período de su fecha.
9. **Anuladas**: original `Cancelada` + NC → fuera de AR, KPIs netos.
10. **Fechas** en `YYYY-MM` y `todayFor` (America/Santiago), sin `toISOString()`.

## 7. UI (`front-sapira/app/(protected)/lab/facturacion`)

- `page.tsx` + `components/FacturacionView.tsx`: `ProtectedPage` con `StickyToolbar` (barra fija de filtros + pestañas *Facturas · Por emitir ·
  Notas de crédito · Cobranza*, encabezados de tabla fijos), `AgentLauncher` + `InsightsSheet` (contexto: KPIs, bloqueos por código, AR).
- Reutiliza: `FacturaVistaRapidaDrawer` y `FacturaAcciones` (con secciones nuevas *Pagos* y *Correos* inyectadas por props, sin bifurcar),
  `detalle/facturas/**` (diálogos de acción, `RestablecerErpDialog`, `ReferenciasEditor`, nc-oc, `ProformaDialog`), `FacturaChips`,
  `ResultadoMasivo`, `DataTable` + `DataTableBulkBar` + `DataTableSavedViews` + `DataTableFilters`, `KpiCard`, `FacturasPreview` (render de
  líneas en vistas previas), patrón de export de Revenue.
- Nuevos: `FacturasTab`, `PorEmitirTab` (grupos colapsables con contador y acción sugerida por bloqueo), `NotasCreditoTab`, `CobranzaTab`
  (aging + lista), `RegistrarPagoDrawer` (`FormDrawer`, `NumberField`, `DatePicker`, `SaveButton`), `CorreoCobroDialog`, `RecordatoriosDrawer`.
- Hooks `lab/facturacion/hooks/use-facturacion.ts` (React Query, claves por filtros); schemas Zod espejo en `lib/schemas/facturacion.ts`.
- `lib/app-links.ts`: `facturacionHref` apunta a `/lab/facturacion?invoice=<id>` mientras exista el lab (super admin); `facturacion.migrated`
  pasa a `true` solo en el switch.

## 8. Migraciones

**Ninguna.** Todo lo necesario existe: `invoices` (estados, NC, ERP), `invoice_payments`, `invoice_collection_logs`,
`invoice_collection_settings`, `invoice_emails`, `invoice_references`, `contract_lifecycle_events` (tipos de evento = texto libre, sin CHECK;
los nuevos `INVOICE_PAYMENT_REGISTERED` / `INVOICE_PAYMENT_VOIDED` / `INVOICE_COLLECTION_SENT` no cambian esquema). `recalc_invoice_status` se
deja intacto para el front viejo; v2 calcula en la API (regla 6.7) y escribe con `sapira.writer = 'api'` (el trigger
`after_invoice_payment_change` debe quedar como no-op para el writer api: **asset**, no migración — se confirma en F4 con la costura). Si el
vínculo invoice ↔ DTE nativo se necesita, es de Leon y va en su spec.

## 9. Bugs del legado que se cierran

| Id | Qué | Con |
|---|---|---|
| B-F1 | KPIs suman monedas distintas, NC y Canceladas mezcladas, corte 1.000 | `summary` por moneda + sistema, `unconverted` |
| B-F2 | Webhook Odoo: `payment_state` `partial`/`in_payment` → **Pagada** (`odoo-webhook.service.ts:131-140`) | `payment_state` derivado de pagos; propuesta a Leon: `partial → Enviada` + pago parcial (§11) |
| B-F3 | `recalc_invoice_status` pasa una Por Emitir con `issue_date` a Enviada si se registra un pago | Pagos solo sobre emitidas (`not_issued`) |
| B-F4 | Parcial vencido sin estado visible ("Enviada"/"Vencida" sin saldo) | `payment_state = partial` + saldo |
| B-F5 | Dos caminos de vencido distintos: `mark_overdue_invoices` (solo Enviada) y edge `check-overdue-invoices` (Emitida/Enviada, `due_date` < hoy **UTC**, sin filtrar `is_active` ni NC) | Vencido derivado en lectura (`due_date < todayFor` y no pagada, sin NC ni inactivas) |
| B-F6 | 26 NC "Vencida" (`check-overdue-invoices` no excluye NC) | NC fuera de vencidas y AR; corrección del dato a criterio de Domi |
| B-F7 | `bulk_emit` marca "Enviada" sin enviar al ERP | `mark-issued` (Emitida) o `send-now` |
| B-F8 | Duplicar en cualquier estado / DELETE de PE / UPDATE de fecha sin evento | No existen; reprogramar con evento |
| B-F14 | `recalc_invoice_status` suma pagos sin mirar moneda (CLP contra USD → Pagada) y una Pagada nunca vuelve atrás al quitar un pago | `payment_currency_mismatch`; anular registro recalcula hacia atrás |
| B-F15 | Pago masivo aplica el mismo monto y moneda a todas las seleccionadas y no filtra estados (`InvoiceBulkActions.tsx:180`) | Asignación por factura (`allocations[]`), solo emitidas |
| B-F16 | Filtro de moneda usa `currency` (no existe) y vacía la lista; export deja "Razón Social Cliente" en blanco (`FacturasList.tsx:125`) | Filtros y export en la API |
| B-F17 | KPI "Cuentas por cobrar" no descuenta pagos parciales y el tab AR sí: dos cifras; moneda fija `USD` | Una definición (`receivable` = total − pagos confirmados) en `summary` y `aging` |
| B-F18 | `send-collection` lee `settings.email_bcc` (la columna es `bcc`), HTML sin escapar, remitente de respaldo `onboarding@resend.dev`; recordatorios automáticos configurables pero nunca implementados | Correo desde la API con plantillas escapadas y `bcc`; job real (§4.6) |
| B-F19 | Vista "Vista previa" / "Descargar PDF" sin acción; Cancelar = toast "en desarrollo"; edición y pago masivo inalcanzables; referencias se borran y reinsertan sin transacción | Sin botones muertos (regla de la casa); referencias por `PUT …/references` |
| B-F9 | AR cuenta sin `due_date` como vencida y suma monedas | Columna "Sin vencimiento", por moneda |
| B-F10 | Filtro de período en UTC (corre un día/mes en Chile) | `YYYY-MM` + `todayFor` |
| B-F12 | Odoo `electronic_status = rejected` deja la factura `Emitida` sin rastro en Sapira | Facturación lo muestra desde el log del envío (`odoo-sended-logs`); persistirlo es de Leon (§11) |
| B-F13 | `invoices.controller.ts` sin `HoldingScopeGuard` | `billing` con guard; propuesta a Leon de agregarlo |
| B-F11 | Edge functions con service role (proforma, cobro) y lecturas directas a Supabase | API + BFF; Supabase solo auth |
| U3 / S4b | Unificar pierde OC/HES, serie, `contract_id`; $0 en Odoo | Sin unificar; consolidación v2 |
| S4b NC | IVA del header en moneda de contrato; tasa invertida | NC espejo por línea (360) |

## 10. Orden de construcción

1. **F1 · Lectura**: módulo `billing` (`GET invoices`, `summary`, `filters`), BFF, `/lab/facturacion` › Facturas con KPIs, filtros, vistas
   guardadas y vista rápida reutilizada (acciones del 360). Tests Jest de filtros/estados derivados y Vitest de la vista.
2. **F2 · Por emitir**: `GET to-issue` con grupos y bloqueos; fan-out masivo (`to-issue/send-now|reschedule|fx|erp-reset`) con resultado por fila.
3. **F3 · NC**: `GET credit-notes`, pestaña, aviso de pendientes de emisión electrónica.
4. **F4 · Cobranza**: pagos (`payments`, `void`, `GET …/payments`), aging, `payment_state`; costura del trigger de pagos.
5. **F5 · Correos y recordatorios**: proforma, cobro (una/lote), `collection-settings`, job diario apagado por defecto; calendario por cliente.
6. **F6 · Export + Insights + docs**: XLSX, contexto de Insights, documentación funcional `docs/documentacion-funcional/facturacion/`,
   reglas (`AGENTS.md`, `.cursor/rules`, `docs/reglas-desarrollo`) y DoD documental.
7. **Cierre de brechas (01-10, sin commit)**: `GET /billing/invoices/:invoiceId` + BFF + enlace profundo `?invoice=`; proforma con PDF adjunto
   desde el front; chips `group`/`blocker_code` en la cola (URL) e "Incluir Canceladas" (`include_cancelled`) en Facturas; Calendario de Por
   emitir (F5, sin API nueva). Queda: ocultar "Ver en Facturación" en el drawer (OK de Contratos) y el timeout de la suite completa (ver mapa §8).

**Cambio propuesto a `AGENTS.md`** (sugerencia, no aplicado): reemplazar
"**Facturación operativa** (`/facturacion`) vive en Vite; no implementar ese módulo en Next." por
"**Facturación v2** se construye en `app/(protected)/lab/facturacion` (spec `api-sapira/docs/v2-rediseno/spec-facturacion-v2.md`): vista por
holding, cola Por emitir, NC, cobranza y recordatorios; toda operación sobre una factura reutiliza la vista rápida y los endpoints del Contrato
360 (single path). Hasta el switch, producción sigue en la app actual (`/facturacion`)."

## 11. Pendientes y preguntas para Domi (con default para construir esta noche)

1. **Factura sin contrato** (manual suelta, suscripciones Stripe, legacy importadas): ¿se listan? **Default**: se listan en solo lectura con chip
   de origen (`invoice_type` Importada/Suscripción, sin contrato) y sin acciones; no se crean facturas sueltas en v2.
2. **Estado de un pago parcial**: ¿agregar valor "Parcial" al CHECK? **Default**: no (sin migración); `payment_state = partial` derivado y la
   factura conserva Emitida/Enviada/Vencida.
3. **Pago en otra moneda que la factura y revertir Pagada**: **Default**: v1 solo misma moneda (400 `payment_currency_mismatch`); anular un pago
   recalcula (Pagada → Emitida/Enviada/Vencida). Diferencia de cambio del cobro queda para Revenue (M9).
4. **Conciliación bancaria** (cartolas, match): **Default**: fuera de F1–F6; se queda en la app vieja y se especifica aparte con Leon.
5. **Recordatorios automáticos**: **Default**: job construido pero `dunning_enabled = false` por holding; solo correo, sin WhatsApp; nunca a NC.
   El default de la columna pasa a `false` con la migración `1790730000000-CollectionDunningDefaultOff` (pendiente de aplicar); el job sigue
   exigiendo además `BILLING_REMINDERS_ENABLED=true`.
6. **Permiso de pagos/cobranza**: **Default**: reusar el permiso de facturación del catálogo si existe (`permissions`); si no, admin del holding.

**Pendientes de Leon (no se construyen; Facturación solo muestra el estado)**: NC/ND a Odoo como `out_refund` y NC de anulación → `Cancelada`
al emitirse; Retirar del ERP por API; webhook `partial` ≠ Pagada (B-F2); vínculo invoice ↔ DTE nativo (SII) con estados propios
(`aceptado/rechazado/reparo`) y equivalentes SUNAT/CFDI; consolidar líneas iguales solo en el DTE; límites de glosa MX/PE.
