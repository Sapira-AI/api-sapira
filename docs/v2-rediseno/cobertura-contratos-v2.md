# Cobertura de Contratos v2 frente a lo comprometido en el rediseño

> 01-10-2026 · auditoría de solo lectura (Claude, para Domi). Pregunta: ¿Contratos v2 (multimoneda + modificaciones) cubre todo lo que
> comprometieron [`auditoria-contratos.md`](./auditoria-contratos.md), [`saneamiento-contratos.md`](./saneamiento-contratos.md),
> [`flexibilidad-con-trazabilidad.md`](./flexibilidad-con-trazabilidad.md), [`plan-coexistencia-funciones.md`](./plan-coexistencia-funciones.md),
> [`mapa-v2-contratos.md`](./mapa-v2-contratos.md), las `spec-*.md`, [`activacion-campos-api.md`](./activacion-campos-api.md),
> `docs/ROADMAP-OPERATIVO.md` y `ROADMAP-V2.md`? Cada estado se verificó con `grep` sobre el código y los tests (no con los ✅ de los docs).
> No se consultó ninguna base: el estado "aplicado en QA/prod" de migraciones y assets se toma de los docs y de la memoria del proyecto.

**Rutas abreviadas** (todas en `api-sapira/src/`): `cc` = `modules/contracts/contract-changes.ts` · `ccs` = `…/contract-changes.service.ts` ·
`be` = `…/billing-engine.ts` · `drafts` = `…/contract-drafts.service.ts` · `act` = `…/contract-activation.service.ts` · `ci` =
`…/contract-invoices.ts` · `reorg` = `…/invoice-reorganize.ts` · `edit` = `…/invoice-edit.ts` · `cons` = `…/consumption.service.ts` ·
`mc` = `…/multicurrency.ts` · `sched` = `modules/invoices/invoice-scheduler.service.ts` · `fn/` = `databases/postgresql/functions/` ·
`rsm` = `fn/revenue_schedule_rebuild_contract_ccy.sql`. Tests: `*.spec.ts` junto al archivo; front = `front-sapira/app/(protected)/lab/contratos/**`.

**Estados**: **Cerrado** (v2 lo resuelve y hay código + test) · **Parcial** (resuelto en una capa, abierto en otra) · **Pendiente**
(comprometido, sin código) · **Fuera por decisión** (Domi lo sacó o lo difirió explícitamente). "FV" = front viejo (`sapira-ai`).

## 1. Bugs del legado

