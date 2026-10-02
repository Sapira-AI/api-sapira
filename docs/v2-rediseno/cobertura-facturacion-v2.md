# Cobertura · Facturación v2 (auditoría funcional del 01-10)

> 01-10-2026 · Claude (auditoría + arreglos, sin git, sin base, sin migraciones). Fuentes: [`spec-facturacion-v2.md`](./spec-facturacion-v2.md),
> [`mapa-v2-facturacion.md`](./mapa-v2-facturacion.md), [`spec-facturas-en-contrato-360.md`](./spec-facturas-en-contrato-360.md),
> [`auditoria-contratos.md`](./auditoria-contratos.md) (S4/S4b/S6); front viejo `sapira-ai/src/pages/Facturacion.tsx` + `src/components/facturacion/**`
> + `supabase/functions/{send-collection,send-proforma,check-overdue-invoices}`; código `src/modules/billing/**`, front
> `front-sapira/app/(protected)/lab/facturacion/**`, `app/api/facturacion/**`. Misma forma que [`cobertura-contratos-v2.md`](./cobertura-contratos-v2.md).
> Rutas cortas: **API** = `src/modules/billing/`, **LAB** = `front-sapira/app/(protected)/lab/facturacion/`. Tests Jest en API (`*.spec.ts`),
> Vitest en LAB (`*.test.ts[x]`).

Estado: **Cerrado** (construido y con test) · **Parcial** (construido con hueco o sin test) · **Pendiente** · **Fuera por decisión** (spec §2 / Q).

## 0. Arreglos aplicados en esta auditoría (sin commit)

| # | Defecto verificado | Arreglo | Test |
|---|---|---|---|
| A1 | **KPI "Facturado" restaba dos veces una anulación**: la original queda `Cancelada` (fuera de `billed`) y su NC de anulación igual restaba en `credited`. Contradice `countedInvoices` del 360 ("una NC que corrige una factura que ya no está vigente no resta de nuevo") | `billing-read.service.ts:summary`: `credited` excluye NC cuya factura acreditada está `Cancelada` o inactiva (`billing-sql.ts` agrega `ri.is_active AS related_invoice_active`) | `billing-sql.spec.ts` › *KPIs (summary)* |
| A2 | **Con `include_inactive=true` el resumen sumaba los orígenes consolidados y el consolidado** (doble conteo de facturado / por emitir) | `billed`, `credited` y `pending` exigen `d.is_active` | idem |
| A3 | **Pago sobre factura sin contrato aceptado por la API** (spec §11.1: solo lectura; el front ya la sacaba de la selección, la API no) | `billing-states.ts:planPayments`: bloqueo `no_contract` (409, todo o nada) | `billing-states.spec.ts` › *bloqueos* |
| A4 | **Evento `INVOICE_COLLECTION_SENT` con `effective_date = CURRENT_DATE`** (fecha del servidor en UTC: después de las 21:00 de Chile quedaba al día siguiente; B-F10) | `billing-collections.service.ts:logCollection` recibe `todayFor(null, now)` | `billing-collections.service.spec.ts` (nuevo) |
| A5 | **Cobranza y recordatorios sin ningún test** (bcc, motivos de omisión, apagado por defecto, plantilla inválida) | `billing-collections.service.spec.ts`: 7 casos | — |
| A6 (G6) | **Antigüedad y resumen daban saldos distintos** para una `Pagada` con pagos parciales (aging: total − pagos; resumen: 0) | Regla única `billing-sql.ts:balanceSql` (Pagada ⇒ 0) usada por la CTE (lista, resumen) y por `aging`; aviso `warnings[{ code: 'paid_without_full_payments', count }]` en `summary` y `aging` (`paidWithoutFullPaymentsSql`; gemelo TS `paidWithoutFullPayments`) | `billing-sql.spec.ts` › *saldo: una sola regla*, `billing-states.spec.ts` |
| A7 (G7) | **Correo de cobro y proforma aceptaban facturas sin contrato** | `noContractBlocker` compartido con pagos: `planCollection` lo agrega a `blockers` (409, nada se envía) y `proforma` lo exige | `billing-collections.service.spec.ts` › *factura sin contrato* |
| A8 | Pedidos de la auditoría de UI (no defectos) | `aging`: `bucket_counts` junto a `buckets` (montos); `to-issue`: `groups.amount_invoice_currency_by_currency`; `collections/preview`: `totals_by_currency`; correos: `status` normalizado (`normalizeEmailStatus`, `EMAIL_STATUSES` en Swagger) | `billing-states.spec.ts`, `billing-sql.spec.ts`, `billing-collections.service.spec.ts` |

