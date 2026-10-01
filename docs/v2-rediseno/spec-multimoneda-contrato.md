# Spec · Multimoneda en el contrato (M3 · flexibilidad caso 2)

> 01-10-2026 · para Domi y quienes implementen (api-sapira `src/modules/contracts`, front-sapira `/lab/contratos`; envío al ERP: Leon).
> Codifica las **decisiones de Domi del 01-10** (finales) sobre ítems en distintas monedas facturados en un solo documento. Reemplaza la
> unificación de contratos por moneda (S4-5 (a)) y abre el bloque de Modificaciones sobre el modelo definitivo (orden de Domi 30-09).
> Fuentes: [`flexibilidad-con-trazabilidad.md`](./flexibilidad-con-trazabilidad.md) caso 2 · [`auditoria-contratos.md`](./auditoria-contratos.md)
> U3, U10, S1-2, S1-15/16, S4-5/S4-6, S5b, S6 "Con multimoneda real" · [`mapa-v2-contratos.md`](./mapa-v2-contratos.md) §3b ·
> [`activacion-campos-api.md`](./activacion-campos-api.md) P4/P5/P7 · [`plan-coexistencia-funciones.md`](./plan-coexistencia-funciones.md) ·
> [`spec-facturas-en-contrato-360.md`](./spec-facturas-en-contrato-360.md) §3.2, §8 · [`spec-pricing-v2.md`](./spec-pricing-v2.md) ·
> [`spec-modificaciones-contrato-v2.md`](./spec-modificaciones-contrato-v2.md) §9. Industria: Orb/Metronome (*pricing units* → una moneda de
> cobro), Zuora (FX por línea), Zenskar/Maxio (moneda por ítem). Alcance de datos: **solo el holding demo** hasta producción; sin migrar datos reales.

## 0. Punto de partida en v2 (lo que ya existe)

- **Columnas que ya están y se reutilizan** (ninguna se duplica): `contract_items.currency` (hoy forzada = moneda del contrato por trigger);
  `contracts.requires_multicurrency_billing` (bool, default false, **inerte**: 0 activos; el listado ya filtra por él, `contracts.service.ts:301`);
  `quotes.requires_multicurrency` (la cotización ya lo guarda, `quotes.service.ts:900`); `contracts.invoice_currency`, `fx_invoice_policy`
  (`fixed | spot`), `fx_company_policy`; `contract_fx_period_rates` (`from_currency`, `to_currency`, `rate`, `purpose company | invoice`, período;
  regla única "1 [from] = rate [to]"); por línea de factura `invoice_items.contract_currency`, `invoice_currency`, `fx_contract_to_invoice`,
  `fx_rate_source`, `fx_rate_date` y los montos `*_contract_currency` / `*_invoice_currency`; `prices.currency` (Pricing v2).
- **Motor** (`billing-engine.ts`): agrupa líneas por fecha de emisión; **una tasa por factura**: `findFixedRate(contract.fixed_invoice_rates,
  contractCurrency, currency, invoice.billing_period_start)` (:1056) y `fixedFxAmounts(invoice, rate)` (:613) valorizan **todas** las líneas con esa
  tasa; `PreviewInvoice.fx` es único. `findFixedRate` ya busca por **par** (directa, si no inversa 1/tasa): sirve tal cual por línea.
- **Alta** (`contract-drafts.service.ts`): `resolveFx` (:922) normaliza `fx_invoice_rates` / `fx_company_rates` como `FxRateRow` siempre con
  `from_currency = moneda del contrato`; regla "tasa sin fechas = todo el contrato" (`isWholeContractRate`, `WHOLE_CONTRACT_RATE_CONFLICT`, :217-228)
  con el rango de los ítems (horizonte de 12 períodos si hay indefinidos). La UF no se factura (`uf_invoice_currency`).
- **Modificaciones** (`contract-changes.ts`): `engineContract` pasa `fixed_invoice_rates`; `addGeneratedInvoices` bloquea `fixed_fx_without_rate`
  con un solo par contrato → factura; `mergeTarget` (:1135) funde por receptor, **moneda de factura**, documento y mes; `planBillingConditions`
  (:2331-2348) cambia moneda/política con tasas `contrato → factura`. `insertMirrorCreditNote` (`contract-changes.service.ts:1290`) copia a cada
  línea de la NC el `contract_currency` y `fx_contract_to_invoice` **del encabezado** de la original.
- **Envío** (`invoice-scheduler.service.ts:1226`, Leon): spot = una tasa `invoice.contract_currency → invoice.invoice_currency` aplicada a todas las
  líneas; el mapper a Odoo ya manda `price_unit = unit_price_invoice_currency` **por línea** (:992).
