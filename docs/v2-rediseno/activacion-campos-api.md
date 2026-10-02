# Campos que escribe la API (alta, edición, activación, cambios y consumos): ¿regla v2 o réplica del trigger?

> Auditoría del 30-09-2026 (Claude, a pedido de Domi) sobre la costura `sapira.writer = 'api'`
> ([`activacion-costura-triggers.md`](./activacion-costura-triggers.md)): con la marca, los triggers legacy no corren y la API
> escribe cada campo (`src/modules/contracts/api-written-fields.ts` + generador y servicios v2). Pregunta: ¿la API aplica la
> regla correcta o copia lo que hacían triggers con bugs?
>
> **Criterio (Domi 30-09):** los dos fronts **no conviven por módulo**: cuando un módulo sale en el front nuevo, el viejo se
> retira con redirect. Por eso **no se replica ningún bug "por paridad"**: donde los docs definen la regla, la API aplica la
> regla v2 aunque dé otro número que el front viejo; la diferencia queda en [§ Cambia respecto del front viejo](#cambia-respecto-del-front-viejo)
> para revisar lo creado antes del switch. Solo queda "pendiente" lo que los docs no deciden. Los invariantes (guard de
> período, validadores de moneda, fin de contrato activo) siguen en Postgres.
>
> Fuentes: [`auditoria-contratos.md`](./auditoria-contratos.md) (S1–S8, U1–U18), [`mapa-v2-contratos.md`](./mapa-v2-contratos.md)
> §1–§4, [`spec-pricing-v2.md`](./spec-pricing-v2.md), [`spec-modificaciones-contrato-v2.md`](./spec-modificaciones-contrato-v2.md) §8,
> [`plan-coexistencia-funciones.md`](./plan-coexistencia-funciones.md), `sapira-ai/docs/ROADMAP-OPERATIVO.md` y los assets de
> `src/databases/postgresql/functions/`. Datos de prod: `SELECT` en `BEGIN READ ONLY` del 30-09.

**Veredictos:** **OK v2** = la API ya aplicaba la regla decidida · **Réplica correcta** = el trigger no tenía bug y la API
hace lo mismo · **Réplica con bug → corregido 30-09** = la API copiaba un bug documentado; se corrigió con tests ·
**Pendiente decisión** = los docs no fijan la regla (opciones al final).

## 1. Ítems del contrato (alta C1 y PUT del borrador; `insert_item` de cambios; ítems de cotización)

| Campo | Lo escribía (trigger) | Regla que aplica hoy la API | ¿Réplica o v2? | Bug conocido del trigger | Veredicto |
|---|---|---|---|---|---|
| `price`, `final_price` | nadie (el front viejo; en cotizaciones solo el import SF) | `itemPricing`: `price = unitario mensual × cantidad × plazo` (sin plazo: horizonte de 12 períodos), `final = price × (1 − dcto %)`; monto fijo → % sobre el bruto | v2 | Medios #4: "editar ítem de cotización no recalcula precios" (`price`/`final_price` solo en el import SF) | **OK v2** (contratos y cotizaciones recalculan en cada alta/PUT) |
| `unit_price`, `annual_unit_price`, `annual_price`, `price_entry_mode` | `auto_calculate_pricing_fields` | Anual: unitario = anual ÷ 12 (6 dec.), anual total = anual × cantidad; mensual: anual = unitario × 12 | Réplica | — | **Réplica correcta** |
| ídem con **modelo de precio** (`price_id` / `price`) en modo anual | — | Unitario = **mensual equivalente** del motor (`equivalentMonthlyUnit`), el modo anual no aplica | v2 | La API pasaba el anual ÷ 12 aunque hubiera modelo → `monthly_price` ≠ MRR de la vista previa (mapa §3 "MRR de la vista previa") | **Réplica con bug → corregido 30-09** (`itemPricingFields`, `resolveQuoteItems`) |
| `monthly_price` | `auto_calculate_pricing_fields` → `calculate_monthly_and_period_prices` | Recurrente: `unitario × cantidad × (1 − %)` (piso 0); monto fijo: `final ÷ plazo`; CHURN/DOWNSELL: `final ÷ plazo` (negativo) | Réplica | Monto fijo sin plazo caía a "base − descuento" (trata el monto del contrato como mensual) | **Réplica correcta**; monto fijo **sin término** → `final ÷ meses del horizonte` (S1-12): **corregido 30-09** |
| `billing_period_price` (recurrente) | ídem | `monthly_price × meses de la frecuencia` (Bianual = 24, S4-11); en modo anual sale del total anual | Réplica + v2 | Auditoría S1: "modo anual con descuento **sin** descuento" (`auto_calculate_pricing_fields.sql`, rama "Override billing_period_price") → período bruto con mensual neto | **Réplica con bug → corregido 30-09**: con % el total anual lleva el mismo %; con monto fijo, mensual × meses |
| `billing_period_price` (pago único) | ídem | **El final completo** (se factura una vez) | v2 | Trigger: `final ÷ plazo × meses de la frecuencia` = el "one shot repartido en cada período" (S1 cronograma, U6, ROADMAP 23-09 #8) | **Réplica con bug → corregido 30-09** (igual que `resolveQuoteItems`) |
| `end_date` | `set_contract_item_end_date` | `inicio + término − 1 día`; sin término NULL; co-terminación explícita en cambios (en el INSERT) | v2 | El trigger **recalculaba** el fin que mandaba el escritor (Bosch, F4) | **OK v2** |
| `term_months` | — | El del formulario; NULL = indefinido solo en recurrentes (S1-12) | v2 | — | **OK v2** |
| `categoria` | `trg_set_contract_item_categoria` → `calculate_contract_item_categoria` | Clasificación **a nivel cliente** (`itemCategoriaSql`, espejo TS `classifyClientItem`; decisión 01-10, spec modificaciones §9.1 #9): contratos anteriores = del mismo cliente, creados antes, no borrados y **activados** (los borradores `En revisión`/`Borrador` nunca cuentan); sin anteriores → NEW; todos cancelados con el churn vigente al inicio del ítem → REACTIVATION; si alguno sigue vigente → UPSELL (producto ya contratado) o CROSS-SELL. Sin override manual. En PUT se recalcula siempre; cambios: M1 (CROSS-SELL si el producto no está en el contrato) y `reactivate` rama c (misma regla) | Réplica + v2 | Con el borrado lógico v2 (S2-9) un borrador borrado contaba como "contrato anterior"; borradores y cancelados contaban igual que un contrato vigente | **Réplica con bug → corregido 30-09** (borrados) y **01-10** (borradores, REACTIVATION) |
| `billing_anchor_day` (ítem) | — | Ciclo propio (spec modificaciones §9.3.9): `items[].billing_cycle = 'own'` en el alta, el PUT o `item_add` ⇒ día de `start_date`; `contract` (default) ⇒ NULL = ciclo del contrato. La renovación, el cambio de frecuencia/plazo y los ajustes heredan el del ítem | v2 | — | **OK v2** (migración `1790710000000`, sin aplicar) |
| `auto_renew` | `inherit_auto_renew_from_quote_item` | Lo elegido por la usuaria | v2 | S1-5: el trigger pisaba `false` con el de la cotización | **OK v2** |
| `currency` | validador (invariante) | = moneda del contrato (S1-2); **multimoneda** (01-10): con `requires_multicurrency_billing`, la del ítem (`items[].currency`, 400 `item_currency_requires_multicurrency` sin el flag) y el precio en esa moneda (400 `price_currency_mismatch`) | v2 | — | **OK v2** (el validador sigue, reescrito para leer el flag) |
| `price_id` / `prices` | — | Copia `owner = contract` (v1; `list_price_id` si viene del catálogo); editar crea versión y archiva | v2 | — | **OK v2** (spec-pricing §2.2) |
| `booking_date` (ítem) | — | El del ítem o el del contrato | v2 | — | **OK v2** |

## 2. Encabezado del contrato

| Campo | Lo escribía (trigger) | Regla que aplica hoy la API | ¿Réplica o v2? | Bug conocido | Veredicto |
|---|---|---|---|---|---|
| `contracts.term` | `update_contract_term` | `MAX(term_months)`; **NULL si algún recurrente es indefinido** (como `contract_end_date`) | Réplica + v2 | El trigger ignoraba el NULL y dejaba el plazo del mayor ítem con término | **Réplica con bug → corregido 30-09** |
| `contract_end_date` | nadie (front) | Mayor fin de los recurrentes; NULL con un indefinido. El vencimiento "más próximo" (S2-13) va aparte en `next_item_end_date` | v2 | Complejos #8 (nunca se actualizaba) | **OK v2** (cambios lo mueven con bypass + evento) |
| `total_value` | nadie (front) | Σ `final_price` de los ítems (alta, PUT y cada cambio); multimoneda: cada ítem × su tasa pactada ítem → contrato (`purpose = 'item'`) | v2 | Complejos #8: "`total_value` solo desde el front" | **OK v2** (supuesto de lo medido: mapa §2f) |
| `company_currency` | `set_contract_company_currency` / `calculate_contract_fx_amounts()` | Alta/PUT: la de la compañía; **activación: la de la compañía emisora** (antes `COALESCE`) y la validación `fx_company_policy_missing` compara contra la compañía | v2 | S5b: "copiada al contrato solo si viene NULL → 12 contratos desalineados" | **Réplica con bug → corregido 30-09** |
| `booking_date` | `set_booking_date_on_activate` | Alta: la del body o la de la cotización (S1-13); activación: hoy **solo si es NULL** (S2-7) | v2 | `mark_contract_signed_safe` la pisaba con hoy | **OK v2** |
| `billing_anchor_day` | — | El elegido o el día del primer inicio recurrente **de ciclo del contrato** (los ítems de ciclo propio no lo fijan, §9.3.9) | v2 | S3-16 | **OK v2** |
| `payment_terms` | — | Los del body o los de la razón social (S1-4) | v2 | Medios #11 (se perdían) | **OK v2** |
| `tax_document_type_id` → `document_type` | — | Documento del catálogo (sugerido país emisor vs receptor, S1-7); `document_type` = familia derivada | v2 | Complejos #4 | **OK v2**, con el hueco de § Pendientes P2 (código exacto y exenta) |
| `fx_invoice_policy`, `invoice_currency`, tasas `purpose` | — | Al crear (S1-3, S1-17; UF nunca se factura). Multimoneda: tasas por par y propósito (`invoice` ítem → factura con `from_currency`; `item` ítem → contrato, obligatoria por moneda de ítem ≠ contrato, 400 `item_fx_rate_missing`); "todo el contrato" por par | v2 | — | **OK v2** |
| `requires_multicurrency_billing` | — | Body → `quotes.requires_multicurrency` de la cotización → false. Con el flag guardado, el PUT no cambia la moneda del contrato (400 `multicurrency_contract_currency_locked`) | v2 | — | **OK v2** (01-10) |
| `requires_*`, `auto_invoice`, `auto_send_to_odoo`, `group_invoices_by_period`, `invoice_terms_and_conditions` | — | Body → cotización → false; envío/emisión apagados por defecto (S6-10); agrupación guardada (S1-10) | v2 | — | **OK v2** |
| `system_currency`, `fx_rate_to_system`, `total_value_system_currency` | `auto_calculate_contract_fx` → `calculate_contract_fx_amounts(uuid)` | Alta: 1 y total si misma moneda, si no NULL. Activación (antes del estado) y cambios (condición del trigger): tasa de `calculate_system_fx_rate` a la **booking** con la política del holding; **`monthly_avg` multiplica, `fixed_period` divide**; sin tasa no escribe (nunca 1) | Réplica + v2 | S5b "convenciones de dirección de tasa mezcladas: promedios directos que se multiplican, fijas inversas que se dividen"; el trigger dividía siempre → con `monthly_avg` el monto sale invertido. **Vivo en prod**: holding `c97951be…` (sistema CLP, `monthly_avg`): contrato CLF 84 con `total_value_system_currency = 0,00` | **Réplica con bug → corregido 30-09** (convención de la tabla del holding: § Pendientes P4) |

## 3. Facturas y líneas (activación C2; y las que crean cambios, NC espejo y consumos)

| Campo | Lo escribía | Regla que aplica hoy la API | ¿Réplica o v2? | Bug conocido | Veredicto |
|---|---|---|---|---|---|
| Qué facturas nacen | `generate_missing_invoices_for_contract` (2 triggers) | Generador v2 único (`generateInvoices`): períodos desde el día de ciclo, `fin = siguiente − 1`, Anticipado/Vencido, pago único **una vez**, Bianual 24, prorrateo del primer/último período (30-09), horizonte de 12 períodos sin término | v2 | U6, Bianual = 12, "juntas" con período del 1, `+30`, `export 0` fijos | **OK v2** |
| `tax_rate` | `auto_populate_invoice_tax_rate` (copia `companies.tax_rate` si NULL) | Exportación 0; Colombia 0 (lo aplica el ERP); si no, la de la compañía **normalizada a %** (`normalizeTaxRate`: 0,19 → 19). Al tocar Por Emitir existentes (cambios, consumos, NC) se normaliza al leer y se reescribe | v2 | Tanda 2 (escala 19 vs 0,19: Lenosoft y Soluciones Digitales, **24 PE vivas** con 0,19); ROADMAP #9 (IVA 19 % fijo en MX/PE) | **OK v2** en el generador; **corregido 30-09** en cambios/consumos/NC (leían la tasa cruda) |
| `vat` | generador viejo (en moneda de contrato) | `headerAmounts`: misma moneda o spot → IVA en moneda de contrato (spot se valoriza al emitir); fija → en moneda de factura | v2 | B2: IVA del encabezado sin × fx | **OK v2** (F8b) |
| `amount_*`, `total_*` (contrato/factura) | generador viejo + `standardize` | Encabezado = Σ líneas; misma moneda FX 1 y montos llenos; spot → moneda de factura NULL; fija → × tasa (`fixedFxAmounts`) | v2 | standardize pisaba la línea (encabezado ≠ Σ líneas), 68 PE mixtas | **OK v2** |
| `fx_contract_to_invoice` | generador viejo (NULL o 1) / clonado por sync | 1 misma moneda; tasa `purpose = 'invoice'` que cubre el **inicio del período** de cada factura; spot NULL; nunca clonada. **Multimoneda**: por línea, la tasa de su par (moneda del ítem → factura) al inicio del período de la línea; el encabezado lleva la del único par convertidor o NULL con dos o más; `invoice_items.contract_currency` = moneda del ítem | v2 | 79 PE con FX pegado (clonación), fijo sin tasa a spot (B3) | **OK v2** (sin tasa: aviso y el scheduler no la emite; multimoneda: bloqueo por par) |
| `fx_contract_to_system`, `system_currency`, `amount_system_currency`, `total_system_currency` | `auto_populate_invoice_fx_to_system` | Tasa a la fecha de emisión (o programada) con la política del holding; **`monthly_avg` multiplica, `fixed_period` divide**; total con IVA **normalizado**; sin tasa FX NULL (nunca 1); multimoneda **sin vueltas** (01-10): líneas ya en moneda del sistema entran directo, solo el resto del encabezado en moneda de contrato se convierte | Réplica + v2 | Mismo bug de dirección que el contrato (24 facturas del holding `monthly_avg` en prod) + IVA en escala 0,19 | **Réplica con bug → corregido 30-09** |
| ídem en la **NC espejo** | ídem (a la fecha de la NC) | FX, moneda y **tasa efectiva de la original** (`mirrorInvoiceSystemAmounts`); sin montos en la original → refresh normal | v2 | ROADMAP #10: "la NC debe replicar EXACTO la factura original en negativo … fx de la original, independiente de la fecha de emisión" | **Réplica con bug → corregido 30-09** |
| `due_date` | generador viejo `+30` | `computeDueDate`: condición del contrato → de la razón social; MX sin condición → mes siguiente; sin ninguna → +30 con aviso | v2 | Medios #11 / SAT MX (13 rechazadas) | **OK v2**; el fallback sin condición: **Pendiente P3** |
| `document_type`, `export_type` | generador viejo `FACTURA`/0 fijos | Familia del documento del contrato; `export_type = 1` solo `FACTURA_EXPORTACION` | v2 | Complejos #4 (La Artesa, TiMining) | **OK v2**; código exacto (33/34/110…) no llega a la factura: **Pendiente P2** |
| `invoice_series` | `'FAC'` | `'FAC'` (consumos: la de la emitida) | Réplica | No existen series (S4b) | **Réplica correcta** (no hay regla v2 todavía) |
| `invoice_terms_and_conditions` | `invoices_fill_terms_from_contract` | Copia del contrato en el INSERT (consumos: la de la emitida o la del contrato) | Réplica | — | **Réplica correcta** (PATCH `/terms` no reescribe PE existentes, mapa §2b) |
| `invoice_group_id` | `assign_invoice_group_id` | `= id` generado en el mismo INSERT; NC: el de la espejada | Réplica | — | **Réplica correcta** |
| `auto_invoice`, `requires_references_for_billing` | generador viejo (del contrato) | Del contrato | Réplica | — | **Réplica correcta** (S6-10 lo apaga por defecto en el contrato) |
| Líneas: `quantity`, `unit_price_*`, `discount_pct`, `subtotal`, `tax`, `total` | generador viejo `1 × total` + `standardize_invoice_items` | Cantidad del ítem × **unitario del período** (mensual × meses, S4-15) × (1 − %); cuota a 2 dec. con residuo en la última (S1-11); IVA por línea; con modelo de precio, `priceLine` (tramos/mínimo/tope) | v2 | "línea `1 × total`", standardize pisando descuentos (CTR-2026-116) | **OK v2** |
| `billing_period_start/end` | generador viejo (desde la emisión) | Período de servicio del ítem (prorrateado si corresponde) | v2 | "juntas: un ítem que parte el 15 recibe el período del 1" | **OK v2** |
| `description` (glosa) | generador viejo (cuenta sí; guiones libres) | `PRODUCTO Cuenta X - Periodo dd/mm/aaaa a dd/mm/aaaa`, solo `-` ASCII; detalle de tramos ASCII (`pricingGlosa`, `asciiGlosa`) | v2 | Tanda 3 #2 (cuenta perdida), regla "sin — ni –" | **OK v2** |
| `contract_item_id`, `product_id`, `status`, `issue_date`, monedas de línea | `standardize` / `auto_populate_invoice_item_fields` / `sync_invoice_item_contract_id` (+ patrón B) | Explícitos en el INSERT; estado y fecha del encabezado | v2 | U3 (moneda de línea ≠ encabezado), adivinar ítem por descripción | **OK v2** |
| `pricing_breakdown`, `quantity_source` | — | Del motor (Pricing v2 §4.2); `fixed` en ítems estándar | v2 | — | **OK v2** |
| `fx_rate_source` / `fx_rate_date` | generador viejo | `scheduled-generation` al activar; `manual`/`net_exact` en F8b | Réplica | — | **Réplica correcta** |
| RSM | `trigger_revenue_schedule_on_contract_activation`, `trg_rsm_on_*` (gateados por holding de sesión) | `revenue_schedule_rebuild(contrato, desde)` explícito en la misma transacción | v2 | U9 (sin sesión no reconstruye), errores tragados | **OK v2** |
| Historial | `trg_audit_contract_changes` → `contract_change_log` | Evento en `contract_lifecycle_events` (`CREATED`, `DRAFT_UPDATED`, `ACTIVATION`, cambios, consumos) con usuario y metadata | v2 | historial duplicado, usuario NULL | **OK v2** |

## 4. Orden de las operaciones (verificado en el código)

**Alta C1** (una transacción): marca → validación completa (`loadContext`: producto, moneda, UF, catálogo, documento, métricas)
→ número correlativo con lock → INSERT del contrato con todos los campos de § 2 → ítems (precios, fin, categoría,
auto-renovación) → precios (`prices`) → `contracts.term` → tasas FX por propósito → cotización "Contrato creado" → evento
`CREATED`. **PUT**: igual, con UPDATE/INSERT/DELETE de ítems por id. ✅

**Activación C2** (una transacción por contrato, contrato bloqueado): marca → validación dentro de la transacción →
**facturas + líneas** (encabezado = Σ líneas; grupo, condiciones, montos en sistema) → con el contrato **aún en borrador**:
booking (si NULL), moneda de compañía y FX a sistema → `status = 'Activo'` → RSM → evento `ACTIVATION`. ✅ Frente al orden del
brief ("campos en borrador → facturas → estado → FX → RSM → evento"): los campos de borrador van después de las facturas
(ninguna factura los lee: el FX de la factura usa su propia fecha) y el FX del contrato va **antes** del estado a propósito:
el guard de período (`trg_00_period_guard_contracts`) protege `fx_rate_to_system` en contratos vigentes y no mira borradores.
El resultado es el mismo que dejaban los triggers (booking BEFORE → FX AFTER). El texto de mapa §2b que todavía describía el
patrón B quedó corregido.

**Campos nuevos que la activación respeta:** documento tributario (familia → `document_type`/`export_type`/IVA) ✅ · condición
de pago (contrato → razón social → MX) ✅ · día de ciclo ✅ · modelos de precio y consumos ya cargados ✅ · política FX y tasas
fijas de factura por período (`purpose = 'invoice'`) ✅ · marcas `requires_references_for_billing` y `auto_invoice` ✅ ·
condiciones de factura ✅ · término indefinido (12 períodos + `indefinite_until` + aviso) ✅ · prorrateo del primer/último
período (`prorated`, aviso) ✅. Huecos: el **código** del documento (33 vs 34, 01, CFDI-I) no llega a la factura y la exenta
lleva IVA (P2); ampliar el horizonte indefinido queda para un bloque posterior (mapa §3).

## Auditoría 01-10 (borrador y activación, construido)

- **Día de ciclo automático**: sin valor explícito, alta y PUT guardan `billing_anchor_day = NULL`; el generador usa el día del primer
  recurrente. `GET /form` devuelve `null` (el editor muestra "Automático"); la activación ya no avisa por el NULL.
- **Tasas "para todo el contrato"** (sin `period_start` ni `period_end`): `contract_fx_period_rates.period_start/end` son NOT NULL y este bloque
  no lleva migración, así que se guardan con el rango centinela `1900-01-01 … 9999-12-31` (cubre todo; el generador, la activación y el
  devengo la resuelven sobre el horizonte real, incluido `indefinite_until`). `GET /form` la devuelve sin fechas. No convive con tasas por
  período del mismo propósito → 400 en `fx_*_rates.N`. Una tasa con inicio y sin fin usa como fin el último fin de los ítems, y un ítem sin
  término cubre su horizonte de 12 períodos (antes daba error). Guardar NULL de verdad requiere migración (pendiente de Leon).
- PUT: `booking_date: null` y `salesforce_opportunity_id: null` (o vacío) borran el valor; ausentes lo conservan. Quitar un ítem con
  `consumption_entries` → 409 `item_has_consumption`. Precio con la misma forma pero otra moneda u otro producto → versión nueva.
  `DRAFT_UPDATED` guarda `fx_rates_diff { changed, before, after }` e `items_diff [{ item_id, before, after }]`.
- Desde cotización: un recurrente sin plazo queda con `term_months = null` (sin término), no 12.
- Activación: blocker `period_closed` (con `next_step`) si alguna factura generada se emitiría en un período cerrado. El evento `ACTIVATION`
  guarda `before`/`after` (`status`, `booking_date`, `company_currency`, `fx_rate_to_system`), `warning_codes`, `indefinite_until`,
  `created_invoice_ids` e `items_affected` (también en la columna).
- `PATCH /contracts/:id/terms`, alta, PUT y `PATCH /contracts/bulk-settings`: `setApiWriter` dentro del `try` (si falla, rollback y release).
  Los eventos `SETTINGS_CHANGED` de una acción masiva comparten `bulk_id` (también en la respuesta).

## Cambia respecto del front viejo

Con las correcciones del 30-09, para el mismo contrato la API deja otros valores que el front viejo / los triggers. Datos de
prod (30-09, solo lectura) para revisar lo creado antes del switch:

| # | Qué cambia | Front viejo / trigger | API v2 | Alcance en prod hoy |
|---|---|---|---|---|
| 1 | `billing_period_price` en modo anual con descuento | Bruto (sin descuento) | Neto | 8 ítems de contrato recurrentes anuales con descuento |
| 2 | `billing_period_price` de un pago único | final ÷ plazo × meses | final | 13 ítems no recurrentes con período ≠ final |
| 3 | Montos en moneda del sistema con `monthly_avg` (contrato y facturas) | ÷ tasa (invertido) | × tasa | Holding `c97951be-0286-4d27-a909-90103a89156f` (sistema CLP): 1 contrato (CLF 84 → 0,00 CLP) y 24 facturas. Los 4 holdings en USD con `fixed_period`: sin cambio |
| 4 | IVA con `tax_rate` 0,19 | 0,19 % | 19 % (y se reescribe `tax_rate = 19` al tocar la PE) | 24 Por Emitir de las 2 compañías con 0,19 |
| 5 | `company_currency` al activar | Solo si era NULL | La de la compañía | 12 contratos con moneda ≠ la de su compañía |
| 6 | Montos en sistema de la NC espejo | Tasa del día de la NC | Tasa de la original | NC que nazcan desde v2 (cambios y reemisión por consumo) |
| 7 | `contracts.term` con un ítem indefinido | Mayor plazo con término | NULL | 0 (el indefinido es solo v2) |
| 8 | Categoría con borradores borrados | — (borrado físico) | No cuentan | 0 contratos con `deleted_at` |
| 9 | Unitario de un ítem con modelo de precio en modo anual | anual ÷ 12 | Mensual equivalente del motor | Solo v2 |
| 10 | Editar una Por Emitir (spec facturas §3.4) | `edit_pending_invoice`: FX `COALESCE(fx, 1)` (spot valorizado 1:1 y montos de contrato = factura ÷ 1), borra las líneas omitidas, IVA con `tax_rate` crudo, ajuste `type = 'edit'` (rechazado por el CHECK) | Moneda de contrato → convención FX de la factura (spot NULL, fija × tasa); nada se borra (cantidad 0 = oculta); IVA normalizado; línea `manual`; motivo tipado en `invoice_adjustments`; sin cobro si todo queda en 0 | 0 usos del modal viejo |
| 11 | Restablecer borrador del ERP | `reset_invoice_odoo_draft`: NULL en `odoo_invoice_id`, `sent_to_odoo_at`, `sent_at`, sin evento | Misma acción + evento `INVOICE_ERP_DRAFT_RESET` (antes, motivo, usuario) y aviso `erp_draft_remains` | Todas las que se restablezcan desde v2 |
| — | Ya eran v2 antes de hoy | `+30`, `export 0`, IVA 19 % fijo MX/PE, one shot en cada período, Bianual 12, glosa con `—`, booking pisada, auto-renovación forzada, FX clonado | Ver § 1–3 | — |

Los triggers del front viejo (y cualquier escritor sin la marca: scheduler de Odoo, webhook, funciones SQL viejas) **siguen con
los bugs 1–5**; en particular el scheduler actualiza facturas por TypeORM sin la marca y `auto_populate_invoice_fx_to_system`
vuelve a dividir en el holding `monthly_avg` (P7).

## Pendientes de decisión de Domi

| # | Tema | Opciones | Recomendación |
|---|---|---|---|
| P1 | **Categoría a nivel cliente** (decisión #9 de `spec-modificaciones-contrato-v2.md` §8): hoy cuentan como "contrato anterior" los borradores no activados y los cancelados; no existe REACTIVATION al volver un cliente churneado | (a) por contrato, como hoy · (b) por cliente derivada (solo contratos que fueron Activo; cliente sin activos vigentes → REACTIVATION) + override con motivo | (b), después del bloque D (afecta waterfall), como ya recomienda la spec |
| P2 | **Documento tributario exacto en la factura**: la factura solo guarda la familia (`FACTURA`/`FACTURA_EXPORTACION`); CL 34 "no afecta o exenta" sale con IVA de la compañía (19 %) y a Odoo como 33 | (a) columna `invoices.tax_document_type_id` + IVA 0 para documentos exentos (tabla o `kind`) · (b) solo IVA 0 para 34 en el generador, sin columna · (c) quitar 34 del selector hasta la matriz fiscal | (a) con Leon (integración Odoo); mientras, (c) para no emitir exenta con IVA |
| P3 | **Vencimiento sin condición de pago** (ni en el contrato ni en la razón social, fuera de MX): hoy `+30` con aviso ("nunca +30 fijo", mapa §3) | (a) bloquear la activación hasta definirla · (b) exigirla en el alta (default de la razón social) · (c) `+30` con aviso, como hoy | (b): el alta ya la precarga; sin razón social con condición, la usuaria la elige |
| P4 | **Convención de `holding_fx_period_rates`**: guardada inversa ("CLP → USD = 950") contra la regla única "1 [from] = rate [to]" (mapa §3b); `fx_rate_to_system`/`fx_contract_to_system` guardan la tasa del lookup, así que su sentido depende de la política. Además `exchange_rates_monthly_avg` tiene pares invertidos (ARS, BRL, EUR, UYU, GBP → USD) | (a) migrar la tabla del holding a directa (1/tasa) + la API multiplica siempre + corregir los pares invertidos · (b) dejar la inversa documentada (hoy: `systemFxDivides`) | (a), en la sesión de datos FX (como `1790610000001` hizo con las tasas de contrato) |
| P5 | **FX a sistema sin tasa**: queda NULL (nunca 1) y nadie lo recalcula cuando llega la tasa | (a) cron/rebuild que complete los NULL · (b) recálculo al emitir y al reconstruir | (a) junto con el "pendiente que se recalcula" de S5b |
| P6 | **Holding sin `holding_settings`**: la factura asume USD/`monthly_avg` y el contrato no escribe | (a) exigir la configuración del holding (alta de holding) · (b) default USD en ambos | (a) |
| P7 | **Escritores sin la marca** (scheduler, webhook Odoo, funciones SQL) siguen pasando por `auto_populate_invoice_fx_to_system` / `calculate_contract_fx_amounts` con la división fija | (a) corregir también los assets (dirección por política) · (b) que esos escritores fijen la marca y usen los helpers de la API | (a) ahora (asset chico, QA → prod con Leon); (b) al migrar Facturación |