Docs alineadas: `mapa-v2-facturacion.md` §3/§4 (regla de KPIs, `no_contract`), `front-sapira/docs/documentacion-funcional/facturacion/README.md`
(reglas), definición del KPI en LAB `_lib/estados.ts` (`DEFINICIONES_FACTURACION.facturado`). Reglas de desarrollo: sin cambio (no se tocó convención).

## 0b. Revisión del dueño 02-10 (sin commit)

| # | Pedido | Cambio | Test |
|---|---|---|---|
| R1 | Pestaña "Suscripciones" → **Invoices** + columna **Fuente** (proveedor · cuenta) | API `subscriptionInvoices` (`source_*`); LAB `_lib/tabs.ts` (`?tab=invoices`, `?tab=suscripciones` redirige), `SuscripcionesTab.tsx:sourceLabel` | `billing-sql.spec.ts`, `tabs.test.ts`, `SuscripcionesTab.test.tsx`, `FacturacionView.test.tsx` |
| R2 | Cobranza sin período por defecto (saldos) | LAB `_lib/tabla-filtros.ts:hasDefaultPeriod`, `CobranzaTab.tsx` (sin "Todo lo pendiente") | `tabla-filtros.test.ts`, `CobranzaTab.test.tsx`, `FacturacionView.test.tsx` |
| R3 | Antigüedad sin tramo "CLF"; por compañía | API `billing-states.ts:buildAging` (`review`, `by_company`), `aging?group=company`; LAB `CobranzaTab.tsx:Antiguedad` | `billing-sql.spec.ts`, `CobranzaTab.test.tsx` |
| R4 | Reportes compactos (top 10 + Otros), filtros completos, **proyección** Mensual · Semanal · Diaria con Vencido por cobrar, **meta anual** | API `billing-forecast.ts`, `forecast`, `goalProgress`, `BillingCollectionsService.goal/saveGoal`, migración `1790750000000-Budgets` (tablas `budgets`, `budget_lines`; aplicada en QA y producción el 02-10, v0.0.75/76); LAB `CobranzaProyeccion.tsx`, `_lib/cobranza.ts`, `CuentasPorCobrarReport.tsx` | `billing-forecast.spec.ts`, `billing-collections.service.spec.ts`, `cobranza.test.ts`, `CobranzaTab.test.tsx` |
| R5 | Orden por Emisión no alternaba | Causa: ciclo de `DataTable` asc → desc → sin orden y la pestaña volvía al orden por defecto (Emisión desc) = clic sin efecto. LAB `facturas-columns.tsx:sortAfterClick`; API `to-issue` con `sortBy` | `FacturasTab.test.tsx`, `billing-sql.spec.ts` |
| R6 | Columnas opcionales de montos (contrato y factura, TC) | API `contractCurrencyTotals` + XLSX; LAB `facturas-columns.tsx:amountColumns`, `_lib/exportar-seleccion.ts:optionalExportColumns` | `billing-forecast.spec.ts`, `exportar-seleccion.test.ts` |
| R7 | Acciones solo cuando tienen sentido | LAB `_lib/acciones-masivas.ts:bulkBarActions` (oculta lo que nunca aplica), `PagosCorreosPanel.tsx:mailActionsOf`, Cobranza usa la misma barra | `acciones-masivas.test.ts`, `PagosCorreosPanel.test.tsx`, `FacturasTab.test.tsx` |
| R8 | Calendario: sin valorizar en moneda del contrato; rango elegible; pie plegable | API `billing-calendar.ts` (`unvalued`); LAB `_lib/calendario.ts` (ventanas), `FacturacionCalendario.tsx` | `billing-calendar.spec.ts`, `calendario.test.ts`, `FacturacionCalendario.test.tsx` |
| R9 | "Limpiar filtros" quita el período; folio con el documento real; aviso de scroll horizontal | LAB `FacturacionFiltros.tsx:clearedFields`, `_lib/estados.ts:documentLabel` (API `tax_document_name`), `FacturacionUi.tsx:ScrollShadowX` | `FacturasTab.test.tsx`, `FacturacionUi.test.tsx`, `billing-sql.spec.ts` |