- **Devengo**: `revenue_schedule_rebuild_contract_ccy` toma `final_price / term_months` y `SUM(ii.subtotal_contract_currency)` por
  `contract_item_id` (:104, :119, :138) y escribe todo como moneda del contrato: **asume moneda del ítem = moneda del contrato**.
- **Validadores** (invariantes que v2 respeta, `costura-sapira-writer.spec.ts:48`): `validate_contract_currency_consistency` (contrato: todo ítem =
  moneda del contrato) y `validate_contract_item_currency_consistency` (ítem = contrato); ambos con bypass `sapira.skip_currency_validation` que
  usa el `PUT` del borrador al cambiar la moneda (`contract-drafts.service.ts:2031`). `change_contract_currency` (legacy) pisa ítems en borrador.
- **Unificación legacy** (`unify_invoices_multi_contract`): 14 usos; la única que hoy junta monedas, valorizando **por par** (`spot_unify` /
  `manual_unify`). v2 la bloquea (`unified_invoice`).

## 1. Inventario: cómo se resuelven hoy las monedas mezcladas

| Hoy | Cómo | Bugs (cita) | Qué es en v2 |
|---|---|---|---|
| Ítems en otra moneda en un contrato | No se puede (trigger); se crean **contratos separados** y se unifican sus facturas | U3: líneas CLF en facturas CLP no valorizadas → $0 en Odoo (BAT; 20 líneas futuras CTR-2026-86) | Ítem con su moneda dentro del contrato con el flag (§2) |
| Cross-sell desde cotización en otra moneda | `AssignToContractModal` con fx 1 | U10/B1: línea en UF enviada como CLP | `item_add` en la moneda de la cotización con su par (§6) |
| Unificar (`unify_invoices_multi_contract`) | Documento `Unificada`, valoriza por par, prefijo de contrato | Exige **mismo cliente comercial**; pierde OC/HES, serie y `auto_invoice`; líneas sin `contract_id`; deshacer borra sin mirar Odoo (borrador huérfano) | **Consolidación opcional** solo para el caso socio (§7) |
| Moneda de facturación masiva | `POST /invoices/bulk-update-currency` | S6 (todas las PE, fuerza `auto_send_to_odoo`) | Ya cubierto por `billing_conditions` (por par, §6) |
| Cambiar moneda en borrador | `change_contract_currency` | Pisa todos los ítems | Solo contratos sin flag; con flag rechaza (§8) |

## 2. Modelo de tres monedas (DECIDIDO 01-10)

| Moneda | Dónde vive | Para qué |
|---|---|---|
| **Del ítem (precio)** | `contract_items.currency` (y `prices.currency` = la misma) | Lo pactado: precio, cantidad × unitario, consumos. Nunca se reescribe |
| **Del contrato** | `contracts.contract_currency` | **Solo referencia interna**: MRR, TCV, devengo (RSM), ítem madre, KPIs. No aparece en la factura |
| **De la factura** | `contracts.invoice_currency` (default) → `invoices.invoice_currency` | La **única** moneda del documento (DTE/SUNAT/CFDI: una moneda). UF nunca |

- **Opt-in**: `contracts.requires_multicurrency_billing = true`. Se fija al crear (heredado de `quotes.requires_multicurrency` cuando viene de
  cotización) o después con la modificación **Activar multimoneda** (evento). **Sin el flag todo queda como hoy** (ítem = contrato, una tasa por factura).
- Con el flag: un ítem puede estar en cualquier moneda; **no se puede apagar** mientras exista un ítem vivo o histórico con moneda ≠ contrato.
- **Conversión para facturar = directa ítem → factura**, una tasa por **par presente** (UF→CLP, USD→CLP; las líneas CLP en factura CLP no
  convierten), guardada **por línea**. Nunca ítem → contrato → factura.
- **Conversión para métricas = ítem → contrato, siempre FIJA**, pactada al crear (o al agregar el ítem), por par (§3).
- Quotes siguen monomoneda (limitación CRM), pero una cotización en otra moneda puede asignarse a un contrato multimoneda (§6).

## 3. Datos: lo que se reutiliza y lo único nuevo

**Reutilizado sin cambios de esquema**: los campos de §0. Semántica nueva **solo en contratos con flag**:
- `invoice_items.contract_currency` = **moneda de origen de la línea = moneda del ítem**; `*_contract_currency` de la línea en esa moneda;
  `fx_contract_to_invoice` = tasa **ítem → factura** de esa línea; `fx_rate_source` (`contract` fija del contrato · `spot` del día de emisión ·
  `manual` / `net_exact` por factura) y `fx_rate_date`. Es exactamente lo que ya hacía la unificación legacy por par.
- `invoices.contract_currency` = moneda del contrato; `invoices.amount_contract_currency` = Σ de cada línea × tasa fija ítem → contrato
  (redondeo por línea a 2); `invoices.fx_contract_to_invoice` = la tasa si el documento tiene **un solo par convertidor**, `NULL` si tiene dos o más
  (se lee por línea; mismo criterio que `v_doc_fx` de la unificación legacy).