| ID | Bug | Causa raíz | Estado v2 | Dónde (código / test) | Nota |
|---|---|---|---|---|---|
| U1 · S4-3 | Reestructurar reescribe cantidades (overrides, líneas netas; 53 PE) | `invoice_reschedule_items:163` usa `contract_items.quantity` y el front reenvía todo | Cerrado | `reorg` (cambio mínimo, cantidad conservada) · `invoice-reorganize.spec.ts` | La función vieja sigue viva y bugueada para el FV hasta el switch (plan-coexistencia §7.2 sin respuesta) |
| U2 · S4-13 | Validador bloquea por diferencias heredadas (Alicorp) | `check_contract_item_continuity` reparte encabezados | Cerrado | `edit` (conciliador `deviation`, `inherited`) + continuidad por líneas en `reorg` · `invoice-edit.spec.ts` | Idem U1 en el FV |
| U3 | Líneas convertidoras en $0 a Odoo (BAT, CTR-2026-86) | Guard compara la línea consigo misma; moneda de línea CLF en PE CLP | Cerrado | `sched` `calculateInvoiceAmountsAtIssue` por par (MM4) · `invoice-scheduler.service.spec.ts` bloque "MM4"; v2 bloquea `unified_invoice` (`ci` `commonBlockers`) | Las 20 líneas futuras de CTR-2026-86 son dato: no se migran (multimoneda §12) |
| U4 (a)–(e) · D-A | Aplicar cotización: período 1 a 1, ciclo, plazo sin acotar, UPSELL vs CROSS-SELL, facturas no generadas | Inserts inline sin transacción (`AssignToContractModal`, `invoiceCalculator.ts:193`) | Cerrado | `cc` `planItemAdd` / `withQuoteDefaults` / `planItemChange` + `GET /quotes/:id/contract-targets` · `contract-changes.spec.ts` "cross-sell … co-termina", `contract-modifications-b2.spec.ts` "cotización → contrato" | D-A queda obsoleta (v2 al lado, no RPC atómica) |
| U5 · Tanda 3 #1 | Churn usa booking / ítem CHURN parte el día 1 (20 de 51) | `apply_contract_contraction` recibe una fecha y trunca al mes | Cerrado (pendiente de aplicar) | API: espejo `start_date = fecha efectiva`, `churn_date` (`cc` `planItemRemove`) · test "early: espejo … desde la fecha efectiva (U5)". RSM (01-10): `rsm` prorratea el primer mes de CHURN y REACTIVATION por días vivos igual que UPSELL/CROSS-SELL/DOWNSELL · `contract-modifications-block2.spec.ts` "U5" | Asset sin aplicar (`postgres:assets`); verificación en §6 |
| U6 | One shot repetido en cada período | Cronograma ignora `is_recurring` | Cerrado | `be` `generateInvoices` · `billing-engine.spec.ts` "no recurrente: una sola vez" | |
| U7 | Tipo de ítem invisible en el detalle | Front viejo | Cerrado | `contract-items.ts` (`item_type` en ítem madre) · `ContratoItemsTab.test.tsx` | |
| U8 · S5-1 · P1 | Rebuild parcial reinicia el devengo acumulado → deferred inflado (96 contratos) | `rsm` `v_recognized_cum := 0` (solo cargaba el facturado previo) | Cerrado (pendiente de aplicar) | `rsm` (01-10): con `p_from_month` carga el acumulado devengado de la última fila RSM del ítem antes del mes (en moneda del ítem: columna directa, misma moneda o contrato ÷ tasa `item`; sin cola `PENDING_RENEWAL` ni delta del split) y deriva `deferred/unbilled_eom` previos; mes normalizado al día 1 · `contract-modifications-block2.spec.ts` "U8" | Asset sin aplicar; mientras, las 9 llamadas con mes de v2 siguen inflando. Las filas ya infladas se corrigen con un rebuild completo tras aplicar. Huecos #2 |
| U9 · S5-2 · P2 | Lo facturado vía Odoo/DWH no entra al RSM | `trigger_rsm_on_*` leían el holding de la sesión | Cerrado | `fn/trigger_rsm_on_{contract_item,invoice,quantity}_change.sql` (holding de la fila) · `costura-sapira-writer.spec.ts` | La segunda pata ("la API reconstruye tras el webhook") no existe; con el trigger corregido no hace falta |
| U10 · B1 | Upsell/cross-sell con moneda de la cotización y fx 1 | Inserts del front | Cerrado | `cc` `planItemAdd` (moneda del ítem/cotización + par), `mergeTarget` hereda FX de la PE · b2 spec "la moneda del ítem es la de la cotización" | |
| U11 · B2 | IVA del encabezado sin × fx (12 PE) | `sync…:131`, `reschedule…:258` | Cerrado | `ci` `headerAmounts`, `mc` `multicurrencyHeader` · `contract-invoices.spec.ts`, `multicurrency-paths.spec.ts` | |
| U12 · B3 · S6-2 | "Fijo" sin tasa sale a spot en silencio (11 PE) | Guard del scheduler mira solo el contrato | Cerrado | `sched:1243` (se detiene, aviso) + bloqueo `fixed_fx_without_rate` en activar/cambios · scheduler spec | Era "diferido" en saneamiento Capa 2; ya hecho (29-09) |
| U13 · B4 | Sync de cantidades reescribe NC Por Emitir (19 NC) | `fn/sync_invoice_items_amounts_from_quantities.sql` sin filtro `document_type` | Pendiente | sin cambio (grep: no aparece `document_type`) | Solo afecta al FV (v2 no escribe `quantities`); fix compartido aprobado y no hecho |
| U14 | MRR legacy contado dos veces | Dashboard = RSM + `mrr_legacy` sin corte | Parcial | `modules/metrics/*` (sesión Revenue, **sin commit**) aplica el corte D2; `holding-metrics.service.ts:24` sigue sumando | Fuera del módulo `contracts` |
| U15–U18 | Calendario legacy mensual; borrar facturas `migrated`; imports simulados; trigger "Empresa de X" | Funciones legacy S8 | Pendiente | `fn/create_contract_from_mrr_legacy.sql`, `fn/sync_user_on_login.sql:71` sin cambio | Aprobados como "limpieza mínima Fase 1" (S8, 24-09); el rediseño S8 sí está diferido (S8-8) |
| B5 · S7-7 | No se puede corregir un consumo tras anular | Guard mira estado de factura; NC "Vencida" | Cerrado | `cons` `apply_as` (`additional`/`reissue`), void libera consumos · `consumption.service.spec.ts` | |
| B6 · S6-3 | Restablecer: folio fantasma, PE varada, sin traza | `reset_invoice_odoo_draft` | Parcial | F14 `erp-reset` con evento + F6 `send-now` fuera del mes (`ci`) · `contract-invoices.spec.ts` | Borrar el borrador en Odoo por API = Leon (#10) |
| B7 · S7-5 | DWH: ventana solo mes en curso, sin RSM | `bigquery.service.ts` | Pendiente | sin cambio; aún escribe `quantities` | Leon (#11); bloquea el switch (plan-coexistencia §2d) |
| B8 | Skill de IA valoriza sin descuento | `quantity-variation-skills.ts:~88` | Pendiente | sin cambio | Fuera del módulo |
| D1 · 23-09 #1 | Fin de ítem = día 1 / período "1 a 1" | SF sync `inicio + plazo` sin −1; `invoiceCalculator` sin −1 | Parcial | Contratos: `be` `itemEndDate`/períodos `fin = siguiente − 1` y el alta usa `inicio + plazo − 1`, no el fin de la cotización (`drafts:907`, `withQuoteDefaults` no copia `end_date`) · `billing-engine.spec.ts` | **Origen sigue**: `modules/salesforce/services/salesforce-sync-complete.service.ts:1956-1963` (sin −1 y con `Date` local) |
| D2 · Bosch | "Editar ítems" recalcula el fin (ancla corrida) | Trigger `set_contract_item_end_date` en cada UPDATE | Cerrado | Costura: trigger no-op con `sapira.writer`; fin explícito en el INSERT (`ccs:740`) | |
| D3 | Fin de ajustes/espejos ≠ ítem original | Inserts sin amarrar fin; SF | Cerrado | Regla (Domi 01-10): todo ítem relacionado toma el fin de su original salvo fin explícito. `cc` `planItemAdd` (UPSELL de producto existente = fin del `related_item_id`, también desde cotización; `end_date`/`term_months` explícitos mandan), `planItemChange` (ajuste = fin del ítem), `planRenewal` (ajustes que terminan después se absorben y se cortan al fin del madre; los que terminan antes → aviso `adjustment_not_absorbed`; el ajuste de precio sigue al RENEWAL), `planReterm` (absorbe todo ajuste vivo al corte, aviso `adjustment_end_mismatch`), `alignAdjustmentEnds` (pausa/reanudación con extend_term) · tests `contract-changes.spec.ts` "D3/MF-h …" (2), `contract-modifications-b2.spec.ts` "D3/MF-h …" (2), `contract-pause-renewal.spec.ts` "D3/MF-h …" | Reanudación: alineación cubierta por el mismo helper, sin test propio |
| D4 · S3b | Renovación no mueve fin ni TV (27/33) | `create_contract_renewal` v2 | Cerrado | `cc` `planRenewal` + `nearestContractEnd` + bypass · test "crea el RENEWAL … mueve el fin del contrato" | |
| D5 · S4-16 | Último período parcial cobrado completo | Renovación SQL | Cerrado | `be` prorrateo de último período · `billing-engine.spec.ts` "primer 15 → 31 a 17/31 y último 01 → 14 a 14/31" | |
| D6 · S3-16 | Día de ciclo derivado de `MIN(start_date)` (2 copias) | Sin columna | Cerrado | `contracts.billing_anchor_day`, `contract_items.billing_anchor_day` (ciclo propio), `be` `monthsBetween` · b2 spec "ciclo propio" | Día 29–31: `inicio + plazo − 1` da fines 27/28 (regla Postgres replicada a propósito, `billing-engine.spec.ts:45`). Cambiar el ciclo de un ítem vivo: pendiente (§9.7) |
| D7 · S5-16 | Doble prorrateo del primer mes (Bosch 169,95 vs 180,46) | RSM: `final/term` y luego × fracción | Cerrado (pendiente de aplicar) | `rsm` (01-10): mensual = `contract_items.monthly_price` (neto: unitario × cantidad con descuento; CHURN/DOWNSELL = `final/term` = ΔMRR) y la fracción del mes una vez; `final/term` solo de respaldo sin `monthly_price` (pago único) · `contract-modifications-block2.spec.ts` "S5-16" | Asset sin aplicar. Huecos #3 |
| D8 · S2-7 / S1-13 | Booking pisada con hoy / posterior al inicio (55) | `mark_contract_signed_safe` modo auto | Cerrado | `act:779` `COALESCE(booking_date, CURRENT_DATE)`; alta desde cotización (`drafts:1296`) | Espejos y ajustes: `booking_date` = hoy, `start_date` = efectiva (D-CTR-4, deliberado) |
| D9 · S3b | Cross-sell manda la booking como fecha efectiva | `create_contract_cross_sell` | Cerrado | `effective_date` explícita en todo cambio (`cc` `validateChangeRequest`) | |
| D10 · Medios #11 | Vencimiento +30 fijo / NULL / ≤ emisión | Generadores repetidos | Cerrado | `be` `computeDueDate`; F7/F8 recalculan · `billing-engine.spec.ts` "vencimiento" | |
| D11 · F8 | Reprogramar pierde `original_issue_date` | UPDATE directo del front | Cerrado | `ci` reschedule `COALESCE(original_issue_date)` · `contract-invoices.spec.ts` | |
| D12 · S4-11 | Bianual = 1 / 12 / 24 | 3 lógicas de frecuencia | Cerrado | `be:72` `BILLING_FREQUENCY_MONTHS` · test "bianual = 24 meses" | |
| D13 · 22-09 (a) | Merge por fecha exacta mezcla meses | AssignToContract | Cerrado | `cc` `mergeTarget` (mes; ciclo propio = fecha exacta) · b2 spec "mergeTarget" | |
| D14 · S2-1 / Tanda 2 | Vencimiento por fecha del contrato; Expirado nunca corre | `auto_expire_contracts` sin llamador | Cerrado | `contract-status.ts` (estado derivado), `contracts.service.ts:127` `next_item_end_date` | Alertas crecientes al vencer (S5-4): pendiente |
| D15 · S2-13 | Fin del contrato = una sola regla | `contract_end_date` nunca se actualizaba | Cerrado | Decisión de Domi 01-10: **mayor** fin de los recurrentes vivos (indefinido → NULL) en alta/PUT (`drafts` `contractEndDate`), activación (`act` `persist`) y toda modificación (`cc` `Planner.finish`, co-terminación de `planItemAdd`), con el helper `api-written-fields.ts` `latestContractEnd` · tests `api-written-fields.spec.ts` "latestContractEnd…", `contract-changes.spec.ts` "contract_end_date = mayor fin…", `contract-activation.service.spec.ts` | El "próximo vencimiento" de la lista sigue derivado aparte (`next_item_end_date`) |
| D16 | Zona horaria / off-by-one | `Date` locales en el FV | Cerrado | Motor ISO/UTC (`be:297-320`) + "hoy" único `contracts/business-date.ts` `todayFor` (America/Santiago; los holdings no guardan zona) en `ccs` (preview/apply), `cons` (`todayIso`, list, pending), `drafts` `todayIso`, `act` (booking y evento, antes `CURRENT_DATE`), `contract-renewals.service.ts` y `contract-scheduled-changes.service.ts` (jobs), `contract-360.service.ts` · `business-date.spec.ts` | El scheduler de facturas (Leon) ya usaba Santiago (`getBusinessTodayString`) |
| D17 · Complejos #1 | `term` actualizado sin fin (inconsistentes) | Upsell inline | Cerrado | Fin explícito + `term_months` entero (`renewal` exige meses enteros, `cc:2860`) | |
| D18 · Medios #2 | Override 0 cobra de más (CTR-2026-110) | CHECK `> 0` + excepción tragada | Cerrado | F13 "sin cobro" + CHECK `>= 0` (migración `1790630000000`) · `invoice-edit.spec.ts` | En el FV el CHECK nuevo deja la línea en 0 (plan-coexistencia §7.1) |
| D19 · S2-10 | Pendiente de renovar en Cancelados/Borradores | `fn/apply_pending_renewal_tail.sql` no mira estado | Cerrado en el asset (01-10), pendiente de aplicar | v1.3: sin cola en Cancelado/Borrador/En revisión (borra la que hubiera) ni en meses con pausa activa/programada del ítem (abierta o que cubre el fin del mes); ítems con churn ya fuera · `contract-modifications-block2.spec.ts` "asset RSM apply_pending_renewal_tail" | Aplicar el asset (§6) |
| S1-1 · Medios #7 | Número hex / duplicado | `formatContractNumber` + sin UNIQUE | Parcial | `drafts:200,535` correlativo con lock | Por **holding**+prefijo+año (decisión: por compañía); UNIQUE pendiente de 2 datos (Domi) |
| S1-5 | Auto-renovación desmarcada se pisa | `inherit_auto_renew_from_quote_item` | Cerrado (v2) | `drafts:1521` + costura | FV diferido por decisión (25-09) |
| S1-7 · Complejos #4 | `export_type` fijo; renovación en exportación (137/150) | Generadores | Cerrado | `tax_document_types` + `be` `suggestDocumentType` | Matriz fiscal completa (ND, PPD/PUE) pendiente |
| S1-10 / S1-11 | Agrupación no guardada; cuotas sin redondeo | Wizard | Cerrado | `group_invoices_by_period`; `be` redondeo a la última · test "trimestral … la diferencia en la última" | |
| S2-6 · S2-11 | Activo sin facturas / sin `tax_rate`; historial doble; reactiva Cancelados | Triggers de activación | Cerrado | `act` bloqueos `no_tax_rate`, `not_draft`, `no_invoices`; un evento `ACTIVATION` · `contract-activation.service.spec.ts` | |
| S3 · ROADMAP #9 | IVA 19 % fijo (129 MX, 37 PE) | `AssignToContractModal.tsx:575` | Cerrado | `cc` `taxRateFor` = `taxRateForDocument` · test "taxRateFor (modificaciones)" | |
| S3 · ROADMAP #10/#11 | Contracción cancela la PE entera; NC en moneda equivocada (13) | `apply_contract_contraction:400,430` | Cerrado | `cc` `removeItemFromInvoices` + `insertMirrorCreditNote` por línea (`ccs:1980`) | |
| S3-7 / STG | Downsell del 100 %; dos ejes pierden el término cruzado | RPC | Cerrado | `cc:3737,3926`; `unifiedDelta` · test "STG-38 … +51,20" | |
| S3b / S04191 | Upsell sin evento ni usuario (duplicados) | `created_by` no enviado | Cerrado | Evento siempre + `possible_duplicate` + `Idempotency-Key` (`ccs`) | |
| S4a · Complejos #3 | `standardize` pisa montos | Trigger BEFORE INSERT | Cerrado (v2) | Costura en `fn/standardize_invoice_items.sql`; patrón B retirado | Sigue activo para el FV |
| S4 / S6 | FX clonado de la última factura (79 PE) | `sync`/`reschedule` | Cerrado | `mc` `revalueByPair` (nunca clona) · `multicurrency-paths.spec.ts` | Backfill de las 79 = dato (S4-12) |
| S4b | Desunificar borra sin mirar Odoo; pierde OC/HES | `unify_invoices_multi_contract` | Cerrado | `contract-invoice-consolidation.service.ts` (deshacer = Cancelada, bloquea con borrador) · su spec | |
| S4 · 30-09 | NC "Vencida" (26) → no ajustaban devengo | `check-overdue-invoices` no excluye NC | Cerrado (v2) | NC v2 nacen sin `due_date` (`ccs:2045`); `nc_discount_revenue_adjustment` cuenta todo estado emitido | Los 26 estados del FV: a criterio de Domi |
| S5-10 / P3 | FX faltante = 1,0 silencioso | `revenue_schedule_apply_fx_for_contract` | Cerrado (pendiente de aplicar) | Tasa ítem→contrato: NULL + `missing_fx_rate` (`rsm`, `fn/contract_item_fx_rate.sql`). Compañía/sistema (01-10): sin tasa, columnas convertidas y `fx_contract_to_*` NULL, `fx_to_*_source` y `calc_version` `missing_fx_rate`; directas (`item_currency_direct`) intactas · `fx-model.spec.ts` "S5-10" | Asset sin aplicar. La inversa fija del holding ya no queda tapada por el 1,0 de la directa |
| §1 Seguridad | Funciones `SECURITY DEFINER` abiertas a `anon` | Grants a PUBLIC | Parcial | v2 = `HoldingScopeGuard`; `grants/020` (recalc); `migrate…` dropeada | `approve_contract_amendment` sin REVOKE; `grants/030` (generate_missing) escrito y **sin aplicar** |

**Modificación → facturas** (pedido de Domi 01-10; cada fila verificada en código y tests):

| ID | Bug | Causa raíz (legado) | Estado v2 | Regla v2 (código / test) | Nota |
|---|---|---|---|---|---|
| MF-a | La modificación no toca las Por Emitir | Inserts inline sin transacción (`UpsellingModal`, `AssignToContractModal`); `approve_contract_amendment` → `recalc_revenue_for_contract` borra el cronograma; contrato En revisión → `generate_missing_invoices_for_contract` se salta (22-09 c); `sync_invoices_for_contract_item` bloquea con variables | Cerrado | Cada `plan*` de `cc` escribe sobre las PE activas en la misma transacción (`removeItemFromInvoices`, `addGeneratedInvoices`, `mergeTarget`, línea neta) · `contract-changes.service.spec.ts` (orden ítems → facturas → contrato → RSM → evento) | `item_add` solo en Activo (S3-1) elimina el caso En revisión |
| MF-b | "Aplanar" cantidades (`1 × total`, una cifra pisa tramos o líneas) | `invoice_reschedule_items` (CEFA 1 × 1.000), `sync_invoices_for_contract_item` (`1 × monto`, Tanda 1 #3), `standardize_invoice_items` | Cerrado | Estándar: línea neta (`cc` `planItemChange`); consumo conserva la cantidad (`repriceConsumptionLine`); `reorg` conserva cantidad. **Modelo de precio** (tramos fijos, `per_tier`/`single`): `cc` `planItemChange` + `pricedItemInvoicesByPeriod` + `Planner.mergePricedLines` re-tarifan con el motor (`pricedMonthlyEquivalent`, `generateInvoices`) a la cantidad nueva: se quitan las filas del grupo y entran las del motor con su `pricing_breakdown` (respeta `invoice_line_mode`); rige desde el próximo período (`priced_item_from_next_period`) y avisa si el unitario pedido no es el del motor (`priced_item_engine_price`) · tests `contract-changes.spec.ts` "MF-b / Huecos #4b …" (per_tier 10 → 20, single, downsell) | Con consumo registrado en filas `per_tier` sigue el camino de consumo (una fila) |
| MF-c | No respeta lo editado a mano en la PE | Regeneradores y sync reescriben por posición (Tanda 3 #2 pisó glosas de Carelis) | Cerrado | `cc` `keepManual` (`quantity_source = 'manual'` → aviso `manual_edit_kept`, `cc:1379`); glosa `description_locked` intacta (`ccs:848`, `item_update` `cc:5445`); tasa fijada por factura → `invoice_fx_kept` (`cc:4468`) y `update_line` valoriza con la tasa de la factura o de la línea (`ccs:836`); el descuento puntual vive en una línea editada (manual) · tests "la baja no quita ni reescribe una línea editada a mano", "billing_conditions FX: … se saltan … las de tasa fijada por factura", "vacío → NULL; no regenera glosas protegidas, editadas a mano…" | La línea manual queda **sin** el cambio (aviso, no bloqueo): se ajusta desde la factura |
| MF-d | `item_add` no suma la línea a la PE del período | AssignToContract fusiona por fecha exacta sin excluir unificadas; renovación SQL nunca fusiona | Cerrado | `cc` `mergeTarget` (receptor, moneda, documento, mes; excluye unificadas, facturadas por OC y NC) · tests "cross-sell … se suma a la PE del mes", "tramo inicial suelto (S3-17) … diciembre sí" | Ciclo propio: solo con la misma fecha exacta |
| MF-e | Upsell por cantidad crea un segundo ítem y una segunda línea | `UpsellingModal`: ítem UPSELL + línea propia | Cerrado (diseño) · test parcial | Ítem de ajuste siempre (trazabilidad, S3-14); línea propia por defecto, neta con `items[].net_line: true` u obligatoria con consumo (`cc:4051`) · API: solo test de neta por consumo (`contract-changes.spec.ts:1153`); front `lib/schemas/contratos-cambios-schemas.test.ts` | Falta test API de `net_line: true` en upsell sin consumo |
| MF-f | Downsell no reduce la PE / no acredita lo emitido | `apply_quote_downsell_to_contract` (NC por días, sin prorrateo del período); `apply_contract_contraction` cancelaba la PE entera | Cerrado | `item_change` DOWNSELL desde el próximo inicio de período con la línea base al neto (`cc:4051-4100`); emitida después del corte → bloqueo `issued_after_effective_date` con fecha sugerida (sin NC, S3-5/6); `item_remove`/`contract_cancel` → NC espejo proporcional (`ccs` `insertMirrorCreditNote`) · tests "downsell rige desde el próximo inicio de período…", "bloquea si ya está facturado en firme…", "emitida con período después de la fecha → NC espejo…" | |
| MF-g | Renovación sin facturas nuevas ni extensión de FX | `create_contract_renewal` (export 1, +30, una llamada por ítem); la tasa fija de todo el contrato no se extendía | Cerrado | `cc` `planRenewal` (generador v2 + fusión) y `extendWholeContractRates` (`cc:2732`) · tests "crea el RENEWAL … genera las facturas nuevas", "tasa única que cubría todo el contrato → extend_fx_rates", "tasas por período sin cobertura → fixed_fx_without_rate" | |
| MF-h | El fin de los ítems relacionados no sigue al padre | = D3 | Cerrado | = D3 | |

## 2. Casuísticas de uso normal

| Caso | Flujo v2 (intención · endpoint) | Estado | Test que lo cubre |
|---|---|---|---|
| Alta manual / desde cotización con FX, condiciones, documento, ciclo | Wizard · `POST /contracts` (+`/preview`, `form-options`) | Cerrado | `contract-drafts.service.spec.ts`, `contract-pricing.spec.ts`, front `nuevo/*.test.tsx` |
| Editar borrador | `GET /:id/form`, `PUT /:id` | Cerrado | `contract-drafts.service.spec.ts` (PUT) |
| Activar uno o masivo | `POST /contracts/activate(/preview)` | Cerrado | `contract-activation.service.spec.ts` |
| Ítem sin término (M5) | Alta con `term_months` NULL + job `contracts-extend-horizon` | Cerrado (01-10) | `billing-engine.spec.ts` "sin término … horizonte de 12 períodos"; el job diario (05:45) extiende las Por Emitir a 12 períodos desde hoy · `contract-horizon.spec.ts`, `contract-changes.service.spec.ts` "extendHorizonForHolding" |
| Flex caso 1 · facturar distinto (editar borrador) | Vista rápida › Editar · `PUT …/invoices/:id` | Cerrado | `invoice-edit.spec.ts`, `contract-invoice-edit.service.spec.ts` |
| Flex caso 2 · multimoneda | Alta con `requires_multicurrency_billing`, `multicurrency{enabled}`, `item_add.currency` | Cerrado | `multicurrency.spec.ts`, `multicurrency-paths.spec.ts`, `billing-engine-multicurrency.spec.ts` |
| Flex caso 3 · % por razón social (ruta declarada A.5) | — | Pendiente | Fuera de los bloques (multimoneda §12; `contract_billing_splits` sin uso) |
| Flex caso 4 · modificar simple con preview | "Modificar contrato" por intención · `POST /:id/changes(/preview)` | Cerrado | `contract-changes.spec.ts`, `ModificarContratoDrawer.test.tsx` (front **sin commit**) |
| Flex caso 5 · reglas blandas con motivo | Advertencias → 400 sin `reason` | Cerrado | `contract-changes.service.spec.ts` |
| Flex caso 6 · OC por monto cerrado | `POST …/:id/partial-by-po(/preview)` | Parcial | `invoice-partial-po.spec.ts`; mapper Odoo omite internas (scheduler spec); recálculo de consumo sobre OC = solo aviso |
| §2.1 Cambiar precio/cantidad (upsell, downsell, renegociación) | `item_change` | Cerrado | `contract-changes.spec.ts` "item_change (M1 …)" |
| §2.1a / §9.3.7 Cambiar frecuencia o plazo | `item_change` + `billing_frequency`/`term_months` | Cerrado | b2 spec "item_change con frecuencia o plazo" |
| §2.2 Agregar producto (cross-sell / upsell / otra moneda / cotización) | `item_add` | Parcial | `contract-changes.spec.ts` "item_add"; el fin del UPSELL no co-termina con su relacionado (Huecos #4) |
| §2.3 Quitar un producto (early / al terminar) | `item_remove` | Cerrado | "item_remove (M2)" |
| §2.4 Acortar ("Terminar antes") | `item_remove` non-renewal | Cerrado | "non-renewal (efectiva después del fin)" |
| §2.5 Renovar (N ítems, mismo o nuevo precio, extensión de FX) | `renewal` | Cerrado | "renewal (M3 …)", b2 "renewal con precio nuevo", "extensión de tasas" |
| §2.5 / §9.3.5 Auto-renovación con confirmación | Job `contracts-auto-renewal` 06:00 · `GET /contracts/renewal-proposals`, `…/dismiss` | Cerrado | `contract-renewals.service.spec.ts`, `contract-pause-renewal.spec.ts` "jobs" |
| §2.6 Pausa / reanudación por ítem | `pause` / `resume` | Cerrado | `contract-pause-renewal.spec.ts` |
| §2.7 / §9.3.1 Terminar con decisión por factura | `contract_cancel` + `invoice_decisions` | Cerrado | b2 "contract_cancel con decisiones por factura" |
| §9.3.2 Reactivar (3 ramas) | `reactivate` | Cerrado | b2 "reactivate (a)/(b)/(c)" |
| §2.8 / §9.3.6 Ajustes pactados (%, IPC/UF, precio en fecha, cada N meses) | `…/scheduled-changes` + job 05:30 | Cerrado | b2 "ajustes pactados", `contract-scheduled-changes.service.spec.ts` |
| §2.9 Cambiar moneda del contrato activo | — | Fuera por decisión | Se resuelve con multimoneda (§9.1) |
| §2.10 Cambiar razón social (existente o nueva) | "Modificar facturación" · `change_entity` | Cerrado | "change_entity (M5)", b2 "new_entity" |
| §2.10 Cliente comercial / compañía emisora | — | Fuera por decisión | §9.1 #10 y §2.10b (intercompañía) |
| §2.11 Condiciones (pago, ERP, emisión, T&C, documento, agrupación, auto_renew) | `billing_conditions` | Cerrado | "billing_conditions (fase A)", `contract-pause-renewal.spec.ts` "auto_renew" |
| §9.2 Cuenta de un producto | `item_update` | Cerrado | "item_update (§9.2 …)" |
| Corrección de carga en contrato Activo (glosa, tipo, cantidad/precio por error; F4) | `item_update` = "Corregir un dato mal cargado" (spec modificaciones §9.2.1) | Cerrado (01-10) | `contract-changes.spec.ts` "item_update · corregir un dato mal cargado", `contract-changes.service.spec.ts` "corrección de cantidad…"; front `intenciones.test.ts`, `ModificarContratoDrawer.test.tsx` |
| Mover fechas de inicio en masa (`bulk_restructure_contract_start_dates`) | — | Fuera por decisión (Domi 01-10) | No se usa; no pasa a v2. Se dropea al switch sin sustituto |
| Facturas §3.1 Enviar ahora / emisión externa | `…/send-now`, `…/mark-issued` | Cerrado (Retirar del ERP: Leon) | `contract-invoices.spec.ts` |
| Facturas §3.2 FX por factura / masivo / neto exacto / por par | `…/fx`, `…/fx-bulk` | Cerrado | `contract-invoices.spec.ts`, `multicurrency-paths.spec.ts` |
| Facturas §3.3 Reprogramar (una, siguientes, masivo) | `…/reschedule`, `…/reschedule-bulk` | Cerrado | `contract-invoices.spec.ts` |
| Facturas §3.4 Editar PE, desvíos, descuento puntual, sin cobro, ERP reset | `PUT …/invoices/:id`, `…/deviation`, `…/erp-reset` | Cerrado | `invoice-edit.spec.ts`, `one-off-discount.spec.ts` |
| Facturas §3.5 Reorganizar | `…/invoices/reorganize(/preview)` | Cerrado | `invoice-reorganize.spec.ts` |
| Facturas §3.6–3.7a Descripción y OC/HES | `…/invoice-description-template`, `…/references` | Cerrado | `invoice-description.spec.ts` |
| Facturas §3.8 Anular y reemitir / NC de descuento | `…/void`, `…/credit-note` | Parcial | `invoice-void.spec.ts`; **la NC no se emite a Odoo como `out_refund`** (Huecos #1) |
| Multimoneda §7 Consolidación para socios | `/contracts/invoices/consolidations*` | Cerrado | `invoice-consolidation.spec.ts` |
| Pricing: modelos, catálogo, consumos (`apply_as`) | `/prices`, `/billable-metrics`, `…/consumption*` | Cerrado (lo básico) | `pricing-engine.spec.ts`, `prices.service.spec.ts`, `consumption.spec.ts`. Domi 01-10: lo básico está: un consumo actualiza la factura del período y el devengo (rebuild tras `consumption.service`), hoy vía override. El canal DWH (carga automática de consumos) y el detalle del cálculo por modelo se profundizan en la sesión del módulo Precios |
| Spec renovación R4 · carga masiva de pactos | — | Fuera por decisión | Domi 01-10: fuera de Contratos; se ve en la sesión de onboarding / carga legacy |

## 3. Mejoras adicionales comprometidas

| Mejora | Fuente | Estado | Bloque donde entra |
|---|---|---|---|
| Moneda y FX de facturación al crear | M1 · S1-3 | Cerrado | este |
| Modificaciones unificadas y simples | M2 · A.4 | Cerrado (front sin commit) | este |
| Multimoneda real | M3 · S4-5 | Cerrado | este |
| Tipo de documento por país | M4 · S1-7 | Parcial (ND, PPD/PUE, matriz fiscal) | Facturación |
| Término indefinido | M5 · #25 | Cerrado (job `contracts-extend-horizon`, 01-10) | este |
| Granularidad de devengo / RSM central / consolidación / FX de lo facturado | M6–M9 · S5-5..S5-15 | Pendiente | Revenue-Métricas |
| Intercompañía y compañía emisora | M10 · S5-12 | Fuera por decisión | después del switch |
| Compañías: tax rates, cuentas | M11 | Pendiente | Configuración (después del switch) |
| Devengo de no recurrentes elegible | M12 · S1-6 | Pendiente | Revenue-Métricas |
| Budget / reporte de vendedores | M13 · M14 | Pendiente | Revenue-Métricas |
| Onboarding / Historia del cliente | M15 · S8 | Fuera por decisión (al final) | después del switch |
| Quitar workflow y aprobaciones | M16 · S1-9 · S3-10 | Cerrado | este |
| Pausa por ítem | Complejos #9 · S2-12 | Cerrado (masiva y `scope billing`: pendiente §9.7) | este |
| Preview antes de persistir | Complejos #7 | Cerrado | este |
| Propagar fin y TV al encabezado | Complejos #8 | Parcial (dos semánticas, D15) | este |
| Descuento puntual con tratamiento NC | Complejos #5 | Cerrado | este |
| Variables con factura emitida | Complejos #2 · S7-8 | Cerrado | este |
| Notificaciones de renovación y pactos | Complejos #10 · §9.6b | Parcial (cerrar al confirmar, alertas crecientes) | este |
| Sesión RSM (sub-bugs B/C, md5, duplicados, overrides) | Complejos #6 | Pendiente | Revenue-Métricas |
| Fallos silenciosos al enviar → bloqueos | Medios #1 | Cerrado en el 360 (`send-now` blockers) | este |
| FX visible por factura · "Tipo de cambio: 1" | Medios #5 · Tanda 2 | Cerrado | este |
| Correlativo de contratos | Medios #7 | Parcial (UNIQUE) | este (dato de Domi) |
| Términos de pago | Medios #11 | Cerrado | este |
| Renegociación mixta | Medios #12 | Cerrado | este |
| Cambiar razón social | Medios #13 | Cerrado | este |
| Filtro "próximos a vencer" por ítem · redondeo | Tanda 2 | Cerrado | este |
| Cuenta en la glosa · textos manuales protegidos | Tanda 3 #2 · 15-16 sep | Cerrado (`description_locked`) | este |
| Agrupación al asignar cotización | 15-16 sep | Cerrado (`group_invoices_by_period` heredado por `item_add`) | este |
| Consolidar líneas iguales solo en el DTE | 25-28 ago | Pendiente | Facturación (Leon) |
| Modelos de pricing por tramos | Estratégico #20 · S7-10 | Cerrado (mínimo anual y línea medida sin consumo: preguntas 1 y 3 abiertas) | este |
| Ruta de facturación declarada | A.5 · flex caso 3 | Pendiente | después del switch |
| ND · NC real a Odoo | S4-8 · S4-9 | Pendiente | Facturación (Leon) |
| Retirar del ERP por API · refresco de glosa al emitir · límites MX/PE | Facturas §6/§8 | Pendiente | Facturación (Leon) |
| Mover PE no emitidas al mes siguiente al cierre | S6 propuesta 6 | Parcial (reprogramar masivo; sin aviso de cierre) | Facturación |
| Equivalente indicativo spot | Multimoneda §12 · flujo §6 | Pendiente | Revenue-Métricas |
| KPIs de la lista y el resumen en moneda sistema | Multimoneda §12 · flujo §6 | Corregido: la lista y el resumen leen `mrr_period_system_ccy` del RSM (`contracts.service.ts`); queda solo el respaldo local `draftMrr` de un borrador mientras llega la vista previa del motor | Cerrado |
| Revalorizar la tasa `item` como modificación | Multimoneda §12 | Pendiente | este |
| Cambiar ciclo de un ítem vivo | §9.7 | Pendiente | este |
| Editar un consolidado en sitio | Multimoneda §7 (g) | Pendiente | este |
| Preguntas IPC (acumulado, desfase, redondeo, CMRR pactado) | Renovación §7 #2–#5 | Parcial (construido con la propuesta, sin confirmar) | este |
| KPI "Renuevan en 30 días" en la lista | §9.6b | Cerrado: lo cubre el KPI "Vencen en 30 días" de la lista (decisión de Domi 01-10) | este |
| Dedup import legacy, partner Odoo al crear razones | Carril León | Pendiente | después del switch |

## 4. Funciones, triggers y crons del legado

Estados de hoy: **no-op** (costura `sapira.writer = 'api'`, 23 funciones con el guard, `grep -l sapira.writer fn/*.sql`) · **invariante** (corre
siempre) · **activo FV** (solo lo usa el front viejo) · **desprogramado**. Destino: **drop** (switch o baja, con doble confirmación) o **se mantiene**.

| Objeto | Hoy | Destino | Reemplazo v2 | Confirmado en código |
|---|---|---|---|---|
| `bulk_activate_contracts`, `mark_contract_signed_safe` | activo FV | drop al switch | `act` `POST /contracts/activate` | sí (`fn/*.sql` presentes; v2 no los llama) |
| `generate_missing_invoices_for_contract` | activo FV (llamada por trigger y por rpc Legacy) | drop tras la baja; REVOKE (`grants/030`) sin aplicar | generador `be` en la activación | sí |
| `trigger_generate_invoices_on_contract_signed` (trigger `unified_…`) | no-op | drop tras la baja | idem | sí; el duplicado `generate_invoices_on_contract_active` ya **dropeado** (migración `1790660000000`) |
| `trigger_generate_invoices_on_status_change` (función) | no-op, sin trigger | drop | — | sí (asset con guard) |
| `regenerate_contract_invoices_from_items` / `_for_restructure` | activo FV / sin llamador | drop al switch / ya (doble confirmación) | v2 no escribe `contract_invoices` | sí |
| `bulk_restructure_contract_start_dates` | activo FV | drop al switch (Domi 01-10: no pasa a v2) | ninguno, por decisión | sí |
| `auto_expire_contracts`, `update_pending_invoices_on_override`, `generate_invoices_for_contract_item`, `cancel_invoice_with_credit_note`, `admin_populate_revenue_schedule`, `revenue_schedule_rebuild_for_invoice` | sin llamador | drop "AHORA" (plan-coexistencia §3.5), **no ejecutado** | estado derivado / F16 | sí (los 6 assets siguen en `fn/`) |
| `create_contract_cross_sell` + `approve_contract_amendment` + `recalc_revenue_for_contract` + `reconcile_contract_status` | activo FV (`recalc` sin EXECUTE de roles) | drop al switch | `item_add` | sí; `approve_contract_amendment` **sin REVOKE** |
| `apply_quote_downsell_to_contract`, `apply_contract_contraction` | activo FV | drop al switch | `item_change` / `item_remove` / `contract_cancel` | sí |
| `create_contract_renewal` + `process_auto_renewals` + `execute_auto_renewal_for_item` + `get_items_pending_auto_renewal` | activo FV (renovación manual); cron **desprogramado** | drop al switch | `renewal` + `contracts-auto-renewal` | sí (unschedule en migración `1790700000000`; asset del cron borrado) |
| `apply_renewal_price_split` | invariante de facto: la llama `rsm:469` para renovaciones con `renewal_base_unit_price` | **se mantiene hasta el switch**; ahí una migración de datos convierte esas renovaciones al modelo v2 (RENEWAL al valor anterior + ítem de ajuste), rebuild del RSM, y se dropean la función y la llamada (Domi 01-10) | v2 guarda dos ítems | sí |
| `change_contract_currency`, `change_contract_commercial_client` | activo FV (la 1ª con guard de multimoneda) | drop al switch | `PUT /:id` / fuera por decisión | sí |
| `sync_invoices_for_contract_item`, `invoice_reschedule_items`, `check_contract_item_continuity` | activo FV (U1/U2 vivos) | drop al switch | `reorg`, `edit`, cambios | sí |
| `consolidate_invoices_simple`, `unconsolidate_invoices_simple`, `unify_invoices_multi_contract` | activo FV | drop al switch de Facturación | multimoneda + consolidación v2 | sí |
| `apply_fixed_fx_to_contract`, `bulk_confirm_fx_policy` (filtra `purpose = company`) | activo FV | drop al switch | `…/fx`; configuración de compañías | sí |
| `edit_pending_invoice`, `adjust_issued_invoice`, `emit_invoice_manually`/`_safe`, `reschedule_invoice_safe`, `get_next_invoice_number`, `create_credit_note_safe`, `invoice_items_bulk_update_description`, `invoice_bulk_update_terms`, `invoice_reassign_entity`, `reset_invoice_odoo_draft` | activo FV (Facturación) | drop al switch de Facturación / tras la baja | F7, F8, F9, F11, F14, F16, F17 | sí |
| `populate_initial_revenue_schedule` | activo FV (Revenue) | drop tras la baja | — | sí |
| `validate_fx_confirmation_before_firmado` (+ trigger) | no-op y nunca se dispara | drop (doble confirmación) | — | sí |
| `standardize_invoice_items`, `auto_populate_invoice_item_fields`, `sync_invoice_item_contract_id`, `auto_populate_invoice_tax_rate`, `auto_populate_invoice_fx_to_system`, `invoices_fill_terms_from_contract`, `assign_invoice_group_id` | no-op | drop tras la baja | `api-written-fields.ts` (`refreshInvoiceSystemAmounts`, etc.) | sí (`api-written-fields.spec.ts`) |
| `set_contract_item_end_date`, `inherit_auto_renew_from_quote_item`, `trg_set_contract_item_categoria`, `auto_calculate_pricing_fields`, `update_contract_term`, `set_booking_date_on_activate`, `set_contract_company_currency`, `auto_calculate_contract_fx`, `trg_audit_contract_changes` | no-op | drop tras la baja | `pricingFields`, `syncContractTerm`, activación | sí |
| `trigger_revenue_schedule_on_contract_activation`, `trigger_rsm_on_*` (3) | no-op para v2; U9 para el FV | drop tras la baja | rebuild explícito | sí |
| `trg_00_period_guard_*`, `validate_contract_currency_consistency`, `validate_contract_item_currency_consistency`, `prevent_end_date_update_when_active` | invariante (reescritos los de moneda para multimoneda) | **se mantienen** | — | sí (`costura-sapira-writer.spec.ts`) |
| `revenue_schedule_rebuild`, `_contract_ccy`, `revenue_schedule_apply_fx_for_contract`, `contract_item_fx_rate`, `nc_discount_revenue_adjustment`, `calculate_contract_fx_rate`, `calculate_system_fx_rate` | invariante / núcleo | **se mantienen** (v2 depende) | — | sí: son las **únicas** funciones que v2 invoca (`grep "SELECT … ("` en `modules/contracts`: `revenue_schedule_rebuild` ×10 y `calculate_system_fx_rate` ×1) |
| `apply_pending_renewal_tail`, `refresh_all_pending_renewals` + cron `refresh-pending-renewals` (06:00) | activo para ambos (sin costura) | se mantiene hasta la sesión RSM | — | sí (S2-10 corregido en el asset v1.3, sin aplicar) |
| `quantities` + `sync/restore_invoice_items_amounts…`, `validate_invoice_status_for_quantity_change`, `quantities_set_holding…`, `restore_rsm_on_quantity_delete` | activo FV + DWH | solo lectura al switch; drop tras la baja | `consumption_entries` | sí (U13 sin corregir) |
| `contract_lifecycle_events` + 3 triggers `updated_at` | activo ambos | se mantiene; unificar los 3 (#9) **no hecho** | — | sí (`triggers/set_updated_at_on…`, `trg_lifecycle_events_update…`, `update_contract_lifecycle_events_updated_at`) |
| `contract_invoices` (+ `trg_cancel_schedule_on_contract_cancelled`), `contract_amendments`, `workflow_steps` | activo FV | solo lectura al switch; drop tras la baja | preview en memoria; eventos | sí (v2 no los escribe) |
| cron `check-overdue-invoices-daily` | activo | se mantiene (no toca NC v2: sin `due_date`) | — | sí |

**Respuesta directa**: todo lo marcado "drop" puede eliminarse sin afectar a v2: el código del módulo `contracts` solo invoca el núcleo del RSM
(`revenue_schedule_rebuild` → `_contract_ccy` → `apply_fx`, `contract_item_fx_rate`, `nc_discount_revenue_adjustment`, `apply_renewal_price_split`)
y `calculate_system_fx_rate`, y se apoya en los 4 invariantes. Dos correcciones a la lista del plan: **`apply_renewal_price_split` no se puede
dropear** mientras el RSM la llame, y **`bulk_restructure_contract_start_dates`** no tiene sustituto (fuera por decisión); la corrección de ítems activos (F4) ya lo tiene (`item_update`, 01-10).

## 5. Huecos encontrados (no cubiertos ni diferidos explícitamente), por riesgo

| # | Riesgo | Hueco | Evidencia | Propuesta |
|---|---|---|---|---|
| 1 | ✅ Cerrado | La NC espejo v2 nacía **Por Emitir** y el scheduler diario no filtraba `document_type` | `sched` `getInvoicesToSend` excluye `NC`/`ND`; `sendInvoiceById` → 409 `credit_note_send_pending`; `ci` `planSendNow` + `contract-invoices.service.ts` `sendNow` → mismo 409. Decisión 01-10: las NC de la API nacen siempre `Emitida`, nunca Pagada/Vencida (`contract-360.ts` `creditNoteStatusFor`, `ccs` `insertMirrorCreditNote`, con referencia), "pendiente de emisión electrónica" (`creditNotePendingEmission`, `contracts.service.ts` `electronicEmissionOf`) | Cerrado 01-10 · tests `invoice-scheduler.service.spec.ts` "Huecos #1 …", `contract-invoices(.service).spec.ts`, `contract-changes.service.spec.ts`, `consumption.service.spec.ts`, `contract-invoice-void.service.spec.ts`; entrada 5 de `cambios-integracion-para-leon.md` |
| 2 | 🔴 Alto | ~~U8 sigue abierto y **v2 lo dispara** en cada cambio, consumo y edición (rebuild parcial)~~ Cerrado en el asset 01-10, pendiente de aplicar | `rsm` (carga del acumulado previo); 9 llamadas con mes | Aplicar el asset (§6) antes de abrir Modificaciones a usuarias |
| 3 | 🔴 Alto | ~~Doble prorrateo del primer mes (S5-16) y CHURN sin prorrateo (U5)~~ Cerrado en el asset 01-10, pendiente de aplicar | `rsm` (mensual = `monthly_price`; CHURN/REACTIVATION prorratean) | Aplicar el asset (§6) |
| 4 | ✅ Cerrado | `item_add` UPSELL co-terminaba con el contrato; `renewal`/reterm ignoraban los ajustes con fin distinto | = D3 | Cerrado 01-10: `cc` `planItemAdd`, `planRenewal`, `planReterm`, `alignAdjustmentEnds` (ver D3) |
| 4b | ✅ Cerrado | `item_change` sobre un ítem con modelo de precio aplanaba las filas por tramo y dejaba el desglose viejo | = MF-b | Cerrado 01-10: `cc` `planItemChange` + `pricedItemInvoicesByPeriod` + `Planner.mergePricedLines` (ver MF-b). El ajuste sigue sin `price_id` (su valor es el delta del motor) |
| 5 | ✅ Cerrado | `contract_end_date` con dos semánticas | = D15 | Cerrado 01-10 con la regla "mayor fin vivo" (decisión de Domi, no "más próximo"): `api-written-fields.ts` `latestContractEnd` en `drafts`, `act` y `cc` `Planner.finish` |
| 6 | ✅ Cerrado | Indefinidos: se facturan 12 períodos y nada genera los siguientes | mapa §3 "queda para un bloque posterior" sin bloque | Cerrado 01-10: job `contracts-extend-horizon` (05:45, `contracts.scheduler.ts`; `cc` `planHorizonExtension`, `ccs` `extendHorizonForHolding`), evento `HORIZON_EXTENDED` |
| 7 | ✅ Cerrado | Paridad para el switch: corrección de ítems en Activo (F4) y mover fechas en masa sin sustituto | plan-coexistencia §4 | Cerrado 01-10: F4 = `item_update` "Corregir un dato mal cargado" (spec modificaciones §9.2.1); mover fechas en masa fuera por decisión |
| 8 | ⚪ Cerrado por decisión | Limpieza mínima del legado (U13 FV, U14–U18, REVOKE de `approve_contract_amendment` y `grants/030`, 6 retiros "AHORA", #9 `updated_at`) | §1 de este doc | **Domi 01-10: no se hace.** Nada de eso se usa en v2; se dropea todo junto al switch, sin sesión de saneamiento intermedia |
| 9 | 🟡 Bajo | SF sigue guardando el fin de la cotización sin −1 y con `Date` local; Cotizaciones v2 lo muestra | `salesforce-sync-complete.service.ts:1956-1963` | `inicio + plazo − 1` con aritmética ISO (`be` `itemEndDate`) |
| 10 | ✅ Cerrado | "Hoy" en UTC (cambios, consumo, 360) vs local (alta) | = D16 | Cerrado 01-10: `contracts/business-date.ts` `todayFor` (ver D16) |
| 11 | 🟡 Bajo | ~~FX faltante a compañía/sistema sigue en 1,0 (S5-10)~~ Cerrado en el asset 01-10, pendiente de aplicar | `fn/revenue_schedule_apply_fx_for_contract.sql` (NULL + `missing_fx_rate`) | Aplicar el asset (§6) |
| 12 | 🟡 Bajo | `apply_renewal_price_split` listada para retiro pero el RSM la invoca | `rsm:469` | Corregir plan-coexistencia §5 |
| 13 | 🟡 Bajo | Correlativo por holding (decisión: por compañía) | `drafts:535` | Confirmar con Domi o agregar `company_id` a la clave del lock |
| 14 | ⚪ Doc | `flujo-y-funciones.md` §4–§5 aún describe el patrón B y "costura cuando F4"; saneamiento Capa 2 y mapa §2f desactualizados (plan-coexistencia §6) | front `lab/contratos/flujo-y-funciones.md:101-104` | Actualizar con la costura y la lista de este doc |

## Resumen ejecutivo

1. Contratos v2 cubre lo comprometido para **alta, activación, facturas del 360, multimoneda y modificaciones**: de 38 casuísticas, 27
   cerradas y 5 parciales con test; existen los casos de flexibilidad 1, 2, 4, 5 y 6 (el 3, ruta declarada, sigue pendiente).
2. De los bugs del legado, la mayoría se evitan de raíz en la API (U1–U4, U6, U7, U9–U12, B5, 13 bugs de fechas y 6 de los 8 de
   modificación → facturas; abiertos: aplanado en ítems con modelo de precio y fin de ajustes UPSELL). El resto de lo abierto vive
   fuera del módulo: **RSM** (U8, doble prorrateo, CHURN sin prorrateo, FX 1,0: corregidos en los assets el 01-10, pendientes de aplicar), **FV** (U13, U15–U18) e **integración** (B6, B7, NC a Odoo).
3. Huecos #1 (NC enviadas como factura), #4, #4b, #5 y #10 quedaron **cerrados el 01-10** (ver tabla 5). Mayor impacto
   contable: **v2 llama el rebuild parcial que infla el deferred (U8)** y hereda el doble prorrateo;
   cerrarlos antes de abrir Modificaciones.
4. Fechas: el motor es consistente (ISO/UTC, `fin = siguiente − 1`, ciclo explícito, último período proporcional); desde el 01-10 los ajustes
   siguen el fin de su ítem, `contract_end_date` = mayor fin vivo en todo camino y "hoy" = `todayFor` (America/Santiago).
5. Legado: todo lo marcado para eliminar puede caer sin tocar v2 (v2 solo usa el núcleo RSM, `calculate_system_fx_rate` y los invariantes),
   salvo `apply_renewal_price_split`, que el RSM sigue llamando. F4 cerrado 01-10 (`item_update`); mover fechas en masa queda fuera por decisión.
6. Front de Modificaciones y el módulo `metrics` siguen **sin commit**; la migración `1790710000000` está aplicada según los docs.

## 6. Verificación de los fixes RSM (01-10, pendiente de aplicar)

Assets: `rsm` y `fn/revenue_schedule_apply_fx_for_contract.sql` (sin migración; entran con `postgres:assets`, QA antes que prod, sin tocar
datos de clientes). Tests de texto: `contract-modifications-block2.spec.ts` "assets RSM: fixes 01-10" y `fx-model.spec.ts` "S5-10". Sin réplica
TS que alinear (`one-off-discount.ts` solo replica la ventana activa; `multicurrency.ts` no calcula el mensual del RSM).

1. **U8**: en QA, un contrato con facturas: `revenue_schedule_rebuild(c, NULL)`, guardar las filas; `revenue_schedule_rebuild(c, mes)` →
   `recognized_cum_*`, `deferred_balance_eom_*` y `unbilled_balance_eom_*` iguales desde `mes` (y un multimoneda con ítem directo).
2. **S5-16**: UPSELL v2 a mitad de ciclo (caso Bosch): devengo del primer mes = `monthly_price × días vivos / días del mes` (180,46, no 169,95).
3. **U5**: baja early a mitad de ciclo: la fila del espejo CHURN del mes devenga `monthly_price × días restantes / días del mes` (no el mes).
4. **S5-10**: contrato en moneda ≠ compañía sin promedio del mes (o sin tasa fija) → `*_ccy`/`*_system_ccy` NULL y `missing_fx_rate`;
   cargar la tasa y volver a llamar `revenue_schedule_apply_fx_for_contract` → la fila se completa y queda `v4-fx-normalized`.
5. Tras aplicar: rebuild completo de los contratos tocados por v2 con rebuild parcial (las filas ya infladas por U8 no se corrigen solas).