## 1. Front viejo → v2

| Capacidad vieja (archivo) | v2 · archivo : función | Test | Estado |
|---|---|---|---|
| Pestañas Facturas · Legacy · Conciliación · CxC (`pages/Facturacion.tsx`) | LAB `components/FacturacionView.tsx:FacturacionView`, `_lib/tabs.ts:parseFacturacionTab` (Facturas · Por emitir · NC · Cobranza) | `tabs.test.ts` | Cerrado |
| KPIs + filtro de período (`FacturacionKPIs.tsx`, `KPIsPeriodFilter.tsx`) | API `billing-read.service.ts:summary`; LAB `_lib/kpis.ts:buildKpiTiles` | `billing-sql.spec.ts` (KPIs), `kpis.test.ts` | Cerrado (A1, A2) |
| Lista paginada (`FacturasList*.tsx`, `FacturasListPagination.tsx`) | API `billing-read.service.ts:invoices` + `billing-sql.ts:invoicesCte`; LAB `components/FacturasTab.tsx` | `billing-sql.spec.ts` (CTE), `FacturasTab.test.tsx` | Cerrado |
| ~16 filtros avanzados (`facturasFilters.ts`, `FacturasListFilters.tsx`) | API `dtos/billing.dto.ts:BillingFiltersDto`; LAB `_lib/filtros.ts:toBillingQuery`, `FacturacionFiltersBar.tsx` | `filtros.test.ts`, `billing-sql.spec.ts` | Cerrado |
| Presets (Vencidas, Pendientes, Pagadas este mes, Exportación, NC, Suscripciones) | Vistas guardadas (`MetricsVistasMenu`) + filtros; sin presets predefinidos | — | Parcial |
| Selector de columnas (`FacturasColumnSelector.tsx`) | LAB `components/facturas-columns.tsx:buildFacturasColumns` (DataTable, columnas elegibles) | `FacturasTab.test.tsx` | Cerrado |
| Vistas guardadas | `MetricsVistasMenu` en `FacturacionView` (sin `?invoice=`) | `tabs.test.ts` | Cerrado |
| Calendario mes × cliente (`InvoicesCalendarByClient.tsx`) | LAB `components/PorEmitirCalendario.tsx`, `_lib/calendario.ts:queueCalendar` (por día, no por cliente) | `calendario.test.ts`, `PorEmitirTab.test.tsx` | Parcial |
| Exportar (`FacturasList.tsx`) | API `billing-export.service.ts:stream`, `billing-export.ts:invoiceCells/lineCells`; BFF `billingExportRoute` | `billing-export.spec.ts` | Cerrado |
| Ver factura + referencias + documentos relacionados (`InvoiceViewModal.tsx`, `InvoiceRe*Section.tsx`) | LAB `components/FacturaVistaRapida.tsx` (drawer del 360) + API `billing-read.service.ts:invoice` (deep link) | `FacturaVistaRapida.test.tsx`, `billing-sql.spec.ts` | Cerrado |
| Emitir manual con folio (`InvoiceEmitModal.tsx`, `useInvoiceManualEmission.ts`) | `contracts/contract-invoices.service.ts:markIssued` vía vista rápida | `contract-invoices.service.spec.ts` | Cerrado |
| División al emitir | — (S4-14) | — | Fuera por decisión |
| Emitir masivo (`InvoiceBulkActions.tsx` › `bulk_emit_*`) | API `billing-bulk.service.ts:sendNow` (fan-out a `sendNow` del 360) | `billing-bulk.service.spec.ts`, `AccionMasivaDialog.test.tsx` | Cerrado |
| Reagendar + historial (`InvoiceRescheduleModal.tsx`, `InvoiceRescheduleHistory.tsx`) | `billing-bulk.service.ts:reschedule` → `rescheduleBulk`; historial = eventos del 360 | `billing-bulk.service.spec.ts` | Cerrado |
| Vista previa de FX (`FxPreviewModal.tsx`, `useExchangeRate.ts`) | `billing-bulk.service.ts:fx` → `previewFxBulk/fxBulk` | `billing-bulk.service.spec.ts` | Cerrado |
| Restablecer borrador del ERP | `billing-bulk.service.ts:erpReset` → `erpResetBulk` | `billing-bulk.service.spec.ts` | Cerrado |
| Nota de crédito (`CreditNoteModal.tsx`, `create_credit_note_safe`) | `contract-invoice-void.service.ts:voidInvoice` / NC de descuento (vista rápida) | `invoice-void.spec.ts` | Cerrado |
| Lista de NC | API `billing-read.service.ts:creditNotes`; LAB `components/NotasCreditoTab.tsx` | `billing-sql.spec.ts` (SQL); sin test de UI | Parcial |
| Crear factura suelta / editar PE (`InvoiceFormModal.tsx`, `InvoiceEditModal.tsx`) | Editar = editor del 360; suelta no existe (Q1) | — | Fuera por decisión |
| Ajustar a lo emitido (`InvoiceAdjustModal.tsx`) | — (360 §8, 30-09) | — | Fuera por decisión |
| Unificar / desunificar (`UnifyInvoicesModal.tsx`) | Solo lectura: `billing-read.service.ts:decorate` (`UNIFIED_READ_SQL`, `legacy_unified`) | `billing-sql.spec.ts` | Fuera por decisión (lectura Cerrada) |
| Duplicar / Eliminar (`FacturasListTable.tsx`) | — (S4, B-F8) | — | Fuera por decisión |
| Cancelar Por Emitir | Sin cobro / Terminar en el contrato | — | Fuera por decisión |
| Proforma (`InvoiceProformaModal.tsx`, edge `send-proforma`) | API `billing-collections.service.ts:proforma`; LAB `CorreosForms.tsx:ProformaForm`, `_lib/proforma-adjunto.ts:proformaAttachment` | `CorreosForms.test.tsx`, `proforma-adjunto.test.ts`; API solo el caso `no_contract` | Parcial |
| Registrar pago (`PaymentModal.tsx`, `paymentService.ts`) | API `billing-payments.service.ts:register`, `billing-states.ts:planPayments`; LAB `RegistrarPagoForm.tsx`, `_lib/pagos.ts:buildPaymentBody` | `billing-payments.service.spec.ts`, `billing-states.spec.ts`, `RegistrarPagoForm.test.tsx`, `pagos.test.ts` | Cerrado (A3) |
| Pago masivo (`BulkPaymentModal.tsx`) | `allocations[]` por factura (mismo endpoint) | idem | Cerrado |
| Historial de pagos (`conciliacion/PaymentHistoryPanel.tsx`) | API `billing-read.service.ts:invoicePayments` (02-10: + `settlement_reason`, `original_amount`, `original_currency`, `fx_rate`); por movimiento, `payments[]` de `GET /billing/reconciliation/movements`; LAB `PagosCorreosPanel.tsx` | `billing-sql.spec.ts` › *pagos de una factura*, `billing-reconciliation.service.spec.ts`; sin test de UI | Parcial (API Cerrada) |
| Quitar pago (DELETE directo) | `billing-payments.service.ts:void` (`confirmed = false`, estado hacia atrás, evento) | `billing-payments.service.spec.ts` | Cerrado |
| Correo de cobro (`CollectionModal.tsx`, edge `send-collection`) | `billing-collections.service.ts:previewCollection/sendCollection`; LAB `CorreosForms.tsx:CorreoCobroForm` | `billing-collections.service.spec.ts` | Cerrado (A4, A5, A7) |
| Cobranza masiva (`InvoiceBulkActions.tsx` › collection) | mismo endpoint (≤ 200 facturas, un correo por cliente) | idem | Cerrado |
| Referencias / descripciones masivas (`InvoiceBulkActions.tsx`) | Solo por contrato (`bulk-edit` / `PUT …/references` del 360), no entre contratos | — | Parcial |
| Recordatorios automáticos (configurables, nunca implementados) | `billing-collections.service.ts:runReminders`, `billing.scheduler.ts:remindersDaily`; LAB `RecordatoriosDrawer.tsx` | `billing-collections.service.spec.ts`, `billing.module.spec.ts` | Cerrado |
| Antigüedad AR (`reports/ARAgingReport.tsx`) | `billing-read.service.ts:aging`, `billing-states.ts:buildAging`; LAB `CobranzaTab.tsx` | `billing-states.spec.ts`, `billing-sql.spec.ts` | Cerrado (A6) |
| Vencidas (edge `check-overdue-invoices`, `mark_overdue_invoices`) | Derivado en lectura (`is_overdue`, `payment_state`, `days_overdue`) | `billing-states.spec.ts` | Cerrado |
| Conciliación bancaria (`conciliacion/**`: cartola, mapeo, lotes, motor, conciliar, deshacer) | **Revertido el 02-10** ([`spec-conciliacion-v2.md`](./spec-conciliacion-v2.md)): API `billing-reconciliation.controller.ts` + `billing-reconciliation.service.ts` (importar con huella por línea y lock, revertir, plantillas, cola, KPIs, sugerencias persistidas, conciliar con vista previa todo o nada por ítem, deshacer con `void`, ignorar/reabrir), puros `billing-reconciliation-statement.ts:parseStatement` y `billing-reconciliation-match.ts:suggestMatches/planMatch`; pagos por `billing-payments.service.ts:register(…, options)`; migración `1790740000000-BankReconciliationV2` (aplicada en QA y producción el 02-10) | `billing-reconciliation-statement.spec.ts`, `billing-reconciliation-match.spec.ts`, `billing-reconciliation.service.spec.ts`, `billing-payments.service.spec.ts`, `billing-states.spec.ts` | Cerrado (migración aplicada en QA y producción 02-10) |
| Facturas Legacy (`tabs/FacturasLegacyTab.tsx`) / reabrir período | — (datos históricos, Configuración) | — | Fuera por decisión |
| Realtime que recarga todo / `diagnose-odoo-invoices` | Invalidación de React Query (`useInvalidateFacturacion`) / Leon | — | Fuera por decisión |

