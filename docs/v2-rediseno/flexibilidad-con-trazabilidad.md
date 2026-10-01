# 🧩 Principio de producto v1.2 — Flexibilidad con trazabilidad

> **Pedido de Domi (22-08)**: Sapira nació muy estricto (reglas duras, bloqueos, triggers que pisan montos, validaciones que además fallan) y eso **quitó adopción**: en onboarding los usuarios se frustran, se equivocan al registrar y culpan al sistema. La v1.2 debe **darle flexibilidad al usuario manteniendo la lógica y la trazabilidad** — y esto toca front Y base de datos (por eso en algún momento se pensó partir de cero). Este doc ordena el principio, los casos concretos que pidió Domi (HOY → DELTA → cómo lo hacen los benchmarks) y qué NO se flexibiliza.

## El principio en una frase

> **El usuario puede hacer lo que el negocio necesita; el sistema registra qué, quién, por qué y recalcula lo derivado.**

Tres mecanismos (en vez de prohibiciones):

1. **Editar libremente lo no emitido, regenerar lo derivado**: todo documento en borrador es editable (líneas, montos, fechas, receptor, moneda); el sistema recalcula facturas futuras y devengo. La única frontera dura es la emisión _(Zenskar: draft editable ilimitado + "regenerate"; Relvo: `draft_body_origin generated|operator_edited`)_.
2. **Desvíos explícitos, no bloqueos**: apartarse del plan (facturar distinto, cambiar moneda, repartir entre razones sociales) se registra como un **evento con motivo** y queda visible; el plan original no se pierde _(Maxio: `invoice.role` + event log; Relvo: `/versions` + `/activity`)_.
3. **Guía antes de persistir**: preview del impacto + sugerencia agéntica; las reglas "blandas" avisan y dejan continuar con motivo; solo los invariantes fiscales/contables bloquean _(Alguna: `changes/preview` obligatorio; Maxio: previews en todo lo que cobra)_.

## Los casos concretos (HOY → DELTA)

### 1. Facturar distinto a lo planificado — "llegar y editar"

**HOY**: la factura Por Emitir se edita por partes (bulk de descripciones/términos/receptor/FX, `edit_pending_invoice`, reprogramar, Reestructurar con modos, ajuste a lo emitido) con muchos bloqueos explicativos; el trigger `standardize_invoice_items` pisa montos; el cambio "rompe" la continuidad del contrato y exige pasos en un orden (`docs/facturacion/orden-operaciones-facturacion.md`).
**DELTA**: el documento en borrador es **libremente editable como un todo** — líneas con `amount_basis unit_rate|exact_total` y `source billing_engine|manual` _(Relvo `DocumentLine`)_, fechas, receptor, moneda — sin trigger que pise nada. El contrato **no se rompe**: la diferencia entre lo planificado y lo facturado se guarda como **ajuste con motivo** (evento) y el devengo se recalcula a partir de lo facturado con el contrato como referencia; si no cuadra, el sistema lo **marca** (invariante de balance triple con flag — _Maxio `unbalanced_revenue_exception`_), no lo impide. Lo emitido sigue inmutable: NC/ND o "ajustar a lo emitido" (ya existe).

### 2. Ítems en distintas monedas, facturados en una sola moneda con distintos métodos de FX

**HOY**: moneda única por contrato + `invoice_currency` + política FX por contrato (fijo/spot) + override por factura; las líneas heredan; mezclar líneas "convertidoras" con tasas distintas se bloquea (caso ILUMI PEN+USD→PEN); UF operativa pero con parches.
**DELTA**: **moneda por LÍNEA de contrato** (una línea en USD, otra en UF, otra en CLP — _Zenskar: `currency` dentro de cada `pricing_data`; Maxio: `currency_prices[]` por item_), **moneda del documento por ruta de facturación**, y **método de FX por línea**: fijo contractual / oficial a fecha (emisión, inicio de período, pago) / manual — con la **escalera de precedencia persistida** `same_currency → contract_rate → manual_override → official → derived` y `fx_rate + fx_rate_source` guardados **por línea** _(Relvo)_; totales `deferred_fx` hasta la emisión. Ya se decidió en A.3 del doc 03; aquí queda el porqué de adopción.