- `contract_fx_period_rates` `purpose = 'invoice'`: filas **por par** `from = moneda del ítem`, `to = moneda de factura` (hoy siempre from =
  contrato; sin flag sigue igual porque ítem = contrato).

**Lo único nuevo** (una migración `1790700000000-MulticurrencyContract` + assets; entity a mano, commit antes de aplicar, `schema:status` en QA):

| # | Cambio | Efecto exacto |
|---|---|---|
| 1 | `contract_fx_period_rates_purpose_check` → `purpose IN ('company','invoice','item')` + comentario de columna | `item` = tasa **fija** ítem → contrato (`from` = moneda del ítem, `to` = moneda del contrato) para MRR/TCV/devengo. Una fila sin fechas = todo el contrato (regla de `resolveFx`); por período opcional. `company` sigue siendo contrato → compañía. Entity `ContractFxPeriodRate.purpose: 'company' \| 'invoice' \| 'item'` |
| 2 | Asset `validate_contract_item_currency_consistency` reescrito | Ítem con `currency ≠ contract_currency` **solo si** `contracts.requires_multicurrency_billing`; si no, mismo error de hoy. Mantiene el bypass `sapira.skip_currency_validation` (borrador). Nunca no-op |
| 3 | Asset `validate_contract_currency_consistency` reescrito (trigger `BEFORE INSERT OR UPDATE ON contracts`, sin cambio) | Sin flag: todos los ítems = moneda del contrato (hoy). Con flag: permitido. Pasar el flag de `true` a `false` con algún ítem en otra moneda → `RAISE 'No se puede desactivar multimoneda: hay ítems en otra moneda'`. Bypass del borrador intacto |
| 4 | Asset `change_contract_currency` (legacy) | Si `requires_multicurrency_billing` o algún ítem ≠ moneda nueva por otra razón → `RAISE 'Contrato multimoneda: cambia monedas desde Sapira v2'`. Se retira al switch |
| 5 | Asset `revenue_schedule_rebuild_contract_ccy` (+ `contract_item_fx_rate`, `revenue_schedule_apply_fx_for_contract`) | Por ítem con `currency ≠ contract_currency`: `v_monthly_revenue`, `monthly_price` y el facturado (`SUM(ii.subtotal_contract_currency)`, que viene en moneda del ítem) × tasa `item` (directa o 1/inversa a 6 decimales como `findFixedRate`, período del mes; sin tasa → fila marcada `missing_fx_rate`, **nunca 1**, P5, y la marca sobrevive al paso FX). **Sin vueltas** (§5): si la moneda del ítem es la de la compañía (o la del sistema), el rebuild escribe `*_ccy` (o `*_system_ccy`) con el monto del ítem (`fx_to_*_source = 'item_currency_direct'`, `fx_contract_to_*` = 1/tasa item o NULL) y `apply_fx` salta esas columnas. Ítems en la moneda del contrato: sin cambio |
| 6 | `costura-sapira-writer.spec.ts` + tests de assets | Los dos validadores siguen como invariantes (la marca `sapira.writer` no los salta); casos nuevos flag on/off |

Sin columnas nuevas en `contracts`, `contract_items`, `invoices`, `invoice_items` ni `quotes`.

## 4. Motor de facturación (por línea)

- `BillingEngineItem.currency?: string` (default `contract_currency`); `BillingEngineContract.fixed_item_rates?: FxPeriodRate[]` (`purpose item`);
  `PreviewLine` gana `currency` (del ítem), `fx: number | null` y `amounts_invoice_currency?: { unit_price, subtotal, tax, total }`.
- **Agrupación igual** (por fecha de emisión, receptor, documento). Todas las líneas de un documento quedan en **la moneda de factura del contrato**.
- **Valorización por línea** (reemplaza la rama de :1052-1068): para cada línea, `pair = (line.currency, invoiceCurrency)`:
  - mismo par (CLP en CLP) → `fx = 1`, montos llenos, `fx_rate_source = 'contract'`;
  - **fija** (`fx_invoice_policy = 'fixed'`) → `findFixedRate(fixed_invoice_rates, line.currency, invoiceCurrency, line.billing_period_start)`;
    sin fila → advertencia del generador y, en activación/modificación, blocker `fixed_fx_without_rate` **con el par** ("falta USD → CLP desde…");
  - **spot** → `fx = NULL` y montos en moneda de factura `NULL` hasta el envío.