**Conteo** (37 filas, 02-10): Cerrado 23 · Parcial 6 · Pendiente 0 · Fuera por decisión 8 (filas que agrupan varias piezas cuentan una vez; la conciliación salió de "Fuera por decisión" y Legacy/reabrir período quedaron en su propia fila).

## 2. Bugs del legado (spec §9) — verificados en el código, no en el doc

| Id | Verificación (grep / lectura) | Estado |
|---|---|---|
| B-F1 | `summary`: `GROUP BY` moneda, `system` con `total_system_currency`, `unconverted` aparte; sin corte (SQL agregado). Doble resta de anulación corregida (A1) | Cerrado |
| B-F2 | `odoo-webhook.service.ts:determineInvoiceStatus` sigue: `payment_state ≠ not_paid → Pagada`. En v2 `paymentStateOf` da `paid` si `status = 'Pagada'` (gana sobre los pagos): una parcial del ERP se ve **pagada con saldo 0** | Pendiente (Leon; ver G2) |
| B-F3 | `planPayments`: `not_issued` sobre Por Emitir; `statusAfterPayments` nunca toca Por Emitir. Asset `after_invoice_payment_change.sql` con guard aplicado en QA y producción desde el 02-10 (api v0.0.73/74): los pagos de la API no pasan por `recalc_invoice_status` | Cerrado |
| B-F4 | `payment_state = partial` + `balance` en fila y en `payments_summary` | Cerrado |
| B-F5 | Un solo vencido derivado: `is_overdue` = receivable ∧ no pagada ∧ `due_date < todayFor` (texto `YYYY-MM-DD`), excluye NC e inactivas | Cerrado |
| B-F6 | NC fuera de `isReceivable` / AR / vencidas; `statusAfterPayments` no toca NC. Las 26 NC "Vencida" de prod siguen en la base (corrección del dato: Domi) | Cerrado (dato pendiente) |
| B-F7 | `billing` no escribe `Enviada`: fan-out a `sendNow` / `markIssued` del 360 | Cerrado |
| B-F8 | Sin rutas de duplicar ni `DELETE` en `billing.controller.ts` (grep) | Cerrado |
| B-F9 | `agingBucketOf`: sin `due_date` → `no_due_date`; `buildAging` por moneda | Cerrado |
| B-F10 | Fechas de negocio con `todayFor`; meses con `nextMonthStart` (sin UTC). El evento de cobro usaba `CURRENT_DATE` (A4) | Cerrado |
| B-F11 | LAB y BFF sin `supabase` (grep vacío); proforma y cobro desde la API | Cerrado |
| B-F12 | Ni `billing` ni LAB leen `odoo-sended-logs` ni `electronic_status` (grep vacío): el rechazo de Odoo no se ve en Facturación | Pendiente (G5) |
| B-F13 | `billing.controller.ts` con `HoldingScopeGuard`; `invoices.controller.ts:16` sigue solo con `SupabaseAuthGuard` | Parcial (Leon, G4) |
| B-F14 | Pagos solo en la moneda de la factura (SQL `UPPER(p.currency) = …`, `payment_currency_mismatch`); anular recalcula hacia atrás | Cerrado |
| B-F15 | `RegisterPaymentDto.allocations[{ invoice_id, amount }]`; bloqueos por estado | Cerrado |
| B-F16 | Filtro `invoice_currency` sobre `COALESCE(invoice_currency, contract_currency)`; export con columna "Razón social" (`billing-export.ts`) | Cerrado |
| B-F17 | Una regla de saldo (`balanceSql` / `balanceOf`) en lista, `summary` y `aging`; `Pagada` sin pagos completos ⇒ 0 + aviso `paid_without_full_payments` (A6) | Cerrado |
| B-F18 | `settings.bcc` real, `escapeHtml` en valores y texto (`renderTemplate`), remitente `email_from` o `SYSTEM_EMAIL_FROM` (sin `onboarding@resend.dev`, grep vacío), job real | Cerrado (A5) |
| B-F19 | LAB sin "en desarrollo"/"Próximamente"/TODO (grep vacío); referencias vía `PUT …/references` del 360 | Cerrado |
| U3 / S4b | Sin unificar en v2; consolidación del 360 | Cerrado |
| S4b NC | NC espejo por línea (`contract-invoice-void.service.ts`) | Cerrado |