### 3. Facturar por % o montos distintos a distintas razones sociales / entidades facturables

**HOY**: `contract_billing_splits` existe con 0 filas (nunca se conectó); lo real es unificar/consolidar/dividir DESPUÉS de generar; el emisor es uno por contrato y el receptor uno por factura.
**DELTA**: **ruta de facturación declarada en el contrato** _(Relvo `invoice_route`: N facturas con receptor = vínculo razón social, moneda, líneas visibles, `split_group/split_weight` para repartir por peso o %, y la OC que cada una exige)_ — reparto por **%** o por **montos fijos**, editable en cualquier momento para las facturas futuras, con el historial de cambios. Consolidación parent/child como caso particular _(Maxio subscription groups / Alguna roll-up)_. Decisión A.5 del doc 03.

### 4. Upselling / downselling mucho más simple e intuitivo (desde oportunidad ganada en Salesforce o HubSpot, o manual)

**HOY**: `AssignToContractModal` + RPCs `create_contract_upsell/downsell/cross_sell/churn/renewal` + `ContractionModal` con 5 modos + amendments; bugs recurrentes (períodos solapados, moneda ignorada, duplicados, downsell total rechazado); política "editar ítems = solo corrección, lo comercial por Modificaciones" difícil de explicar.
**DELTA**: **un solo flujo "Modificar contrato"** con cambios tipados (`add | update | remove` de líneas, `effective: immediate | next_period | date`) y **preview obligatorio** del impacto en facturas futuras, devengo y NC _(Alguna Changes API)_, **prorrateo elegible por cambio** (`full | none | credit_only | charge_only`) en vez de lógica fija _(Alguna/Maxio)_, fases para lo planificado (ramp/trial/pausa) _(Zenskar)_, y el **origen** del cambio (`quote` Salesforce/HubSpot ganada · manual) como metadato trazable. Con guía agéntica: el agente de contratos propone el cambio a partir de la oportunidad ganada y el usuario confirma. Decisión A.4 del doc 03.

### 5. Reglas que fallan → reglas blandas con motivo

**HOY**: ~120 triggers y ~150 funciones con validaciones duras (CHECK cantidad>0, `prevent_end_date_update_when_active`, guards de período, validaciones de moneda/FX antes de firmar…) que a veces fallan o bloquean casos legítimos, y el usuario no sabe por qué.
**DELTA**: clasificar cada regla en **invariante** (bloquea, y explica) o **advertencia** (avisa, pide motivo, deja continuar y registra el evento). Es insumo directo de la sesión de funciones/triggers (paso 4): cada función viva se clasifica conservar-como-invariante / convertir-en-advertencia / eliminar.

### 6. Facturar un monto cerrado por OC (parcial del período) sin perder de vista el saldo

> **Caso real (Domi 29-09, Alicorp CTR-2026-55, SimpliRoute Perú):** el contrato acuerda 5 servicios fijos en USD (24.074,20/mes, facturados en PEN), pero el cliente emite **OC por montos cerrados** que no calzan con el mes: julio se pagó en dos OC (6.609,12 USD en la factura de julio y 17.465,08 USD en la de agosto, como una línea "recurrente de Julio"), y septiembre llegó con una OC por **58.839,87 PEN** (= 17.465,08 USD). La usuaria emite **una sola línea global** por el monto de la OC; no sabe (ni necesita saber) qué servicios cubre, solo que **queda un saldo pendiente según lo acordado** que se facturará más adelante. Además no sabe con qué cuadra en moneda de contrato, porque la OC viene en moneda de factura.