- **Política por par**: la política del contrato aplica a **cada par** (fija = tasa pactada del par; spot = tasa del día de emisión del par).
- **Encabezado = Σ líneas** con `headerFromLines` (convención única 01-10): si **todas** las líneas están valorizadas → subtotal/IVA/total en moneda de
  factura = Σ de líneas redondeadas (residuo de una conversión fija a la línea mayor **de ese par**); si **alguna** queda `NULL` (spot) → los montos
  del encabezado en moneda de factura quedan `NULL`. **Nunca un documento medio valorizado hacia el ERP**: el envío valoriza todas las líneas pendientes
  en la misma operación o no envía.
- **IVA**: por línea en moneda de factura con la tasa normalizada del documento; el IVA del encabezado nunca se calcula en moneda de contrato (cierra B2
  también en multimoneda).
- **Totales del generador**: `totals.contract_value` y `mrr` y `items[].monthly_equivalent` se expresan en **moneda del contrato** convirtiendo cada
  ítem con su tasa `item` (la vista previa muestra además el valor en la moneda del ítem).
- **Glosa**: el bloque de tipo de cambio de la plantilla (§3.6 facturas) toma la tasa **de la línea**.
- **Pricing v2**: `prices.currency` debe ser igual a `contract_items.currency` (400 `price_currency_mismatch`); el motor de precios no cambia (opera en
  la moneda del ítem). Consumos (`consumption.service.ts`): la línea recalculada conserva su moneda de ítem y se revaloriza con su par.
- **Envío al ERP (Leon)**: `calculateInvoiceAmountsAtIssue` pasa de una tasa por encabezado a **una tasa por par**: agrupa las líneas por
  `(contract_currency, invoice_currency)` de la línea, toma la fija ya escrita o la spot del día de emisión del par (`getExchangeRateWithFallback`),
  escribe cada línea y recalcula el encabezado = Σ. Si falta la tasa de **cualquier** par → no envía (`fx_rate_missing` con el par). El mapper ya manda
  `price_unit` por línea; `currency_id` = moneda de factura. Se avisa en [`cambios-integracion-para-leon.md`](./cambios-integracion-para-leon.md).
- **Notas de crédito**: toda NC (anular, descuento, modificaciones, consumo) **reusa la tasa y la moneda de cada línea original**:
  `insertMirrorCreditNote` copia `line.contract_currency`, `line.fx_contract_to_invoice`, `line.fx_rate_source`, `line.fx_rate_date` (hoy copia los del
  encabezado: en multimoneda la NC quedaría mal valorizada). El encabezado de la NC = Σ líneas.
- **FX por factura (§3.2 facturas)**: `PATCH /contracts/:id/invoices/fx` gana `rates_by_pair?: Record<'USD>CLP', number>` para `fixed`; `net_exact`
  solo en documentos de **un** par convertidor (400 `net_exact_multi_pair`).

- **Operaciones sobre Por Emitir fuera del motor (construido 01-10)**: editor (una y masivo), presentación por tramo ↔ una fila, descuento
  puntual, reorganizar, facturar por OC, reemisión de la anulación y facturas nuevas de consumos usan el mismo cálculo por línea
  (`revalueByPair` sobre `valuateLinesByPair`, encabezado con `multicurrencyHeader`) y lo persisten con `revalueMulticurrencyInvoices`.
  Tasa de cada línea: la suya si conserva su moneda (la reemisión copia moneda y tasa de cada línea, como la NC espejo); si se mueve o
  nace, la fijada por factura para el par (`manual` / `net_exact`), si no la fija pactada del período de la línea, si no NULL (spot). La
  moneda de la línea sale siempre de su ítem. Sin el flag nada cambia (ni consultas extra en el editor). **Desviación**: facturar por OC fija
  un neto exacto con una sola tasa, así que en un documento con líneas en dos o más monedas bloquea con `net_exact_multi_pair`; con una sola
  moneda la visible nace en ella y el saldo se revaloriza por par. Las facturadas por OC y las unificadas no se revalorizan (su neto o su
  consolidación mandan). La vista previa por par está en editor, masivo y reorganizar; facturar por OC y las Por Emitir siguientes
  recompuestas por tramo se valorizan al aplicar.

## 5. Métricas: MRR, TCV y devengo