**Conteo** (21 filas): Cerrado 18 · Parcial 1 · Pendiente 2 (B-F3 cerrado con el asset aplicado el 02-10; B-F6 con dato por corregir).

## 3. Casos de negocio

| Caso | Dónde | Test | Estado |
|---|---|---|---|
| Emitir factura lista | Cola `ready` (`toIssueGroupOf`); `billing-bulk.service.ts:sendNow` o `markIssued` del 360 | `billing-sql.spec.ts` (cola), `billing-states.spec.ts` (grupo), `billing-bulk.service.spec.ts` | Cerrado |
| Bloqueada por OC/HES | `planSendNow` → `needs_reference` (acción `references`) | `billing-sql.spec.ts` (cola ERP) | Cerrado |
| Bloqueada por FX | `fixed_fx_without_rate` / `fx_rate_missing` (acción `fx`) | `contract-invoices.spec.ts`, `billing-states.spec.ts` | Cerrado |
| Período cerrado | Cola: `periodClosedBlocker` (acción `reschedule`); pagos y anulación: `period_closed` | `contract-invoices.spec.ts`, `billing-states.spec.ts` | Cerrado |
| Borrador en el ERP | Grupo `erp_draft`, `sent_to_erp_draft` → `erp_reset` (fan-out) | `billing-sql.spec.ts`, `billing-bulk.service.spec.ts` | Cerrado |
| Factura rezagada | Grupo `late` (emisión < hoy) | `billing-sql.spec.ts` (sin ERP) | Cerrado |
| Emisión externa | `issue_path = external` quita `ERP_ONLY_CODES`; `electronic_state = issued_external` por evento | `billing-states.spec.ts` | Cerrado |
| NC ligada | `creditNotes` con `credited_invoice`; NC fuera de AR; KPI neto sin doble resta | `billing-sql.spec.ts` (KPIs), `billing-states.spec.ts` | Cerrado (A1) |
| Pago parcial | `statusAfterPayments` conserva el emitido; `payment_state = partial` | `billing-states.spec.ts` | Cerrado |
| Sobrepago rechazado | `overpayment` (acumulado por factura) | `billing-states.spec.ts`, `pagos.test.ts` | Cerrado |
| Anular pago revierte estado | `void`: Pagada → Emitida/Enviada/Vencida | `billing-payments.service.spec.ts`, `billing-states.spec.ts` | Cerrado |
| Pago en otra moneda rechazado | `payment_currency_mismatch` | `billing-states.spec.ts` | Cerrado |
| Antigüedad vencida | `aging` 0 · 1-30 · 31-60 · 61-90 · 90+ · sin vencimiento, por moneda y cliente | `billing-states.spec.ts` | Cerrado |
| Correo de cobro con bcc | `planCollection` → `EmailsService.send({ bcc })` (sin repetir `to`) | `billing-collections.service.spec.ts` | Cerrado (A5) |
| Recordatorios apagados por defecto | Sin fila → `dunning_enabled: false`; job exige además `BILLING_REMINDERS_ENABLED=true` | `billing-collections.service.spec.ts`, `billing.module.spec.ts` | Cerrado (ver G3) |
| Facturas sin contrato solo lectura | LAB `_lib/filas.ts:isReadOnlyRow`; API `no_contract` en pagos, cobranza, proforma y fan-out | `FacturasTab.test.tsx`, `billing-states.spec.ts`, `billing-collections.service.spec.ts` | Cerrado (A3, A7) |
| Consolidada / legacy unificada solo lectura | `decorate` (`legacy_unified`, `contributions`), `unified_invoice` en la cola, `isActionablePending` | `billing-sql.spec.ts`, `masivo.test.ts` | Cerrado |
| Montos multimoneda | `by_currency` + `system` (`total_system_currency`), `unconverted`, PE spot sin valorizar aparte | `kpis.test.ts`, `billing-states.spec.ts` | Cerrado |
| Holding (sin fuga entre holdings) | `HoldingScopeGuard` + `i.holding_id` y cada join por holding; pagos/anulación/fan-out filtran holding (404) | `billing-sql.spec.ts` (holding siempre filtrado, 404) | Cerrado |
| Permisos VIEW / EDIT_FACTURACION | `BillingPermissionGuard`: VIEW en controlador, EDIT en cada POST/PUT, super admin pasa | `billing-permissions.service.spec.ts` | Cerrado (G9 en UI) |