**HOY**: no hay flujo. La usuaria edita el borrador en Odoo (una línea con el monto de la OC) y emite; Sapira queda con el mes completo "por emitir" o con líneas que no calzan con el documento legal, el validador de Reestructurar muestra diferencias ficticias y el saldo se pierde de vista. El cuadre se hizo a mano por BD: descomponer el monto de la OC en los ítems que calzan al centavo (la única combinación posible), dejar esas líneas vinculadas al documento emitido y mover el resto a una factura "pendiente de facturar" con el período de cada línea (ver registro maestro de memoria, cierre 29-09).
**DELTA**:
1. **Factura parcial por monto cerrado**: desde el período, la usuaria ingresa el monto de la OC (en moneda de factura) y el sistema **propone qué ítems calzan** (combinación exacta si existe; si no, uno parcial con cantidad × precio de lista, ej. 504,04 de 560 licencias). Ella confirma o ajusta.
2. **Saldo explícito, no perdido**: la diferencia queda automáticamente como **documento o ítems "pendientes de facturar"** del mismo período (cada línea conserva su período de servicio), visible en el contrato y en las alertas ("te quedan 6.609,12 USD de septiembre por facturar"), y se puede sumar a una factura futura (el "recurrente de Julio" en agosto) o emitir aparte.
3. **Vista al cliente distinta de la vista interna**: el documento legal muestra **una sola línea** (texto libre + OC/HES), mientras Sapira mantiene **N líneas internas vinculadas a los ítems** para la trazabilidad y el devengo. Es el modelo `document_line` (visible) ↔ `line_allocation` (interno) — el mismo patrón que la ruta de facturación con líneas visibles del caso 3 _(Relvo: `visible lines` por ruta)_.
4. **Tipo de cambio**: la OC fija el monto en moneda de factura; el sistema lo convierte a moneda de contrato con el FX del documento y registra la **diferencia de cambio** del saldo, que se liquida al facturar lo pendiente (no se "arrastra" como diferencia fantasma). Conecta con el caso 2 (FX por línea).
5. **Ítems variables o por consumo**: si algún ítem del período es variable, el saldo no es fijo: primero se cierra la cantidad real del período (override) y recién ahí se calcula el pendiente. El sistema debe advertirlo ("hay consumo sin cerrar en este período; el saldo puede cambiar") en vez de bloquear.
6. **Trazabilidad**: evento `partial_billing` con OC/HES, monto, ítems cubiertos, saldo generado y quién lo decidió; el balance triple muestra el saldo como "facturación diferida acordada", no como desbalance.

## Qué NO se flexibiliza (invariantes)

1. **Documentos emitidos** son inmutables (folio fiscal): solo NC/ND o ajuste a lo emitido.
2. **Períodos contables cerrados**: nada se reescribe; los ajustes caen al primer período abierto _(Zenskar redistribución)_.
3. **Balance triple** plan ↔ facturado ↔ devengado: no se impide el desbalance, pero **siempre se marca y se explica**.
4. **Tenancy**: nada cruza holdings.
5. **Trazabilidad**: todo desvío deja evento (quién, cuándo, qué, por qué) — es la condición que hace posible la flexibilidad.

## Impacto en el modelo (ya cubierto por decisiones del doc 03)

A.3 moneda y FX por línea · A.4 cambios tipados con preview y prorrateo elegible · A.5 ruta de facturación declarada · A.6 documento con ejes de estado + líneas editables + event log tipado · A.9 balance triple como flag · caso 6 (facturación parcial por OC): línea visible del documento ≠ asignación interna a ítems + saldo pendiente como estado explícito — **nuevo, a incorporar al modelo** · agentes de guía (doc `04-spec-modelo-dominio-v2/agentes-ia-funcionalidad-agentica.md`). **Este principio es el "porqué de adopción" de esas decisiones** y se suma al principio transversal de usabilidad + IA.

## Cómo se mide (para saber si funcionó)

Menos tickets de soporte por "el sistema no me deja"; menos registros corregidos por onboarding (hoy se cuadran a mano — ver memorias de onboarding/cuadre); tiempo de un upsell desde oportunidad ganada a facturas generadas; % de facturas editadas sin pasar por reestructurar/ajuste.