- `monthly_price`, `final_price`, `unit_price` del ítem **quedan en la moneda del ítem**. Todo agregado del contrato convierte con la tasa `item` del
  par (fija, `findFixedRate(fixed_item_rates, item.currency, contract_currency, fecha)`):
  - **MRR** (`contractMrr`, ítem madre, Resumen del 360, `ΔMRR` de eventos) = Σ mensual del ítem × tasa `item`;
  - **TCV** `contracts.total_value` = Σ `final_price` × tasa `item` (lo escribe la API al crear y en cada cambio); `total_value_system_currency` sigue
    su cadena actual contrato → sistema (`calculate_contract_fx_amounts`, con P4/P7 corregidos);
  - **RSM** (asset #5): devengo, facturado, MRR y CMRR en moneda de contrato con la tasa `item`; el paso a compañía y sistema sigue igual
    (`purpose company`, promedio mensual o fijo). Lo facturado en moneda de factura vs. devengado a tasa pactada genera **diferencia de cambio**
    (M9, sin cuenta especial ahora).
- Ítems en la moneda del contrato no usan tasa (1). Un ítem en otra moneda **sin** tasa `item` → 400 al crear / blocker `item_fx_rate_missing` al
  modificar y activar. La tasa se pacta **por par**, no por ítem: dos ítems USD comparten la fila USD → contrato.
- **Sin vueltas (DECIDIDO 01-10)**: cuando la moneda del ítem ya es la moneda destino, el monto se usa **directo** (tasa 1), nunca ítem →
  contrato → destino. Devengo (RSM): un ítem MXN en un contrato USD de una compañía MXN escribe sus columnas en moneda de compañía (`*_ccy`)
  con su monto MXN; las de contrato (`*_contract_ccy`) siguen con la tasa `item` (para eso existe la moneda del contrato: MRR/TCV). Igual con
  la moneda del sistema (`*_system_ccy`) cuando ítem = sistema. Sin tasa `item`, las columnas directas igual se llenan y las de contrato
  quedan NULL con `missing_fx_rate`. Implementación: el rebuild calcula las columnas directas con los mismos montos en moneda del ítem que
  alimentan las de contrato (sin dividir el monto de contrato por la tasa: eso arrastraría el redondeo a contrato) y `apply_fx` no las
  pisa. Facturas: ítem → factura ya es directo por línea (misma moneda → 1); en `amount_system_currency` (`refreshInvoiceSystemAmounts`)
  las líneas ya en moneda del sistema entran directo y solo el resto del encabezado en moneda de contrato se convierte.

## 6. Alta, edición y modificaciones

**DTO de alta** (`CreateContractDto`): `requires_multicurrency_billing?: boolean` (default el de la cotización de origen); `items[].currency?`
(default `contract_currency`; ≠ solo con el flag → 400 `item_currency_requires_multicurrency`); `fx_item_rates?: [{ from_currency, rate,
period_start?, period_end? }]` (obligatoria una por moneda de ítem ≠ contrato, `to` = contrato); `fx_invoice_rates[].from_currency?` (default
contrato; con `fixed`, una por moneda de ítem ≠ factura). `resolveFx` extiende `normalize` **por par y propósito**: la regla de todo el contrato y
`WHOLE_CONTRACT_RATE_CONFLICT` se evalúan por `(purpose, from, to)`; `FxRateRow.purpose` suma `'item'`. Bloqueos de activación por par:
`fixed_fx_without_rate`, `item_fx_rate_missing`.

**Modificaciones** (detalle en [`spec-modificaciones-contrato-v2.md`](./spec-modificaciones-contrato-v2.md) §9):
- `multicurrency { enabled: boolean }` (tipo nuevo): enciende el flag (evento `MULTICURRENCY_ENABLED`, sin ítems ni RSM); apagar con ítems en otra
  moneda → blocker `foreign_currency_items_present`.
- `item_add.items[].currency?` + `fx_item_rates[]` + `fx_invoice_rates[]` (del par nuevo); `item_add.enable_multicurrency?: true` enciende el flag en
  la misma transacción. Sin flag y moneda ≠ → blocker `multicurrency_not_enabled` (`next_step`: "Activa multimoneda o usa la moneda del contrato").
  **Desde cotización**: la cotización conserva su moneda; el ítem nace en la moneda de la cotización (cierra U10).
- `billing_conditions`: cambiar `invoice_currency` o `fx_invoice_policy` en un contrato multimoneda exige tasas para **cada** par nuevo (400 con el
  par faltante); `fx_invoice_rates[].from_currency` obligatorio cuando hay más de una moneda de ítem.
- `renewal`: extiende las tasas de todo el contrato **de cada par y propósito** (`invoice` e `item`) al nuevo fin (§9 modificaciones).
- `mergeTarget` no cambia (la moneda de factura es una por contrato); la línea nueva se valoriza con su par.

**UI del lab** (`/lab/contratos/nuevo`, `ContratoItemsTab`, `PasoCondiciones`):
- Interruptor **"Facturar ítems en distintas monedas"** (apagado por defecto; encendido si la cotización lo pide). Encendido, cada fila de ítem muestra
  un `Combobox` de moneda (catálogo del holding; UF permitida en el ítem, nunca en la factura).
- Bloque **Tipos de cambio por par**, generado de las monedas elegidas: "UF → CLP para facturar" (spot / fija con `NumberField` y período) y "UF → USD
  para métricas (fija, pactada)". Sin par pendiente no se habilita Revisar.
- **Totales por moneda** (`USD 1.200 · UF 35`) + **equivalente indicativo** en moneda del contrato (tasa `item`) y de factura (tasa fija o la última
  spot conocida, con la leyenda "indicativo: se valoriza al emitir").
- 360: chip de moneda por ítem, MRR del Resumen con "incluye N ítems convertidos a la tasa pactada"; vista rápida de factura con columna "Par · TC"
  por línea; acción **Activar multimoneda** dentro de Modificar contrato.

## 7. Consolidación opcional (caso socio)

**Cuándo**: misma razón social receptora (`client_entity_id`), misma compañía emisora, **misma moneda de factura**, mismo mes de emisión, mismo
documento y `export_type`, **≥ 2 contratos** (pueden ser de **clientes comerciales distintos**: el socio factura a un mismo receptor por varios
clientes finales). Ya no se usa para juntar monedas (eso es §2).

**API** (`ContractInvoiceConsolidationService`, módulo contracts, misma convención preview/aplicar):
`GET /contracts/:id/invoices/:invoiceId/consolidation-candidates` · `POST /contracts/invoices/consolidations/preview` y
`POST /contracts/invoices/consolidations` `{ invoice_ids[] (2–50), notes? }` · `POST /contracts/invoices/consolidations/:invoiceId/undo { reason }`.

**Se conserva de la legacy**: validaciones de elegibilidad (Por Emitir, activas, no NC/ND, no ya consolidadas, mismo holding/compañía/receptor/
moneda/mes/documento); **valorización por par** de cada línea antes de juntar (la fija ya escrita o, si alguna es spot, el documento queda spot entero
y se valoriza al emitir: nunca mixto); **prefijo de contrato** en la glosa con guion ASCII `'-'` (`CTR-2026-12 - <glosa>`); aporte por contrato visible
(preview y vista rápida: subtotal por contrato); el RSM sigue sumando por `contract_item_id` (no cambia); **un evento por contrato**
(`INVOICE_CONSOLIDATED`, `metadata { consolidated_invoice_id, source_invoice_ids, contracts[] }`); reversible mientras esté Por Emitir.

**Se corrige**: (1) `client_id` ya no debe coincidir (el encabezado toma el del contrato principal = mayor aporte); (2) cada línea conserva
`invoice_items.contract_id` (la legacy no lo copiaba); (3) **OC/HES**: se copian las `invoice_references` / `billing_references` de los orígenes
(dedupe por tipo+folio); con `requires_references_for_billing` en algún contrato, el documento hereda el requisito (`needs_reference`); (4) **serie**:
`invoice_series` debe coincidir → si no, blocker `series_mismatch`; (5) `auto_invoice` y `auto_send_to_odoo` = AND de los orígenes (aviso si difieren);
(6) **borrador en el ERP**: un origen con `odoo_invoice_id`/`sent_to_odoo_at` bloquea (`sent_to_erp_draft`, `action: 'erp_reset'`); deshacer un
consolidado ya enviado bloquea igual; (7) deshacer **no borra**: el consolidado pasa a `Cancelada`, los orígenes vuelven a `is_active = true`,
`consolidated_into_invoice_id = NULL`; evento `INVOICE_CONSOLIDATION_UNDONE` por contrato.

**Forma**: reutiliza `invoice_type = 'Unificada'`, `invoice_group_id` y `consolidated_into_invoice_id` (sin columnas nuevas). Un `Unificada` es
**v2 (editable con estas reglas)** si tiene evento `INVOICE_CONSOLIDATED`; si no, es **legacy** (§9).

**Construido (01-10, MM5)** · `contract-invoice-consolidation.service.ts` + `invoice-consolidation.ts` (pura) + `invoice-consolidation-read.ts`:
- **Respuestas**: candidatas `{ invoice{…, eligible, blockers}, base_blockers[], candidates[{ id, invoice_number, contract_id, contract_number,
  client_id, client_name, issue_date, invoice_series, contract_currency, invoice_currency, amount_*, lines_count, auto_invoice, eligible,
  blockers[] }], total }` (Por Emitir de OTROS contratos, máx. 100). Preview `{ invoices[], contributions[{ contract_id, contract_number,
  client_id, client_name, invoice_ids, lines_count, contract_currency, amount_contract_currency, subtotal_invoice_currency,
  subtotal_by_currency[], weight, main }], main_contract_id, header{…, contract_currency_mode: same | mixed, spot, pairs[], auto_invoice,
  auto_send_to_erp, requires_references_for_billing}, lines[{ source_line_id, contract_id, contract_number, description, currency, fx,
  *_invoice_currency, spot_propagated }], references{ items[{ kind, code, source }], deduped }, warnings[], blockers[], can_apply }`. Aplicar
  = preview + `applied, consolidated_invoice_id, event_ids, invoice` (409 `{ code: 'blocked', blockers, preview }`). Deshacer
  `{ consolidated, origins[], undone, consolidated_invoice_id, status: 'Cancelada', restored_invoice_ids, event_ids }`.
- **Bloqueos**: `credit_note`, `not_pending`, `already_consolidated`, `legacy_invoice`, `no_contract`, `partial_billing_invoice`,
  `open_consumption`, `sent_to_erp_draft` (`action: 'erp_reset'`), `period_closed`, `single_contract`, `company_mismatch`, `entity_mismatch`,
  `currency_mismatch`, `month_mismatch`, `document_type_mismatch`, `export_type_mismatch`, `series_mismatch`, `tax_rate_mismatch`,
  `multicurrency_spot_send_pending` (spot con más de un par, hasta MM4). Deshacer: `not_consolidated`, `legacy_unified`, `not_pending`,
  `sent_to_erp_draft`, `no_origins`. Avisos: `auto_invoice_differs`, `auto_send_to_erp_differs`, `pair_rates_differ`, `spot_document`,
  `references_inherited`, `description_fitted`.
- **Desviaciones de lo escrito arriba**: (a) no existe `needs_reference`: el consolidado hereda `invoices.requires_references_for_billing` =
  OR de los orígenes y de `contracts.requires_references_for_billing`; (b) `auto_send_to_odoo` vive solo en el contrato: el envío sigue el
  del contrato principal (aviso `auto_send_to_erp_differs` si difieren); `auto_invoice` = AND de los orígenes; (c) encabezado en moneda de
  contrato: si todos los orígenes comparten moneda de contrato, Σ de los orígenes; si no, `contract_currency` = moneda de factura y
  `amount_contract_currency` = Σ en moneda de factura (NULL si spot); (d) bloquean además consumo sin cerrar, facturada por OC, período
  cerrado e IVA distinto; (e) mes de emisión = mes de `COALESCE(issue_date, scheduled_at)`; (f) las líneas se **copian** (los orígenes
  quedan intactos e inactivos); el consolidado vive en el 360 del contrato principal; sin rebuild del devengo (el RSM suma solo emitidas
  activas); (g) el consolidado v2 sigue bloqueado (`unified_invoice`) para las demás operaciones del 360: se deshace y se vuelve a operar
  (editarlo en sitio queda pendiente); (h) los tipos de evento son texto libre (sin CHECK): la migración no cambia.

## 8. Validadores y funciones legacy

| Función | Destino | Detalle |
|---|---|---|
| `validate_contract_item_currency_consistency` | **Reescribir** (invariante) | §3 #2 |
| `validate_contract_currency_consistency` | **Reescribir** (invariante) | §3 #3 (incluye "no apagar el flag con ítems en otra moneda") |
| `change_contract_currency` | Guard ahora, retirar al switch | §3 #4; el `PUT` del borrador v2 cambia moneda solo sin flag (con flag: cambiar la moneda del contrato no reexpresa ítems; 400 `multicurrency_contract_currency_locked` tras activar) |
| `revenue_schedule_rebuild_contract_ccy` | Asset (conversión por tasa `item`) | §3 #5 |
| `unify_invoices_multi_contract`, `unconsolidate_invoices_simple`, `consolidate_invoices_simple` | **No se portan**; retirar al switch | Reemplazados por §2 (monedas) y §7 (socio). S4-6 ya eliminó consolidar de 1 contrato |
| `invoice_scheduler` FX (`calculateInvoiceAmountsAtIssue`) | Cambio de Leon | §4 "Envío" |

## 9. Historial unificado (solo lectura)

Las facturas `Unificada`/`Consolidada` **sin** evento `INVOICE_CONSOLIDATED` (legacy) quedan **de solo lectura** en v2: el 360 las muestra con el
chip "Documento unificado (histórico)", sus líneas y el aporte por contrato; todas las operaciones bloquean `unified_invoice` (como hoy). Deshacerlas
o editarlas solo en la app vieja hasta el switch. Hoy son datos del demo; los de producción (38 documentos, S4) **no se migran** en este bloque.

**Construido (01-10)**: el listado y el detalle de facturas exponen `legacy_unified: boolean` y `contributions[{ contract_id,
contract_number, lines_count, subtotal_invoice_currency | null, subtotal_by_currency[{ currency, subtotal }] }]` solo en `Unificada` /
`Consolidada` (una consulta en lote, solo si la página trae alguna). Legacy = sin evento `INVOICE_CONSOLIDATED`; el aporte sale del
`contract_id` de cada línea (o el del encabezado si la línea no lo tiene). `commonBlockers` sigue devolviendo `unified_invoice` para todas.

## 10. Bugs que se cierran

| Bug | Cómo |
|---|---|
| U3 · líneas convertidoras sin valorizar ($0 en Odoo, BAT, CTR-2026-86) | Valorización por línea y envío que no sale con ninguna línea `NULL` (§4) |
| U10 / B1 · ítem de cotización en otra moneda con fx 1 | `item_add` en la moneda de la cotización con su par (§6) |
| S1-2 · selector de moneda por ítem que la base rechaza | Validadores reescritos + flag (§3) |
| S4-5 · unificar por moneda | Contrato multimoneda (§2) |
| Unificar pierde OC/HES, serie, `auto_invoice`, `contract_id` de línea; deshacer deja borrador huérfano | Consolidación v2 (§7) |
| NC con tasa del encabezado en documento de varios pares | `insertMirrorCreditNote` por línea (§4) |
| Spot del scheduler con una sola tasa por documento | Tasa por par al emitir (§4, Leon) |

## 11. Orden de construcción y decisiones

1. **MM1 · Esquema y validadores**: migración #1, assets #2–#4, tests de assets y `costura-sapira-writer.spec.ts`. Nada cambia sin flag.
2. **MM2 · Motor y alta**: `billing-engine.ts` por línea, `resolveFx` por par, DTO de alta, preview, activación (bloqueos por par), TCV/MRR
   convertidos; asset RSM #5. Tests: contrato CLP con ítems UF + USD + CLP → factura CLP con tres pares, fija y spot; encabezado NULL con una spot;
   residuo por par; MRR con tasa `item`.
3. **MM3 · Modificaciones**: `multicurrency`, `item_add` con moneda y desde cotización, `billing_conditions` por par, NC por línea, extensión de tasas
   en `renewal` (bloque 2).
4. **MM4 · Envío (Leon)**: spot por par al emitir y aviso en `cambios-integracion-para-leon.md`. Hasta entonces, un contrato multimoneda con política
   spot **no se activa** (blocker `multicurrency_spot_send_pending`); con fija sí (líneas ya valorizadas).
5. **MM5 · Consolidación opcional** (§7) y vista de solo lectura del histórico (§9).
6. **MM6 · UI del lab** en paralelo a MM2–MM5 + documentación funcional (`docs/documentacion-funcional/contratos/`).

**Decisiones de Domi (01-10) que esta spec aplica**: las de §2 (tres monedas, conversión directa por par y por línea, ítem → contrato fija,
opt-in con el flag, no se apaga con ítems en otra moneda), validadores como invariantes reescritos, `change_contract_currency` rechaza multimoneda,
RSM/TCV convierten con la tasa `item`, unificación no se porta y consolidación queda para socios, cotizaciones monomoneda asignables, solo demo.

## 12. Pendientes (anotados, sin fecha)

- Migrar los documentos unificados y los contratos "partidos por moneda" de producción a contratos multimoneda (sesión de datos, después del switch).
- Diferencia de cambio contable (facturado a tasa del día vs. devengo a tasa pactada) con cuentas propias (S5b, M9).
- Multimoneda por **ruta de facturación** (A.5: documentos en distintas monedas por receptor) — fuera de este bloque.
- Revalorizar la tasa `item` (renegociar el tipo de cambio pactado) como modificación con evento: hoy solo se extiende en la renovación.
- Ajustar los KPIs del listado y del dashboard que suman `contract_items.monthly_price` directo (deben leer el RSM o convertir).

## 13. Preguntas abiertas (máx. 5)

1. **Política por par distinta en un mismo contrato** (ej. USD→CLP fija y UF→CLP spot): la spec usa **una** política para todos los pares.
   ¿Basta, o hace falta política por par (sería otra columna o filas `invoice` como "fija solo para ese par")?
2. **UF en un contrato CLP**: la tasa `item` UF→CLP es fija (métricas) y la de facturación UF→CLP suele ser la UF del día (spot). ¿Confirmas que el
   MRR use la UF pactada y la diferencia con lo facturado quede como diferencia de cambio?
3. **Equivalente indicativo** en la UI para pares spot: ¿última tasa diaria (`exchange_rates`) o promedio mensual?
4. **Contrato principal del consolidado** (encabezado `contract_id`, `client_id`, glosa del documento): ¿el de mayor aporte (como la legacy) o uno que
   elija la usuaria en el preview?
5. **Marca de consolidado v2**: ¿basta el evento `INVOICE_CONSOLIDATED` para distinguirlo del legacy, o prefieres un valor nuevo de `invoice_type`
   (`Consolidada v2`) aunque sea un cambio de CHECK?

> Construido con respuesta provisoria (01-10, a confirmar por Domi): Q4 = contrato de mayor aporte (empate: número de contrato
> menor); Q5 = la marca v2 es el evento `INVOICE_CONSOLIDATED` (sin valor nuevo de `invoice_type`).