**Conteo**: Cerrado 20.

## 4. Brechas por riesgo (con propuesta de una línea)

| # | Riesgo | Brecha | Propuesta |
|---|---|---|---|
| G1 | Alto | **Cerrada 02-10**: asset `after_invoice_payment_change.sql` (guard `sapira.writer`) aplicado en QA y producción (api v0.0.73/74) | Cerrado |
| G2 | Alto | Webhook Odoo `partial`/`in_payment` → `Pagada`; v2 muestra `paid`, saldo 0, fuera de AR y de cobranza | Leon: `partial → Enviada`; mientras, `paymentStateOf`/`balance` podrían priorizar pagos registrados cuando existan |
| G3 | Alto | `invoice_collection_settings.dunning_enabled` default `true` en la base y 1 fila en prod: el job solo queda apagado por `BILLING_REMINDERS_ENABLED` | Migración `1790730000000-CollectionDunningDefaultOff` (default `false`, entity actualizada; aplicada en QA y producción el 02-10); verificar fila de prod en `false` antes de encender la variable |
| G4 | Medio | `invoices.controller.ts` (Leon) sin `HoldingScopeGuard` (B-F13) | Leon: agregar el guard y `@HoldingId()` |
| G5 | Medio | Rechazo electrónico de Odoo (`rejected`) invisible en Facturación (B-F12) | Leer el último log de envío por factura o persistir el estado (Leon) y mostrarlo como `electronic_state` |
| G6 | — | **Cerrada (A6)**: una regla de saldo en lista, resumen y antigüedad + aviso `paid_without_full_payments` | — |
| G7 | — | **Cerrada (A7)**: cobranza y proforma rechazan facturas sin contrato con `no_contract` | — |
| G8 | Bajo | `trigger_sync_invoice_items_on_invoice_update` sin guard (mapa §7) | **Cerrada 02-10**: se deja como está: espejo de status e issue_date en las líneas, invariante simple hasta el switch; la API no escribe esos campos |
| G9 | Bajo | LAB no oculta escrituras sin `EDIT_FACTURACION` (el usuario ve 403 al confirmar) | Exponer permisos en `/billing/filters` o en la sesión y deshabilitar acciones |
| G10 | Bajo | Sin presets del viejo, calendario mes × cliente ni referencias/descripciones masivas entre contratos | Presets como vistas guardadas de sistema; masivo de referencias vía fan-out a `bulk-edit` |
| G11 | Bajo | Sin test de UI en `NotasCreditoTab`, `CobranzaTab`, `PagosCorreosPanel`; `proforma` de la API sin test | Un test de render + acción por pieza; spec de `proforma` (bloqueos NC/cancelada, adjunto, `invoice_emails`) |
| G12 | Bajo | `open_consumption` no se evalúa en la cola; `plan_deviation` = último motivo, no el conciliador | Mantener; evaluar consumo por contrato si la cola lo necesita |
| G13 | Bajo | "Ver en Facturación" del drawer del 360 visible dentro de Facturación (cambio en Contratos sin OK) | Aplicar la prop propuesta en `lab/facturacion/README.md` cuando Domi dé el OK |

## 5. Verificación

- API: `npx jest src/modules/billing src/modules/contracts/contract-invoices` → 10 suites, 136 tests OK.
- Build real: `npx tsc -p tsconfig.build.json --outDir <scratchpad>/build-api22` → exit 0.
- Front: `npx vitest run app/(protected)/lab/facturacion app/api/facturacion lib/schemas/facturacion-schemas.test.ts` → 15 archivos, 55 tests OK.
- `eslint --fix` solo sobre los archivos tocados.
- 02-10 (conciliación v2): `npx jest src/modules/billing` → 12 suites, 145 tests OK; `tsc -p tsconfig.build.json` exit 0. Fallan a propósito
  (antes de aplicar `1790740000000`, ya aplicada el 02-10): `conciliacion.entities.spec.ts` (`bank_movements.ignore_reason`) y `facturacion.entities.spec.ts`
  (`invoice_payments`: 3 columnas, 2 CHECK).
