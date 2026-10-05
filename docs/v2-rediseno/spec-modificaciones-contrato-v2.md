# Spec · Modificaciones de contrato v2 (M1–M6 del mapa)

> 28-09-2026 · borrador para revisión de Domi; implementadores: api-sapira (`src/modules/contracts`) y front-sapira
> (`app/(protected)/lab/contratos`). Consolida lo ya decidido en [`auditoria-contratos.md`](./auditoria-contratos.md)
> (§6, S2, S3, S4, S5, S6), [`manual-modificaciones-contratos.md`](./manual-modificaciones-contratos.md),
> [`mapa-v2-contratos.md`](./mapa-v2-contratos.md) (§1, §2d, §3, §4, §5), [`flexibilidad-con-trazabilidad.md`](./flexibilidad-con-trazabilidad.md),
> [`mejoras-y-brechas.md`](./mejoras-y-brechas.md) (A.4, E.2) y los benchmarks de `benchmarks/`. Cada regla se marca
> **DECIDIDO** (con la fuente) o **ABIERTO** (qué falta decidir, opciones, recomendación). Lo que no está en ningún
> doc y hace falta para escribir la spec va como **Supuesto**. Este documento no toma decisiones nuevas.
> **01-10**: los ABIERTO de §2 y las preguntas de §8 quedaron decididos; alcance final y diseño del bloque 2 en **§9**.

## 0. Alcance y marco

- Cubre toda operación sobre un contrato **Activo** (o Por renovar / Vencido / Cancelado según el tipo) que cambia lo
  comercial o las condiciones: precio/cantidad, alta y baja de ítems, fechas, renovación, pausa, cancelación, reajuste,
  moneda, razón social/compañía, condiciones. **No cubre** editar ítems como corrección (F4 del mapa, `PUT` de campos
  cambiados con evento `CORRECTION`) ni editar la factura Por Emitir como documento (F2).
- Marco fijo (DECIDIDO): se construye **al lado** de lo viejo, sobre las mismas tablas, lógica en la API con una
  transacción por operación y preview con el mismo cálculo (`mapa-v2-contratos.md` §1.1–1.2, Domi 25-09); flexibilidad
  con trazabilidad: lo no emitido se edita y regenera, los desvíos quedan como evento con motivo, solo bloquean los
  invariantes (`flexibilidad-con-trazabilidad.md`, "Qué NO se flexibiliza").
- Lo que el front viejo ofrece hoy (`sapira-ai/src/components/contratos/lifecycle/ContractLifecycleMenu.tsx`): Renovar,
  Upselling, Cross-selling, Down-selling, Renegociación, Churn, Modificación (T&C); desde Cotizaciones, "Asociar a
  contrato existente" (`sapira-ai/src/components/cotizaciones/modals/AssignToContractModal.tsx`). Cambio de moneda solo
  en borrador (`edit/EditableContractItems.tsx:379` → `change_contract_currency`); razón social solo por BD; pausa no existe.

## 1. Patrón común (lo que los docs ya fijan)

| Regla | Estado | Detalle y fuente |
|---|---|---|
| **Fecha efectiva manda** | DECIDIDO | Una fecha efectiva deriva todo: cortes, `churn_date`, NC, RSM (S3 "Reglas propuestas (S3b)", U5, mapa M2). Default: inicio del ítem cotizado cuando viene de cotización (S3-4); la booking va aparte (S1-13). Hoy el CHURN arranca el día 1 del mes (`apply_contract_contraction.sql:137`) y `churn_date` usa el día exacto: 20 de 51 contratos inconsistentes |
| **Modelo acumulativo** | DECIDIDO | El ítem original nunca se edita; cada cambio agrega un ítem de ajuste con signo y `related_item_id`; RENEWAL con `renews_item_id`; el renovado/cortado/absorbido lleva `renewed_by_item_id` (manual §0 y "sí o sí" #1). Es la base del ítem madre (`src/modules/contracts/contract-items.ts` `buildItemGroups`), del estado (`contract-status.ts`) y del momentum del RSM |
| **Categoría / momentum** | DECIDIDO | `categoria` ∈ NEW, UPSELL, CROSS-SELL, DOWNSELL, CHURN, RENEWAL, REACTIVATION; v2 la manda calculada (costura con `trg_set_contract_item_categoria`, mapa §4). CROSS-SELL cuando el producto no existe en el contrato (mapa M1). Downsell al 100% de un ítem se deriva a contracción/churn (S3-7) |
| **Evento siempre** | DECIDIDO | `contract_lifecycle_events` con usuario, motivo, tipo normalizado (UPSELL, CROSS_SELL, DOWNSELL, RENEGOTIATION, CHURN, RENEWAL, REACTIVATION, CORRECTION, ACTIVATION…), `effective_date`, `amount_delta` (ΔMRR con signo), `items_affected`, origen `manual` \| `quote:<id>` (mapa §1.5; columnas en `entities/contratos/contract-lifecycle-event.entity.ts`; lector `contracts.service.ts` `normalizeEventType`). Aprobación de modificaciones: **se elimina** (S3-10; nota: "Decisiones pendientes" #7 aún la lista como abierta → confirmar que S3-10 la cierra) |
| **Preview antes de aplicar** | DECIDIDO | Mismo cálculo sin escribir; "se suma a la factura X / se crea nueva" (mapa §1.2 y M1; Complejos #7; flexibilidad, mecanismo 3) |
| **Prorrateo** | DECIDIDO | Upsell y cross-sell: primer tramo **por días exactos** hasta el día de ciclo (D-C, S3-5, S5-16), en la factura del ciclo o **factura suelta inmediata a elección de la usuaria** (S3-17); el generador v2 ya lo hace (`billing-engine.ts`, "primer tramo va en la factura del primer ciclo"). **Downsell y renegociación sin prorrateo: rigen desde el próximo inicio de período** (S3-5/S3-6). NEW, RENEWAL y REACTIVATION no prorratean (manual §11). Último período corto proporcional (S4-16). Frecuencias de la tabla única (S4-11, `BILLING_FREQUENCY_MONTHS`) |
| **Por Emitir vs emitidas** | DECIDIDO | Emitidas **inmutables**: NC espejo exacto de la original en moneda y FX (ROADMAP #10, mapa M2) o "ajustar a lo emitido"; **frontera de lo facturado** = `MAX(billing_period_end)` emitido del ítem, nunca se reescribe (manual "sí o sí" #4). Por Emitir: **cambio mínimo** (F3, S4-2): se toca solo la línea del ítem afectado y se recalcula el encabezado (ROADMAP #11); línea **neta** en downsell y, opcional, en upsell (S3-14); nunca líneas negativas hacia Odoo (manual #6); fusión por (contrato, receptor, moneda, tipo de documento, mes de emisión) solo con PE activas, no legacy, no unificadas/consolidadas, sin NC (S3 segunda vuelta A, S3-13); la línea que se suma hereda política y tasa FX de esa PE (S6-2) |
| **RSM** | DECIDIDO | `revenue_schedule_rebuild(contrato, desde_mes)` explícito en la misma transacción (mapa §1.4); meses cerrados congelados, ajustes al primer mes abierto (S5-7); devengo = precio mensual × fracción del primer mes + meses completos, sin doble prorrateo (S5-16); renovación con cambio de precio: mes 1 separa RENEWAL y delta, luego BOP (manual #12). Fix compartidos previos: U8 (acumulado), U9 (holding del registro) |
| **MRR (S5)** | DECIDIDO | "El" MRR excluye pendiente de renovar (S5-3); pendiente se mantiene hasta que la usuaria decida, con alertas crecientes (S5-4); ΔMRR del cambio = `qty × unit` del ítem delta, ancla en la dimensión que no cambia (manual §8). Clasificación a nivel cliente (NEW/REACTIVATION/…) del benchmark §6: **ABIERTO** (ver §8) |
| **Period guard** | DECIDIDO | Invariante que v2 respeta: `trg_period_guard_contract_items` bloquea (o avisa, según modo) INSERT/DELETE de ítems con `start_date` en período cerrado; `trg_period_guard_contracts` y `prevent_end_date_update_when_active` igual, salvo bypass explícito **con evento** para mover el fin del contrato (mapa §4). Un cambio con fecha efectiva en período cerrado → bloqueo explicativo con el paso siguiente ("reabrir en Configuración") |
| **Herencia como defaults** | DECIDIDO | El ítem nuevo hereda del padre/contrato tipo, método, frecuencia, moneda, política FX, ciclo, vencimiento y tipo de documento como **defaults editables**, no reglas duras (S3-19, obs. 3 de Domi); co-terminación con el contrato (D-B); ciclo del contrato explícito `billing_anchor_day` (S3-16) |
| **Encabezado del contrato** | DECIDIDO | Fin del contrato = **el más próximo** de los ítems recurrentes no renovados ni cancelados (S2-13/S3-11); `total_value` y `term` recalculados en la base al cerrar cada operación (S3 reglas propuestas; hoy `update_contract_term` toma el MAX y nadie actualiza `contract_end_date` salvo `apply_quote_downsell_to_contract` rama B) |
| **Costura `sapira.writer='api'`** | ABIERTO (pendiente OK Domi + Leon, mapa §7.1) | Sin ella, v2 debe usar los patrones actuales (línea sin `contract_item_id` + UPDATE; `bypass_end_date_guard`). No cambia la spec, solo la implementación |

## 2. Catálogo de operaciones

Formato: significado · hoy (flujo y bugs) · reglas v2 DECIDIDO · ABIERTO.

### 2.1 Cambio de precio y/o cantidad de un ítem (upsell por cantidad o precio, downsell parcial, renegociación)

- **Significado**: el mismo producto sigue, cambia cantidad, unitario, descuento y opcionalmente frecuencia o fin. Sube
  → UPSELL; baja → DOWNSELL; ambos ejes → renegociación (mismo cálculo, manual "complejidad accidental" #1).
- **Hoy**: tres puertas (`UpsellingModal`, `ContractionModal` con 7 modos, `AssignToContractModal` con 5 tipos) y dos
  RPC (`apply_quote_downsell_to_contract` ramas cantidad/precio/renegociación; upsell inline sin transacción en 5 tablas).
  Bugs: dos ejes a la vez pierden el término cruzado (STG −46,40 vs +51,20, manual §3); merge por mes de emisión o fecha
  exacta según la puerta; `due = emisión`; moneda del ítem con fx 1 (U10/B1); evento de historial falla siempre desde
  UpsellingModal (`created_by`); downsell por precio desde cotización se ejecuta por cantidad; segundo downsell escala
  contra el mensual original; downsell permite quitar el 100% (S3-7); renegociación con 0 usos en prod (manual §8).
- **DECIDIDO**: una sola entrada "valores nuevos completos" `(q, p, desc, frecuencia, fin)` + fecha efectiva; fórmula
  unificada del delta (manual §8: `ΔMRR = mensual_nuevo − mensual_actual`, `qty × unit = ΔMRR`, ancla en la dimensión
  que no cambia); descuento % preservado (manual #15); final/delta/mensual/anual son ayudas de captura, el backend
  recibe `(q_n, p_n)` (manual "complejidad accidental" #2); `unit_price` persistido mensual (manual #14); downsell rige
  desde el próximo período sin prorrateo (S3-5/6); upsell prorratea el primer tramo (S3-5, S3-17); línea neta en PE
  para downsell y opcional en upsell (S3-14); cantidades variables fuera de la renegociación (manual #16, S7-7);
  aviso de posible duplicado (misma dirección, producto y fechas, mapa M1).
- **ABIERTO**: (a) **renegociación con cambio de frecuencia o término** — hoy corta el original, crea RENEWAL al valor
  anterior + delta y extiende el fin (manual §8 rama B); S3-15 propone "por confirmar" un solo almacenamiento explícito
  (RENEWAL al precio anterior + ajuste). Recomendación: confirmar S3-15 y modelar este caso como `renewal` con
  `price_change` (§4), no como `item_change`. (b) **Prorrateo elegible por cambio** (A.4: `full | none | credit_only |
  charge_only`) vs reglas fijas de S3-5. Recomendación: reglas fijas (ya decididas) + una sola opción visible, "cobrar
  el tramo inicial ahora / en la próxima factura" (S3-17); el resto de comportamientos no se exponen hasta que un caso
  real lo pida (en Chile cada crédito es una NC, benchmark §2).

### 2.2 Alta de ítem (upsell de producto nuevo → cross-sell; desde cotización o manual)

- **Hoy**: `CrossSellingModal` → `create_contract_cross_sell` → `approve_contract_amendment` (plazo 12 y USD por
  defecto, sin prorrateo, `due = emisión`, `export_type` heredado, `recalc_revenue_for_contract` borra el cronograma) y
  `AssignToContractModal` (inserta ítem, facturas y líneas desde el navegador, líneas 702–997). Bugs: período "1 a 1"
  (`invoiceCalculator.ts:193, 210`), ancla al booking (Bosch), plazo sin acotar (20 de 44 ítems), UPSELL de producto
  inexistente (39 amendments), IVA 19% fijo (129 líneas MX, 37 PE), moneda de la cotización, facturas del ítem nuevo no
  generadas al asociar a contrato En revisión (Stanhome), sin transacción.
- **DECIDIDO**: solo sobre contratos Activo (S3-1); cotización "Nuevo cliente" sobre contrato existente se bloquea con
  validador (S3-3); método: la usuaria elige, default el del padre (S3-2); CROSS-SELL si el producto no existe (mapa M1);
  co-terminación con el contrato (D-B), primer tramo proporcional por días en la factura del ciclo o suelta (D-C,
  S3-17); tipo de ítem heredado del padre, master data por holding (S3-19); moneda y política FX del contrato, IVA de la
  compañía y regla del país, vencimiento por términos, tipo de documento (U10, B1, mapa §3); facturas vía generador F1
  + F3 agrupando por período; la cotización pasa a "Contrato creado" solo al final (mapa M1); origen `quote:<id>`.
- **ABIERTO**: cross-sell en **otra moneda** facturado junto (S1-16 corregido: multimoneda solo cuando se facturan
  juntos; M3 es etapa propia de S6). Recomendación: hasta M3, el ítem hereda la moneda del contrato y el preview lo dice.

### 2.3 Baja de un ítem (downsell total de ítem, churn parcial)

- **Hoy**: `ContractionModal` tipo DOWNSELL modo `full` o CHURN por ítem → `apply_contract_contraction`: fantasma
  negativo desde el día 1 del mes (`:137-140`), cancela la PE **entera** aunque tenga líneas de otros ítems (ROADMAP #11,
  Stanhome), NC nace Emitida con el monto de moneda contrato en el campo de moneda factura (ROADMAP #10, 13 NC), no
  hay reversión (S08255 por SQL).
- **DECIDIDO** (mapa M2): early (efectiva ≤ fin) vs non-renewal (fin + 1); **manda el inicio del ítem CHURN** (U5):
  `churn_date`, cortes y NC usan esa fecha; en PE se quita solo la línea del ítem y se recalcula el encabezado; emitidas
  del período con NC espejo exacto; ítems con MRR 0 no bloquean; motivo de catálogo `churn_reasons`; non-renewal sin ítem
  (UPSERT + cola BOP), early con fantasma (manual #11); un producto que se quita mientras siguen otros es DOWNSELL a
  nivel métricas, no CHURN (benchmark §6 — coincide con la categoría actual). Reactivar ítems individuales (S3-9).
- **ABIERTO**: nada estructural. Nota: el fantasma negativo y el DOWNSELL parcial son el mismo modelo (manual
  "complejidad accidental" #4); la spec los unifica en `item_remove` (total) e `item_change` (parcial).

### 2.4 Cambio de fechas (extensión o acortamiento de un ítem)

- **Hoy**: "Editar ítems" reenvía inicio y plazo → el trigger `set_contract_item_end_date` recalcula el fin en cada
  guardado (causa de Bosch, S3 segunda vuelta B); `prevent_end_date_update_when_active`; `contract_end_date` nunca se
  actualiza salvo por la rama B de la renegociación; `update_contract_term` toma el MAX.
- **DECIDIDO**: el fin es un **campo explícito** que v2 escribe (mapa §4, F4); **extender = renovación explícita**, un
  ítem nuevo no extiende el contrato (D-B); fin del contrato = el más próximo (S2-13); corregir una fecha por error de
  carga es F4 (`CORRECTION`) si no hay emitidas en el rango; si las hay o cambia el MRR hacia adelante, deriva a
  Modificar (F4). Término indefinido (M5, S1-12) es diseño pendiente y afecta esta operación.
- **ABIERTO**: **acortar** un ítem activo (terminar antes sin ser churn early). Opciones: (1) es un `item_remove` con
  timing non-renewal y fecha efectiva = nuevo fin + 1 (sin fantasma, `churn_date`, cola BOP/CHURN en el RSM); (2) tipo
  propio `change_dates` que corta el ítem y regenera PE. Recomendación: (1), porque la métrica es la misma (deja de
  haber MRR) y evita un tercer modelo de contracción; la UI puede llamarlo "Terminar antes".

### 2.5 Renovación (manual, parcial por ítem, propuesta automática)

- **Hoy**: `EnhancedRenewalModal` (1 ítem) / `MultiItemRenewalModal` (**una llamada por ítem**) → `create_contract_renewal`
  v2: `export_type = 1` fijo (137 de 150 PE de renovación en exportación), `due +30`, último período parcial cobrado
  completo, no actualiza fin ni TV (27 de 33), absorbe UPSELL hijos pero el trigger recalcula `monthly` sin ellos
  [no verificado], `renewal_base_unit_price` + `apply_renewal_price_split` en el RSM. Auto-renovación: cron
  `process_auto_renewals(90)` → `execute_auto_renewal_for_item` → falla siempre ("Usuario no encontrado"); 290 ítems
  `auto_renew` de SimpliRoute entran a la ventana desde ~02-10 (S2 auditoría).
- **DECIDIDO**: una operación atómica para N ítems (S3-8); nunca sobre renovados, cancelados, con churn o sin
  auto-renovación (S2-2); un solo modelo de negocio: RENEWAL al precio anterior + ajuste explícito (S3-15); facturas con
  F1 (tipo de documento, vencimiento por términos, último período proporcional S4-16); actualiza fin del contrato (el
  más próximo) y `total_value` (mapa M3); la auto-renovación **propone** N días antes (30 por holding, S2-2/S2-3) y la
  usuaria confirma; renovación tardía retroactiva: la usuaria elige corregir hacia atrás o catch-up en el mes de la
  renovación (S5-4); Por renovar / Vencido reversible (S2-1); RSM split mes 1 (manual #12).
- **ABIERTO**: (a) S3-15 "por confirmar": camino corto (un paso) que por debajo guarda dos ítems — recomendación:
  confirmar, es lo que ya usan ítem madre e historial; (b) decisión pendiente #5: arreglar el cron o apagarlo — el mapa
  (E2) asume que **no se arregla** y se reemplaza por la propuesta con confirmación; recomendación: apagar el cron al
  publicar E2 y no antes (hoy falla, no hay riesgo); (c) **uplift / `renewal_policy`** (`action_at_term_end`,
  `uplift_pct`, `pricing same | uplift | catalog`, benchmark §3 opinión) → se diseña junto con S1-18 (§2.8).

### 2.6 Pausa y reanudación

- **Hoy**: no existe (Complejos #9, verificado sin tabla ni campo); se simula con RENEWAL + DOWNSELL y causa el sub-bug
  B del RSM (BAM-01, Carelis, períodos sin cobro TiMining). `Pausado` ya está reservado en el estado derivado
  (`contract-status.ts`), hoy 0 contratos.
- **DECIDIDO**: acción propia, no una modificación, **también masiva**; pausa el reconocimiento y deja el MRR en un
  estado especial (S2-12); requiere investigar la industria antes de diseñar (S2-12, Complejos #9); el benchmark ya
  existe (`benchmark-modificaciones-pausa-escalamientos.md` §4).
- **ABIERTO** (todo el diseño, con la opinión del benchmark como propuesta): `scope billing | service` (Stripe separa
  `pause_collection` de pausa real; Relvo `billing_behavior bill_through_pause | hold_unbilled`), inicio inmediato / fin
  de período / fecha, `resume_at` opcional, `extend_term` al reanudar (Zenskar `unpause_extension_policy`), MRR 0 sin
  churn y CMRR mantenido si hay reanudación (Chargebee), pausa por ítem vs por contrato. Recomendación: pausa **por
  ítem** con `scope service` como único modo inicial (devengo 0 y MRR 0 en el tramo, PE del tramo canceladas o
  recortadas, `extend_term` como opción), estado del contrato `Pausado` derivado cuando todos los recurrentes vigentes
  están pausados; `billing` (solo posponer borradores) se evalúa después porque toca emisión. Modelo de datos: tabla
  nueva `contract_item_pauses` (ítem, desde, hasta, extiende, motivo) en vez de ítems fantasma, para que el RSM y el
  ítem madre lean el tramo explícito. **No construir hasta que Domi cierre estos puntos.**

### 2.7 Cancelación (churn total)

- **Hoy**: `ContractionModal` tipo CHURN con todos los ítems → `apply_contract_contraction`; el contrato pasa a
  Cancelado cuando no quedan ítems activos y `cancel_contract_invoices_on_contract_cancelled` cancela el cronograma;
  4 Cancelados con 6 PE vivas; no existe revertir; borrado físico permitido en Cancelado.
- **DECIDIDO**: `contracts.status` solo cambia por acción explícita (Domi 25-09, mapa §2a); Cancelado nunca se borra
  (S2-9); mismas reglas de M2 para fecha efectiva, NC espejo y PE; **Reactivar** con motivo restaura ítems y PE cuidando
  fechas (S2-8), también ítems individuales (S3-9); `REACTIVATION` ya existe como categoría y momentum. NC de anulación
  a Odoo como NC real: con Leon (S4-8).
- **ABIERTO**: ventana de reversión (benchmark §5 opinión: churn programado no vigente → anular sin impacto; vigente
  antes del cierre → reversión que reescribe filas CHURN; después → REACTIVATION). Recomendación: adoptar las tres
  ramas con la frontera en el **cierre de períodos** (S5-7) y marcar el evento original como revertido
  (`metadata.reversed_by`); no requiere columna nueva.

### 2.8 Reajuste (IPC, UF, escalamientos, condiciones pactadas al crear)

- **Hoy**: no existe. UF es moneda de contrato (se factura y cobra en CLP, sin diferencia de cambio: aclaración Chile
  en S6 segunda vuelta) y no un reajuste. SimpliRoute hace el ajuste anual en diciembre con upsells manuales y
  términos a diciembre para renovar todo junto (ROADMAP Estratégico #25).
- **DECIDIDO**: S1-18: ajustes pactados desde el inicio (año 2, X % anual, auto-renovación con % de ajuste) afectan
  ítems (categoría y momentum) y facturas futuras, **se diseñan con S3**; conecta con #25 y las fases de A.4; reajuste
  UF sin cuenta especial, misma lógica que la diferencia de cambio (S5-13); término indefinido (M5).
- **ABIERTO**: el modelo: (1) **fases** Zenskar (ramps/pausa/amendment como fases del contrato, `is_enabled` por
  vigencias); (2) **versiones programadas + `price_escalation`** Alguna; (3) cambios tipados **programados** que se
  materializan en su fecha como ítem `UPSELL` subtipo `price_step` (benchmark §3 opinión, momentum en el CMRR desde la
  firma). Recomendación: (3), porque no exige nuevas primitivas sobre `contract_items` y el RSM: un reajuste es un
  `item_change` con `effective_date` futura y `schedule { kind: pct | amount | index(IPC) , every_months }` guardado en
  una tabla `contract_scheduled_changes`; al llegar la fecha (o al confirmar la usuaria) se aplica con el mismo motor de
  §4. Construir solo después de decidir (§6, fase D).

### 2.9 Cambio de moneda

- **Hoy**: `change_contract_currency` solo antes de firmar (rechaza Firmado/Activo/Cancelado/Expirado) y pisa ítems y
  cronograma; en activo solo la **moneda de facturación** de PE con `InvoiceCurrencyBulkUpdate` / `apply_fixed_fx_to_contract`.
- **DECIDIDO**: moneda del contrato: una, validada por trigger, cambiable solo antes de activar (S5b; C1 la pide al
  crear); UF nunca es moneda de facturación (mapa §3b); en un contrato vivo cada **factura** define su FX (S6-1), fijo sin
  tasa nunca se envía (S6-2), cambiar la moneda de PE ya enviadas a Odoo como borrador se restablece y reenvía (S6-3).
- **ABIERTO**: cambiar la moneda del **contrato** activo no es una modificación: es multimoneda (M3). Recomendación:
  no ofrecer `change_currency` en v2; ofrecer solo "moneda y política FX de facturación para las PE futuras" como
  condición (§2.11) y dejar M3 para S6.

### 2.10 Cambio de razón social receptora, cliente comercial o compañía emisora

- **Hoy**: razón social solo por BD (Ransa SV, swap manual 15-09; Medios #13); `change_contract_commercial_client`
  rechaza Activo; PE reasignables una a una (`EditInvoiceEntityModal`); compañía emisora no se cambia.
- **DECIDIDO**: acción "Cambiar razón social" que actualiza `client_entity_id` y las PE pendientes (RUT, IVA, tipo de
  documento, serie) con evento (mapa M5, "Después"); tipo de documento sugerido desde la razón social (S1-7); RSM no
  depende de la entidad (Domi 15-09, Medios #13).
- **ABIERTO**: (a) cliente comercial de un contrato activo: sin decisión; recomendación: permitirlo con evento cuando
  la razón social nueva pertenece al cliente nuevo (misma regla de `change_contract_commercial_client`), sin tocar
  ítems ni RSM; (b) compañía emisora: intercompañía (M10, S5-12 "se detalla al final") → fuera de esta spec.

### 2.11 Cambio de condiciones (pago, envío ERP, emisión automática, T&C, tipo de documento, agrupación)

- **Hoy en v2**: `PATCH /contracts/:id/terms` (T&C; evento `TERMS_UPDATED`; PE existentes conservan su texto) y
  `PATCH /contracts/bulk-settings` (`auto_send_to_odoo`, `auto_invoice`; evento `SETTINGS_CHANGED`) ya existen
  (`contracts.controller.ts:141, 223`). En el front viejo: bulk de términos/receptor/FX por factura.
- **DECIDIDO**: términos de pago con default de la razón social, editables por contrato (S1-4); al cambiarlos, **solo
  las PE nuevas** recalculan vencimiento (S4-10); emisión automática exige envío al ERP; ambos apagados por defecto,
  avisos 3 y 1 día antes (S6-10); tipo de documento único del que deriva `export_type` (S4-7); agrupación juntas / por
  ítem guardada en el contrato y respetada por modificaciones (S1-10); día de ciclo explícito (S3-16).
- **ABIERTO**: si cambiar términos de pago o tipo de documento debe **ofrecer** aplicar a las PE existentes (S4-10 dice
  solo nuevas). Recomendación: mantener S4-10 y mostrar en el preview cuántas PE quedan con la condición anterior.
- **CONSTRUIDO (30-09)**: `invoice_terms_and_conditions` acepta `apply_to_pending: true` → el texto nuevo va también a las PE activas desde la fecha efectiva (mismas reglas y bloqueos que el masivo de facturas; preview/resultado con `pending_terms { updated, skipped[{ invoice_id, reason }] }` y avisos `pending_invoices_updated`/`pending_invoices_skipped`; sin cambio de texto → 400 `apply_to_pending`). La condición de pago sigue S4-10.

## 3. La decisión estructural A.4 (fases / versiones + preview / sucesor)

`mejoras-y-brechas.md` E.2 deja **ABIERTO** el patrón de modificaciones "con los tres modelos sobre la mesa". Frente a
las restricciones fijadas después (mismas tablas, RSM y ítem madre leen `contract_items.categoria` y relaciones,
front viejo conviviendo; mapa §1.1):

| Modelo | Qué aporta | Costo en Sapira hoy |
|---|---|---|
| Fases (Zenskar) | Trials, ramps, pausa y amendments con una sola primitiva; `is_enabled` por vigencias | Nueva primitiva sobre `contract_items`; el RSM/momentum y el ítem madre no la leen; sin preview nativo |
| Versiones + Changes API con preview (Alguna) | `add/update/remove` con `effective`, `preview` obligatorio, prorrateo elegible | Encaja con el modelo acumulativo: cada "change" produce ítems de ajuste; las versiones son la historia de eventos |
| Contrato sucesor (Relvo) | Revisión completa, locking optimista | Rompe `contract_id` estable para facturas, RSM, Odoo y reportes |

**Recomendación**: **Changes API tipada con preview** (Alguna) sobre el modelo acumulativo actual, que es exactamente
M1–M5 del mapa; la "versión" es el evento con `metadata.before/after`. Fases quedan como candidato solo para lo
planificado (S1-18 / #25 / pausa), a decidir en §2.6 y §2.8. Sucesor: descartar. Domi decide.

## 4. API propuesta

Dos endpoints, mismo servicio y mismo cálculo (`ContractChangesService`, junto a `contract-activation.service.ts`):

```
POST /contracts/:id/changes/preview   → no escribe
POST /contracts/:id/changes           → una transacción; header Idempotency-Key (A.12)
Body: {
  effective_date: 'YYYY-MM-DD',
  origin: { type: 'manual' } | { type: 'quote', quote_id },
  reason?: string, reason_id?: uuid (churn_reasons), notes?: string,
  change: { type: <uno de los de abajo>, ...payload }
}
```

| `change.type` | Payload | Categoría / efecto | Estados permitidos |
|---|---|---|---|
| `item_change` | `items[{ item_id, quantity, unit_price, price_entry_mode, discount_value, billing_frequency?, end_date?, net_line?: bool }]`, `first_period_invoice: 'cycle' \| 'immediate'` | Fórmula unificada → UPSELL o DOWNSELL (`RENEGOTIATION` como subtipo del evento); cambio de frecuencia/término → se rechaza y sugiere `renewal` hasta cerrar S3-15 | Activo, Por renovar |
| `item_add` | `items[{ product_id, quantity, unit_price, price_entry_mode, discount_value, item_type?, billing_frequency?, billing_method?, start_date?, end_date? (default fin del contrato), is_recurring, account? }]`, `first_period_invoice` | CROSS-SELL si el producto no existe; UPSELL si existe (con aviso de que probablemente es `item_change`) | Activo |
| `item_remove` | `items[{ item_id }]`, `timing: 'auto'` (early si efectiva ≤ fin, si no non-renewal) | DOWNSELL (quedan otros) o CHURN (último) por ítem; fantasma solo en early | Activo, Por renovar |
| `contract_cancel` | `—` (todos los recurrentes vigentes) | CHURN; `status = 'Cancelado'`; PE futuras canceladas | Activo, Por renovar, Vencido |
| `renewal` | `items[{ item_id, term_months?, end_date?, quantity?, unit_price?, discount_value?, billing_frequency?, billing_method? }]`, `catch_up: 'backdate' \| 'current_month'` (S5-4) | RENEWAL al valor anterior + UPSELL/DOWNSELL si cambia el precio (S3-15) | Activo, Por renovar, Vencido |
| `reactivate` | `items?[{ item_id }]` (sin lista = todo el contrato), `mode: 'auto'` (anular / revertir / REACTIVATION según §2.7) | REACTIVATION o reversión del evento | Cancelado, ítems con churn |
| `pause` / `resume` | **no se construye hasta cerrar §2.6**; forma tentativa `items[]`, `scope`, `until?`, `extend_term` | — | — |
| `billing_conditions` | `payment_terms?`, `invoice_terms_and_conditions?`, `document_type?`, `auto_send_to_odoo?`, `auto_invoice?`, `group_invoices_by_period?`, `invoice_currency?` + `fx_invoice_policy?` (solo PE futuras) | Evento `CONDITIONS_UPDATED` con before/after; sin ítems ni RSM | Borrador, Activo, Por renovar |
| `change_entity` | `client_entity_id`, `client_id?`, `apply_to_pending_invoices: true` | Evento `ENTITY_CHANGED`; PE pendientes reasignadas; sin RSM | Activo, Por renovar |
| `price_adjustment` | **no se construye hasta cerrar §2.8** | — | — |

Reglas transversales del servicio: (1) `SELECT … FOR UPDATE` del contrato; (2) fecha efectiva en período cerrado →
blocker `period_closed`; ítems con emitidas después de la fecha efectiva → warning con la NC en el preview
(`item_remove`) o blocker con sugerencia de fecha (`item_change`: "ya facturado en firme hasta X", como hoy
`apply_quote_downsell_to_contract.sql:147`); (3) los ítems se escriben con categoría, fin y precios explícitos; (4)
facturas por **F3** (estado objetivo → cambio mínimo, generador v2 para lo nuevo, fusión por período); (5)
`revenue_schedule_rebuild(id, mes efectivo)`; (6) encabezado del contrato (fin más próximo, `total_value`, `term`,
`status`); (7) evento + `quote_stage` si origen cotización; (8) respuesta = el preview más `applied: true` e ids creados.

**Preview** (misma forma en ambos endpoints):

```
{ contract: { before: { mrr, total_value, end_date, status }, after: {…} },
  items: { added: [...], adjusted: [{ item_id, categoria, quantity, unit_price, monthly_price, start_date, end_date }],
           ended: [{ item_id, churn_date }], groups_after: ItemGroup[] },          // ítem madre después
  invoices: { updated: [{ id, issue_date, lines_changed, subtotal_before, subtotal_after }],
              created: PreviewInvoice[], cancelled: [{ id }], credit_notes: [{ mirrors_invoice_id, total, currency, fx }] },
  rsm: { mrr_delta, momentum, first_month, months_rebuilt, closed_months_skipped },
  warnings: [{ code, message }], blockers: [{ code, message, next_step }] }
```

Blockers (invariantes): `period_closed`, `issued_after_effective_date` (solo `item_change`), `not_active`, `manual_lines_pending` (solo `contract_cancel`),
`item_already_churned`, `item_already_renewed`, `unified_invoice_in_range` (hasta A.5), `fixed_fx_without_rate`,
`quote_already_applied`, `new_business_quote_on_existing_contract` (S3-3), `uf_invoice_currency`. Warnings (blandas,
piden motivo y siguen): `possible_duplicate`, `unpaid_invoice_prorated`, `pending_invoices_keep_old_terms`,
`quantity_overrides_present`, `mrr_zero_items_skipped`, `term_exceeds_contract_capped`, `partial_billing_skipped`, `erp_draft_stale`,
`invoice_fx_kept`, `tax_rate_rederived`, `consumption_net_line`, `consumption_quantity_kept`, `consumption_line_kept` (§4.1).

### 4.1 Reglas agregadas por la auditoría del 01-10 (construido)

- **Facturadas por OC** (Por Emitir con líneas internas `visible_line_id`, §3.7b de facturas): son fijas en el calendario. `item_remove`,
  `contract_cancel`, `item_change` con línea neta, `change_entity`, `billing_conditions` (moneda/FX) y la fusión de líneas nuevas
  (`mergeTarget`) **no las tocan**: se omiten y se listan en el aviso `partial_billing_skipped` con `next_step` "Edítala desde su vista rápida".
- **Borrador en el ERP** (`odoo_invoice_id` / `sent_to_odoo_at`): no bloquea; el cambio se aplica y avisa `erp_draft_stale` ("La factura ya
  tiene un borrador en el ERP: elimínalo allí y restablece el borrador aquí para reenviarla") con las facturas tocadas.
- **Anuladas** (NC de anulación activa, `voidedSql`): no cuentan como emitidas: nunca reciben una segunda NC ni marcan "facturado en firme".
  La NC proporcional de una emitida acredita lo que **queda** de cada línea tras las NC de descuento vigentes (misma regla que
  `PREVIOUS_DISCOUNTS_SQL`, atribuidas por ítem y período contenido).
- **Consumo registrado** (`quantity_source = consumption|estimated` o fila en `consumption_entries`): ninguna modificación reinicia la
  cantidad. `item_change` con consumo en alguna Por Emitir es línea neta (`consumption_net_line`) y la línea se tarifa con la cantidad
  registrada y el precio nuevo vía motor (`pricing_breakdown` reescrito, `consumption_quantity_kept`); la baja no prorratea esa línea
  (`consumption_line_kept`); moneda/FX y documento solo revalorizan montos (la cantidad y el vínculo `consumption_entries.invoice_id` quedan).
- ~~`contract_cancel` con Por Emitir que tienen líneas editadas a mano desde la fecha efectiva → blocker `manual_lines_pending`~~ —
  reemplazado el 01-10 por la decisión por factura de §9.3.1 (las líneas a mano entran a la misma decisión).
- `billing_conditions` moneda/FX: las facturas con tasa fijada por factura (`fx_rate_source` `manual`/`net_exact`) conservan moneda y tasa
  (`invoice_fx_kept`); en spot (`fx` NULL) `fx_rate_source` y `fx_rate_date` quedan NULL.
- `change_entity`: el IVA de cada Por Emitir se re-deriva de su documento como en el editor (`taxRateForDocument`) y se guarda normalizado
  (`tax_rate_rederived` si cambia); el evento guarda `invoices_before[{ id, client_entity_id, client_tax_id }]`.
- `contract_cancel` (y todo cambio de `total_value`): `total_value_system_currency` se refresca aunque el contrato quede Cancelado.
- **Idempotencia**: el evento guarda `request_hash` (sha256 del cuerpo con claves ordenadas) y el `preview` aplicado. El reintento con la
  misma clave devuelve ese preview con `idempotent: true` y lo creado; la misma clave con otro cuerpo → 409 `idempotency_conflict`.
- Los avisos aceptan `next_step` opcional (`{ code, message, next_step? }`).

## 5. UI en el Contrato 360 (`front-sapira/app/(protected)/lab/contratos`)

- **Barra del 360** (`components/Contrato360View.tsx`, hoy solo Editar/Activar/Eliminar en borrador): en Activo / Por
  renovar aparecen **Modificar contrato** (primario) y las acciones de cabecera **Renovar**, **Pausar** (cuando exista),
  **Cancelar contrato**; en Cancelado, **Reactivar**. Todo va por `/api/contratos/[id]/cambios(/preview)` (BFF con
  schema Zod espejo del DTO).
- **Drawer "Modificar contrato"** (3 pasos): (1) tipo de cambio como chips: *Cambiar precio o cantidad* · *Agregar
  producto* · *Quitar producto* · *Condiciones de facturación* · *Cambiar razón social*; (2) formulario: para ítems, la
  fila del ítem madre con valores actuales → nuevos (cantidad, unitario mensual/anual, descuento; ayudas "final / solo
  diferencia" que solo calculan), fecha efectiva con default según tipo (próximo inicio de período en bajas; hoy o
  inicio del ítem cotizado en altas), opción "cobrar el tramo inicial ahora / en la próxima factura", motivo; (3)
  **preview**: antes/después del ítem madre y del MRR, tabla de facturas afectadas ("se suma a la factura del 01-10",
  "se crea una nueva", "NC espejo de F-123"), tramos del RSM, warnings con casilla de motivo, blockers con el paso
  siguiente; botón Confirmar deshabilitado con blockers. Reutiliza `ContratoItemsTab` (ítem madre), la vista previa de
  facturas del wizard (`components/nuevo`) y `EditarTerminosDialog`/`AjustesMasivosDialog` para condiciones.
- **Renovar**: drawer propio con los ítems vencidos o por vencer preseleccionados (S3-8), término y precio nuevo
  opcional por ítem, `catch_up` visible solo si es retroactivo (S5-4), mismo preview. **Cancelar**: diálogo con fecha
  efectiva, motivo de catálogo y preview de NC/PE. **Reactivar**: motivo + preview de ítems y PE restauradas.
- **Desde Cotizaciones**: "Asociar a contrato" abre el mismo drawer prellenado (`origin.quote_id`), solo contratos
  Activo (S3-1), bloqueo S3-3 con el validador de MRR activo.
- Historial (`ContratoHistorialTab`) muestra los eventos nuevos con ΔMRR y enlace a facturas; `ContratoAlertas` marca el
  desbalance de 4 patas si un cambio lo produce (mapa §1.7). Sin botones para tipos no construidos (regla del lab).

## 6. Orden de implementación recomendado

| Fase | Tipos | Por qué en este orden |
|---|---|---|
| **A · Todo DECIDIDO, sin ítems ni prorrateo** | `billing_conditions` (extiende `PATCH :id/terms` y `bulk-settings` a la forma común), `change_entity` (M5) | Solo encabezado + PE pendientes; valida el esqueleto preview/aplicar/evento y la BFF |
| **B · Contracción** | `item_remove`, `contract_cancel` (M2), `reactivate` en su rama "anular churn no vigente" | Reglas cerradas (U5, ROADMAP #10/#11, S2-8); reemplaza el flujo con más bugs en prod; sin generador nuevo (solo quitar líneas y NC espejo) |
| **C · Renovación manual** (M3) sin cambio de precio, luego con cambio de precio cuando Domi confirme S3-15 | `renewal` | Necesita F1 (ya existe: `billing-engine.ts`) y F3; cubre el fin del contrato "más próximo" y TV; prerrequisito de E2 (propuesta de auto-renovación) |
| **D · Altas y cambios de precio/cantidad** (M1) | `item_add` (cross-sell / upsell nuevo), `item_change` misma frecuencia | Reglas cerradas (fórmula unificada, S3-5/6/7/14/17, D-B/D-C) pero exige F3 completo (fusión por período, línea neta, herencia FX S6-2) y los casos de regresión (Bosch, STG-38, S04172, Pehuen, Cooprinsem) |
| **E · Decidido 01-10 → bloque 2 (§9.5)** | renegociación con cambio de frecuencia/término (S3-15), `pause`/`resume` (§2.6), `price_adjustment` y condiciones pactadas (§2.8, S1-18, M5 indefinido), reversión de churn con ventana (§2.7), clasificación a nivel cliente (§8), cross-sell multimoneda (M3), compañía emisora (M10) | Cada uno tiene puntos abiertos que cambian el modelo de datos |

Transversal antes de B: U8/U9 en el RSM (saneamiento capa 1 #3–4) y la decisión de la costura `sapira.writer` (§1).

## 7. Funciones y componentes legacy por tipo

| Tipo v2 | Reusar | Reemplaza (queda intacta hasta el switch, mapa §5) | Eliminar al switch |
|---|---|---|---|
| `item_change` | Fórmula del delta (manual §8, ya alineada en `apply_quote_downsell_to_contract` migr. `20260916120000`) como referencia de tests; validaciones explicativas `:135-196` como catálogo de blockers | `apply_quote_downsell_to_contract` (ramas cantidad/precio/renegociación), upsell inline de `UpsellingModal` y `AssignToContractModal`, `ContractionModal` modos parciales | `apply_renewal_price_split` solo si S3-15 unifica el almacenamiento; `contract_amendments` + `_items` (S3-10) |
| `item_add` | `billing-engine.ts` (generador v2), `contract-activation.service.ts` (patrón transacción + evento) | `create_contract_cross_sell` → `approve_contract_amendment` → `recalc_revenue_for_contract`; `CrossSellingModal`; `AssignToContractModal` rama upsell/cross-sell | Las tres funciones (saneamiento capa 2) |
| `item_remove` / `contract_cancel` | Lógica early vs non-renewal y cola BOP/CHURN del RSM (`apply_contract_contraction.sql:125-135`, `apply_pending_renewal_tail`), catálogo `churn_reasons`, `cancel_contract_invoices_on_contract_cancelled` (trigger, se conserva) | `apply_contract_contraction` (fantasma día 1, PE entera, NC en moneda equivocada) | `apply_contract_contraction` |
| `renewal` | Guardas de `create_contract_renewal.sql:89-99` (churneado, ya renovado, DOWNSELL/CHURN), split del RSM (`apply_renewal_price_split`) mientras dure S3-15 | `create_contract_renewal` v2 (`export_type=1`, `+30`, sin fin/TV), `EnhancedRenewalModal`, `MultiItemRenewalModal`, `RenewalModal` | `create_contract_renewal`, `process_auto_renewals`, `execute_auto_renewal_for_item`, cron `auto-renew-contract-items` (decisión #5) |
| `reactivate` | Categoría/momentum `REACTIVATION` (RSM ya la trata como NEW para prorrateo, `revenue_schedule_rebuild_contract_ccy.sql:163`) | SQL manual de soporte | — |
| `billing_conditions` | `PATCH :id/terms`, `PATCH bulk-settings`, `cleanPaymentTerms` (`contract-drafts.service.ts`) | `EditInvoiceTermsModal`, bulk de términos del front viejo (por factura siguen en Facturación) | — |
| `change_entity` | Regla de `change_contract_commercial_client.sql:53-70` (misma razón social por `tax_id` asignada al cliente) | `EditInvoiceEntityModal` (una PE a la vez), `change_contract_commercial_client` | `change_contract_commercial_client` |
| Fechas | Fin explícito (F4) | `set_contract_item_end_date`, `update_contract_term` (costura), `prevent_end_date_update_when_active` (se respeta con bypass + evento) | Costura, cuando nada escriba sin ella |
| Moneda | Nada en modificaciones (S6/F5) | `change_contract_currency` solo sirve en borrador → lo cubre el `PUT` del borrador | `change_contract_currency`, `InvoiceCurrencyBulkUpdate` (pasa a Facturación con FX por factura) |
| Corrección (fuera de spec) | — | `sync_invoices_for_contract_item`, `invoice_reschedule_items`, `check_contract_item_continuity` → F3/F4 | Las tres (mapa §5) |

Ya retiradas (saneamiento 24-09): `create_contract_upsell/downsell/churn`, `register_item_non_renewal`, `DownSellingModal`,
`AmendmentApprovalsModal`, mutaciones sin consumidor de `useContractAmendments`.

## 8. Decisiones que necesita Domi (resumen de lo ABIERTO)

> **✅ Resueltas el 01-10** (decisiones finales de Domi): la resolución de cada fila y de los ABIERTO de §2 está en **§9.1**; #9 queda pendiente (§9.6).

| # | Decisión | Opciones | Recomendación |
|---|---|---|---|
| 1 | Patrón A.4 | fases · changes tipados + preview · sucesor | Changes tipados sobre el modelo acumulativo (§3) |
| 2 | S3-15 almacenamiento de renovación con cambio de precio | camino corto + split RSM · dos ítems explícitos | Dos ítems explícitos; el camino corto queda como UX |
| 3 | Prorrateo elegible por cambio (A.4) | 4 comportamientos visibles · reglas fijas S3-5 + "cobrar ahora / próxima factura" | Reglas fijas + una opción (S3-17) |
| 4 | Acortar un ítem | `item_remove` non-renewal · tipo propio | `item_remove` ("Terminar antes") |
| 5 | Auto-renovación (pendiente #5) | arreglar el cron · apagarlo y reemplazar por propuesta E2 | Apagar al publicar E2 |
| 6 | Uplift / `renewal_policy` y condiciones pactadas (S1-18, #25) | fases · versiones programadas · cambios programados `price_step` | Cambios programados (§2.8), diseño con Pricing |
| 7 | Pausa (§2.6) | scope, granularidad ítem/contrato, `extend_term`, MRR/CMRR | Por ítem, `scope service`, tabla de pausas |
| 8 | Reversión de churn con ventana (§2.7) | solo REACTIVATION · tres ramas por cierre de período | Tres ramas |
| 9 | Clasificación a nivel cliente (NEW vs REACTIVATION vs CROSS-SELL entre contratos) | por contrato (hoy) · por cliente con override y motivo | Por cliente derivada + override, después de D (afecta waterfall) |
| 10 | Cambio de cliente comercial en activo | no · sí con evento y misma razón social | Sí con evento |
| 11 | Condiciones y PE existentes (S4-10) | solo nuevas · ofrecer aplicar | Solo nuevas + conteo en el preview |
| 12 | Aprobación de modificaciones (S3-10 vs pendiente #7) | confirmar eliminación | Confirmar S3-10 |
| 13 | Costura `sapira.writer` (mapa §7.1) | OK · patrones actuales | Pedir OK a Leon antes de la fase B |

## 9. Supuestos

- **Supuesto 1**: los estados en que se permite cada tipo (§4) siguen la lógica del estado derivado
  (`contract-status.ts`); ningún doc los lista por operación salvo S3-1 (solo Activo para asociar cotización).
- **Supuesto 2**: un `item_add` de producto existente se acepta como UPSELL de ítem nuevo (caso "otra cuenta", ítem
  madre separa por cuenta) con aviso; el manual solo prohíbe upsell sobre upsell en `UpsellingModal`.
- **Supuesto 3**: la forma del preview y los códigos de blockers/warnings son propuesta de esta spec, alineada con
  `ActivationCheck` (`contract-activation.service.ts`); no están decididos.
- **Supuesto 4**: `contract_item_pauses` y `contract_scheduled_changes` son nombres tentativos; solo existen si Domi
  cierra §2.6 y §2.8 con esas opciones. Ningún esquema nuevo se crea para las fases A–D.
- **Supuesto 5**: el `Idempotency-Key` y `origin` se guardan en `contract_lifecycle_events.metadata` hasta que exista
  la tabla de eventos unificada (`spec-tablas-por-modulo.md`, módulo 10).

## 9. Bloque Modificaciones · decisiones 01-10 y alcance final

> 01-10-2026 · decisiones **finales** de Domi. Cierran los ABIERTO de §2 y las 13 preguntas de §8 (ver 9.1). Construido hasta hoy (28-09 → 01-10):
> `billing_conditions`, `change_entity`, `item_remove`, `contract_cancel`, `renewal` (mismo precio), `item_add`, `item_change` (misma
> frecuencia), con las reglas de §4.1 (`contract-changes.ts` `planChange`, `contract-changes.service.ts`). Multimoneda tiene spec propia:
> [`spec-multimoneda-contrato.md`](./spec-multimoneda-contrato.md); este bloque usa sus tipos (`multicurrency`, `item_add` con moneda).

### 9.1 Preguntas de §8 y ABIERTO de §2: resueltas

| §8 # / §2 | Decisión 01-10 |
|---|---|
| 1 · Patrón A.4 | Changes tipados con preview sobre el modelo acumulativo (construido) |
| 2 · S3-15 (§2.1a, §2.5a) | **Dos ítems explícitos**: RENEWAL al valor anterior + ajuste UPSELL/DOWNSELL, con el pacto aplicado registrado (9.3.4). Frecuencia o término = ítem nuevo + pacto (9.3.7) |
| 3 · Prorrateo (§2.1b) | Reglas fijas + `first_period_invoice` (construido); **ítem con ciclo propio = sin prorrateo** (9.3.9) |
| 4 · Acortar (§2.4) | "Terminar antes" = `item_remove` non-renewal (construido); cambiar el plazo hacia adelante = 9.3.7 |
| 5 · Auto-renovación (§2.5b) | Cron legacy **ya desprogramado**; E2 = propuesta con **confirmación del holding** (9.3.5) |
| 6 · Ajustes pactados (§2.8, §2.5c) | Tabla `contract_scheduled_changes` (9.3.6) incl. IPC/UF |
| 7 · Pausa (§2.6) | Por ítem, `scope service`, tabla `contract_item_pauses` (9.3.3) |
| 8 · Reversión de churn (§2.7) | Tres ramas por cierre de período (9.3.2) |
| 9 · Clasificación a nivel cliente | **Decidido 01-10** (construido): los borradores nunca cuentan como contrato anterior (solo activados); si todos los contratos activados del cliente están cancelados con el churn vigente, los ítems de un contrato nuevo (y los de `reactivate` rama c) son **REACTIVATION**; con al menos uno vigente, UPSELL/CROSS-SELL. Sin override manual (`itemCategoriaSql` / `classifyClientItem`) |
| 10 · Cliente comercial (§2.10a) | **Fuera**: cambiarlo sería un error de carga, no una modificación |
| 11 · S4-10 | Solo nuevas + conteo (construido; T&C con `apply_to_pending`) |
| 12 · Aprobación | **Fuera** (S3-10) |
| 13 · Costura `sapira.writer` | Construida (todas las escrituras de v2) |
| §2.2 / §2.9 · otra moneda | Multimoneda (spec propia); cotización en otra moneda → `item_add` en su moneda |
| §2.10b · compañía emisora | **Fuera** (intercompañía, diferido) |

### 9.2 UI: un solo "Modificar contrato" guiado por intención

Reemplaza los chips técnicos de §5 por un paso 1 **"¿Qué pasó con el contrato?"** (mismo patrón que Reorganizar en Facturas). Cada intención hace
1–2 preguntas en lenguaje simple y arma el pedido a la API; el paso 3 es siempre el mismo preview (§4). La usuaria nunca ve los tipos.

| Intención (texto en la UI) | Pregunta guía | Tipo API |
|---|---|---|
| Cambió el precio o la cantidad de un producto | ¿Qué producto? ¿Valores nuevos? | `item_change` |
| Cambiar el modelo de precio (Domi 05-10) | ¿Qué producto? ¿Modelo nuevo (tramos, volumen, paquete, asiento o por consumo)? | `price_model_change` (9.3.11) |
| Cambió cada cuánto se factura o el plazo | ¿Frecuencia / plazo nuevo? ¿Desde cuándo? | `item_change` con `billing_frequency`/`term_months` (9.3.7) |
| Agregó un producto (incl. otra moneda o desde una cotización) | ¿Qué producto y para qué cuenta? (¿mismo ciclo del contrato o su propio día?) | `item_add` (+ `enable_multicurrency`) |
| Corregir un dato mal cargado (F4, reemplaza "Cambia la cuenta de un producto") | ¿Qué producto? ¿Qué dato estaba mal? | `item_update` (ver 9.2.1) |
| Quitó un producto | ¿Ahora o al terminar su plazo? | `item_remove` |
| Renueva | ¿Mismo precio o nuevo? ¿Extender el tipo de cambio? | `renewal` |
| Acordamos un cambio futuro (reajuste, IPC/UF, nuevo precio en fecha) | ¿Cuándo y qué? | `scheduled-changes` (9.3.6) |
| Pausa o retoma el servicio | ¿Desde/hasta? ¿Extiende el plazo? | `pause` / `resume` |
| Termina el contrato | ¿Fecha? ¿Qué hacemos con cada factura pendiente? | `contract_cancel` (9.3.1) |
| Vuelve a ser cliente | ¿Todo o algunos productos? | `reactivate` |
| Cambian las condiciones de facturación | — | `billing_conditions` |
| Cambia la razón social que recibe la factura | ¿Existe o la creamos? | `change_entity` (9.3.10) |
| Factura productos en varias monedas | — | `multicurrency` |

#### 9.2.1 Corregir un dato mal cargado (`item_update`, F4 · decisión de Domi 01-10)

El "editar ítem" de la app vieja, como **corrección** (no modificación). `items[{ item_id, account?, product_name? (glosa), item_type?,
quantity?, unit_price?, price_entry_mode?, discount_value? (%) }]`; el front agrupa por producto + cuenta (la cuenta, la glosa y el tipo van a
todos los ítems del grupo; los valores, al ítem madre vigente). Cualquier estado salvo En revisión y Cancelado. Construido en
`contract-changes.ts` `planItemUpdate` / `correctItemInvoices` / `correctedLine`.

1. **Guard**: si cambia el valor (cantidad, precio, modo del precio o descuento), el mes de la fecha efectiva debe estar abierto
   (`period_closed`, mismo chequeo que el resto). Cuenta, glosa y tipo no lo piden. El valor se corrige en **un ítem por cambio**, sin modelo
   de precio (los tramos se editan en el precio del ítem) ni espejos de baja (400 en el campo).
2. **Corrección en su lugar**: el ítem se reescribe (sin ítem espejo, sin UPSELL/DOWNSELL, misma `categoria` y `booking_date`);
   `price`/`final_price` con `itemPricing` y `monthly_price`/`billing_period_price`/anual con `pricingFields`; `total_value` del contrato
   recalculado; devengo reconstruido **completo** (desde el primer mes del contrato; los cerrados se saltan).
3. **Por Emitir** del ítem reescritas con los valores corregidos (unitario del período escalado: conserva el prorrateo), respetando lo hecho a
   mano: línea editada (`quantity_source = manual`, no se toca), consumo registrado (conserva la cantidad; con monto informado no se toca),
   glosa escrita a mano (`description_locked`), descuento puntual (se reaplica, % o monto, sobre el neto nuevo) y tasa fijada por factura (se
   conserva). Aviso `correction_overrides_preserved` con la lista. Las glosas generadas se regeneran después (`pending_descriptions_updated`).
4. **Emitidas intactas**. Si alguna emitida (no NC/ND, no anulada, no unificada) tiene el ítem, la diferencia por período entre lo emitido y lo
   que debió emitirse con los valores corregidos se reparte en partes iguales (redondeo telescópico) entre las Por Emitir del ítem, en el
   unitario de su línea, con el motivo del desvío en `invoice_adjustments` (`type = correction`, `amount_diff` = la parte). Preview
   `issued_difference { item_id, currency, amount, issued_invoices[{ invoice_id, invoice_number, issued, expected, difference }],
   distributed_over[{ invoice_id, invoice_number, issue_date, amount }] }` y aviso `issued_difference_distributed`: "Ya existe la factura
   F-0123 emitida por este ítem: la diferencia de USD 120,00 se distribuye entre las 3 facturas por emitir. Si lo que quieres es cambiar el
   acuerdo desde una fecha, usa Cambió el precio o la cantidad". Sin Por Emitir donde repartir → bloqueo `no_pending_invoices_for_correction`
   (next_step: usa "Cambió el precio o la cantidad"); una parte que dejaría una factura en negativo → `correction_difference_exceeds_pending`.
5. **Evento** `ITEM_CORRECTED` (subtipo `value` o `data`, `amount_delta` 0) con `metadata.items[{ item_id, product_name, changes[{ field,
   before, after }] }]`, `issued_difference` y `preserved`. Reemplaza a `ITEM_UPDATED` (el 360 sigue leyendo los eventos viejos).

Desde Cotizaciones, "Asociar a contrato" entra directo a la intención "Agregó un producto" o "Cambió el precio…" según el tipo de la cotización.
Barra del 360: **Modificar contrato** (primario) + atajos **Renovar**, **Pausar/Reanudar**, **Terminar** y en Cancelado **Reactivar** (abren el mismo
drawer en su intención). Propuestas de renovación y pactos por vencer aparecen como tarjetas en el Resumen con sus botones.

### 9.3 Diseño por operación

**9.3.1 Terminar con facturas pendientes (`contract_cancel`, reemplaza `manual_lines_pending`)**. El preview devuelve `invoice_decisions_required[]`
`{ invoice_id, invoice_number, issue_date, status_group: 'pending' | 'issued', amount_after_effective, options[], default, reason_hint }` para toda
factura con período ≥ fecha efectiva: **Por Emitir** → `emit` (se mantiene completa y se emite: lo de después de la fecha queda facturado, aviso
`billed_beyond_effective_date`) o `cancel` (regla actual: quitar líneas desde la fecha, prorratear la que la contiene, sin líneas → Cancelada; una
facturada por OC se cancela entera); **Emitida** → `keep` (sin NC, mismo aviso) o `void` (NC proporcional espejo, regla actual). Defaults:
`cancel` / `void`. Body: `change.invoice_decisions[{ invoice_id, action }]`; si falta alguna → blocker `invoice_decision_required`. Las líneas manuales
ya no bloquean: entran a la misma decisión. El preview sugiere `effective_date_suggestions[]` (fin del último período emitido = sin NC; fin del período
en curso) para **ajustar la fecha**. Evento `CHURN` subtipo `contract_cancel` con `metadata.invoice_decisions`.

**9.3.2 Reactivar (`reactivate`)** `{ items?[{ item_id }], effective_date }` (sin lista = todo lo cancelado). Rama por fecha del churn y cierre
(S5-7): (a) churn **aún no vigente** (`churn_date > hoy`) → **anular**: se quita el espejo CHURN/DOWNSELL (sin facturas propias), se limpian
`churn_date`/`churn_reason_id`, se cancelan las NC Por Emitir del churn y el generador rehace las PE canceladas; (b) **vigente, mes abierto** →
**revertir**: igual que (a) + PE nuevas desde la fecha del churn para el tramo (las NC ya emitidas quedan; aviso `credit_notes_issued_kept`); (c) **mes
cerrado** → ítems **REACTIVATION** nuevos desde `effective_date` al valor anterior (editable), PE del generador. `contracts.status = 'Activo'` explícito.
El evento original recibe `metadata.reversed_by`; evento nuevo `CHURN_REVERSED` (a/b) o `REACTIVATION` (c). Bloqueos: `not_cancelled`,
`period_closed` (rama a/b sobre mes cerrado → cae en c).

**9.3.3 Pausar / reanudar (`pause`, `resume`)**: por ítem (o todos los recurrentes vivos), `scope service` único. `pause { items[], pause_start,
pause_end?, extend_term: boolean }` → fila en `contract_item_pauses`; PE con período dentro de la pausa: líneas fuera (prorrateo por días en los
bordes, factura vacía → Cancelada); emitidas que cubren la pausa → misma decisión `keep | void` de 9.3.1; RSM con devengo y MRR 0 en el tramo
(momentum `PAUSE`, CMRR se mantiene si hay `pause_end`). `resume { items[], resume_date }` cierra la pausa (`pause_end = resume_date − 1`), genera PE
desde la reanudación (F1/F3) y, con `extend_term`, corre el fin del ítem en los días pausados (y el del contrato si es el más próximo; evento con
bypass). Estado derivado `Pausado` cuando todos los recurrentes vivos están pausados (`contract-status.ts`). Eventos `PAUSE`/`RESUME`. Bloqueos:
`item_already_paused`, `pause_overlaps`, `period_closed`. Masivo: segunda etapa (9.5).

**9.3.4 Renovación con precio nuevo + extensión de FX (`renewal`)**: `items[].quantity|unit_price|discount_value` **se aceptan** (quita el 400 de
`planRenewal`:1586). Plan: RENEWAL al valor vigente del ítem madre + ítem de ajuste (UPSELL/DOWNSELL, `related_item_id` = RENEWAL, mismo inicio y fin,
fórmula unificada de `item_change`) + fila `contract_scheduled_changes` `trigger on_renewal`, `kind new_unit_price|quantity`, `status applied`,
`applied_event_id`; pactos `on_renewal` `scheduled` del ítem se aplican en el mismo acto (omitibles con motivo → `skipped`). RSM mes 1 separa base
y delta (sin `renewal_base_unit_price`). **FX**: `change.fx_invoice_rates?[]` y `fx_item_rates?[]` (multimoneda); si el contrato tiene tasa **de todo el
contrato** (`isWholeContractRate`) por par/propósito y no se manda otra, la fila se **extiende** al nuevo fin (op `extend_fx_rates`, aviso
`fx_rate_extended`); con tasas por período y política fija, el nuevo término sin cobertura → `fixed_fx_without_rate` con el par. Retira el pendiente
de `isWholeContractRate` ("al extender el plazo corresponde extender esa tasa").

**9.3.5 Auto-renovación v2 con confirmación del holding (R2)**. Job diario `contracts-auto-renewal` (06:00, `@Cron`, por holding): ítems recurrentes
`auto_renew`, sin renovar ni churn, contrato `active | pending_renewal`, `end_date ≤ hoy + holding_settings.auto_renewal_notice_days` → evento
`RENEWAL_PROPOSED` (`created_by = system`, `metadata { items, preview, pacts }`, idempotente por ítem y fin) + notificación. **Nunca renueva sola**.
`GET /contracts/renewal-proposals` (KPI "Renuevan en 30 días"); confirmar = `POST /contracts/:id/changes` con `change.type renewal` y `origin {
type: 'renewal_proposal', event_id }` (precio y pactos editables en el preview); omitir = `POST /contracts/:id/renewal-proposals/:eventId/dismiss
{ reason }` (`RENEWAL_PROPOSAL_DISMISSED`); apagar = `billing_conditions.auto_renew: false` (ítems recurrentes vivos, `CONDITIONS_UPDATED`).
Al vencer sin decisión: Por renovar con alertas crecientes (S2-1/S5-4). Funciones legacy (`process_auto_renewals`, `execute_auto_renewal_for_item`,
`get_items_pending_auto_renewal`, `create_contract_renewal`) se retiran al switch.

**9.3.6 Ajustes pactados (R1/R3/R4)**: tabla `contract_scheduled_changes` (9.4). API: `GET/POST /contracts/:id/scheduled-changes`, `PATCH
…/:changeId` (solo `scheduled`), `POST …/:changeId/skip { reason }`, `POST …/:changeId/cancel { reason }`, `POST …/:changeId/apply/preview` y `POST
…/:changeId/apply` (materializa con el motor de `item_change`/`renewal`). Alta: `CreateContractDto.scheduled_changes[]` (mismo DTO). Job diario
`contracts-scheduled-changes` (05:30): pactos `on_date`/`every_n_months` con fecha ≤ hoy + aviso → evento `SCHEDULED_CHANGE_DUE` + notificación
(**confirmación**, mismo criterio que 9.3.5); `every_n_months` crea la hija `applied` y avanza `next_effective_date`. Semántica de `kind` = §3.2 de
[`spec-renovacion-y-ajustes-pactados.md`](./spec-renovacion-y-ajustes-pactados.md); `index` lee `indicadores_economicos` (IPC/UF/USD), sin dato →
blocker `index_value_missing`. Reajuste sin prorrateo (rige desde el próximo inicio de período). Ítem que termina → sus pactos `cancelled`
(`status_reason = item_ended`). Eventos `SCHEDULED_CHANGE_CREATED|SKIPPED|CANCELLED`; el aplicado es el evento normal (UPSELL/DOWNSELL subtipo
`price_step` o `index`).

**9.3.7 Cambio de frecuencia o término (`item_change`)**: `items[].billing_frequency?` y `term_months?` dejan de dar 400. Plan (S3-15): el ítem
madre se corta al **próximo inicio de período** (`renewed_by_item_id`), nace un ítem **RENEWAL** (`renews_item_id`) con la frecuencia/plazo nuevos al
mismo mensual (+ ajuste si cambia el precio) y una fila `contract_scheduled_changes` `applied` `kind billing_frequency` (valor = meses) o `term`.
PE del original desde el corte: se quitan sus líneas; el generador crea las del ítem nuevo (fusión F3). Emitidas después del corte →
`issued_after_effective_date` con fecha sugerida. Evento `UPSELL|DOWNSELL|RENEWAL` subtipo `RENEGOTIATION` con `metadata.reterm { frequency_before,
frequency_after, term_before, term_after }`.

**9.3.8 Activar multimoneda y producto de cotización en otra moneda**: ver [`spec-multimoneda-contrato.md`](./spec-multimoneda-contrato.md) §6
(`multicurrency { enabled }`, `item_add.items[].currency`, `enable_multicurrency`, blockers `multicurrency_not_enabled`,
`foreign_currency_items_present`, `item_fx_rate_missing`).

**9.3.9 Día de ciclo por ítem**: `contract_items.billing_anchor_day` (nullable, 1–31). `NULL` = ciclo del contrato (`contracts.billing_anchor_day`,
como hoy); con valor = **ciclo propio**: sus períodos parten ese día, **sin tramo prorrateado** (el ítem empieza un período completo en su inicio).
Se elige al crear el ítem (alta: `items[].billing_cycle: 'contract' | 'own'`; `item_add` igual; `own` ⇒ día = día de `start_date`). Motor:
`BillingEngineItem.billing_anchor_day?` → cuotas por ítem. Agrupación: juntas por **fecha de emisión exacta**, así un ítem del día 15 emite en su
propia factura del 15 (o junto a otros ítems del mismo día). `mergeTarget`: una línea de ciclo propio solo se funde con una PE de **la misma
fecha de emisión** (no basta el mes); una línea de ciclo de contrato no se funde con una PE de ciclo propio. RSM (asset): el día de ciclo del ítem
es `COALESCE(item.billing_anchor_day, contract.billing_anchor_day, MIN(start_date))` y un ítem de ciclo propio no prorratea su primer mes (como NEW).
Cambiar el ciclo de un ítem vivo: no se construye (9.6).

**9.3.10 Cambiar razón social (con alta de una nueva)**: `change_entity` acepta `client_entity_id` **o** `new_entity { legal_name, tax_id, country,
address?, email?, payment_terms? }`. Con `new_entity`, en la misma transacción: busca por `tax_id` normalizado en el holding → existe y está ligada
al cliente → la usa (aviso `entity_already_exists`); existe ligada a otro cliente → blocker `entity_belongs_to_other_client` (cambiar de cliente está
fuera); no existe → `INSERT client_entities` + `client_entity_clients` (`is_primary = false`). El resto es el `change_entity` construido. Evento
`ENTITY_CHANGED` con `metadata.entity_created`.

**9.3.11 Cambiar el modelo de precio (`price_model_change`, Domi 05-10; construido, sin commit)**. Objetivo: que el holding pase un ítem de precio ×
cantidad a tramos (u otro modelo) sin soporte. Body `{ items: [{ item_id, price: PriceSpecDto, quantity?, discount_value? }] }` (un ítem; `price`
= el mismo del asistente: `standard | graduated | volume | package | seat`, cantidad fija o `metered` con métrica activa, tramos, gratis, mínimo,
tope, `invoice_line_mode`; estándar fijo viaja con `unit_amount`). Estados: Activo y Por renovar. Mismo patrón que 9.3.7:
- **Corte**: el ítem (y sus ajustes UPSELL/DOWNSELL vivos) termina el día antes del **próximo inicio de período desde la fecha efectiva** (aviso
  `price_model_from_next_period` si no coincide) y nace un **RENEWAL** (`renews_item_id`) con un **precio propio del contrato nuevo**:
  `prices.version` = la del anterior + 1 y `supersedes_price_id` = el anterior (el ítem original conserva su precio: lo ya facturado y los
  períodos antes del corte no cambian).
- **Por Emitir** desde el corte: se quitan las líneas del ítem y sus ajustes y el generador crea las del modelo nuevo (fusión F3; una fila por
  tramo en `per_tier`). Los **consumos** registrados desde el corte pasan al RENEWAL (`move_consumption`) y esos períodos se tarifan con la
  cantidad registrada. Con modelo nuevo de cantidad fija y correcciones de cantidad desde el corte: bloqueo `quantity_corrections_after_cut`.
  Emitidas después del corte → `issued_after_effective_date`. Líneas editadas a mano se reemplazan (aviso `manual_edit_replaced`).
- **MRR** = el nuevo monto base del plan: el modelo nuevo tarifado a la **cantidad base** (`quantity` del pedido o la del ítem) y mensualizado
  (`pricedMonthlyEquivalent`, con el descuento %). Con tramos es el precio por tramos de esa cantidad (no el consumo de un mes): p. ej. 50
  vehículos con tramos 1–40 a 35 y 41+ a 30 → 1.700. El RENEWAL guarda `renewal_base_unit_price` (mensual anterior ÷ cantidad del original) y el
  RSM separa el delta como UPSELL/DOWNSELL (`apply_renewal_price_split`). Evento `UPSELL | DOWNSELL | RENEWAL` subtipo `price_model` con
  `metadata.price_model { cut, model_before/after, quantity_type_before/after, base_quantity, monthly_before/after, supersedes_price_id,
  consumption_periods }`. Descuento en monto fijo del ítem: no aplica a un modelo de precio (aviso `fixed_discount_dropped`).
- **Devengo**: sigue lo facturado en los períodos con consumo (regla D2-c del rebuild, `spec-pricing-v2.md` §4.5); sin consumo, el plan.
- Corrección de paso (05-10): `recompute_header` ya no cancela una Por Emitir que se quedó sin sus líneas viejas si recibe líneas del generador en el
  mismo cambio (antes, el cambio de frecuencia 9.3.7 que reemplazaba todas las filas del período la dejaba `Cancelada`).
- Front: intención **"Cambiar el modelo de precio"** en Modificar contrato (`ModeloPrecioForm`: producto, cantidad base, descuento y el editor
  de precio del asistente con su vista previa en vivo `POST /contracts/price-preview`; luego vista previa y aplicar como cualquier cambio).
- Verificación en la copia local (`rebuild-devengo-comparacion.md` §11.4): ítem por consumo de SimpliRoute → tramos → consumo → Por Emitir por
  tramo y devengo = facturado.

### 9.4 Migración del bloque (una, `1790710000000-ContractModificationsBlock2`; entity a mano, commit antes de aplicar, `schema:status` + `schema:log` en QA)

| # | Cambio | Efecto exacto |
|---|---|---|
| 1 | Tabla **`contract_scheduled_changes`** | `id uuid pk`, `holding_id uuid not null` (FK holding, RLS 4 policies como `contract_fx_period_rates`), `contract_id uuid not null` (FK cascade), `contract_item_id uuid null` (FK; null = contrato), `group_key uuid null`, `parent_id uuid null` (FK propia, hijas de `every_n_months`), `trigger text` CHECK `on_renewal\|on_date\|every_n_months`, `effective_date date`, `anchor_date date`, `interval_months smallint` (>0), `next_effective_date date`, `kind text` CHECK `percent_uplift\|index\|new_unit_price\|quantity\|term\|billing_frequency`, `value numeric(18,6) not null` (%, precio en moneda del ítem, cantidad o meses), `index_code text`, `index_base_date date`, `index_base_value numeric(18,6)`, `index_lag_months smallint default 1`, `rounding text default 'unit_2'` CHECK `none\|unit_2\|unit_0\|monthly_0`, `status text default 'scheduled'` CHECK `scheduled\|applied\|skipped\|cancelled`, `status_reason text`, `status_changed_by uuid`, `applied_event_id uuid` (FK `contract_lifecycle_events`), `applied_at timestamptz`, `applied_value numeric(18,6)`, `origin jsonb not null default '{"type":"manual"}'`, `notes text`, `created_by uuid`, `created_at`, `updated_at` (trigger `update_updated_at_column`). CHECKs: `on_date ⇒ effective_date`, `every_n_months ⇒ anchor_date, interval_months`, `index ⇒ index_code, index_base_value`. Índices `(contract_id, status)`, `(holding_id, status, next_effective_date)`, `(contract_item_id)` |
| 2 | Tabla **`contract_item_pauses`** | `id`, `holding_id`, `contract_id`, `contract_item_id not null`, `pause_start date not null`, `pause_end date null` (null = hasta reanudar; CHECK `pause_end ≥ pause_start`), `extend_term boolean not null default false`, `status text` CHECK `scheduled\|active\|ended\|cancelled`, `reason text`, `pause_event_id uuid`, `resume_event_id uuid`, `created_by`, `created_at`, `updated_at`; RLS por holding; índice `(contract_item_id, status)` |
| 3 | `contract_items.billing_anchor_day smallint null` + CHECK `1..31` | Ciclo propio del ítem (9.3.9); comentario de columna |
| 4 | `holding_settings.auto_renewal_notice_days smallint not null default 30` + CHECK `1..180` | Aviso previo de la propuesta (S2-3) |
| 5 | `revenue_schedule_monthly_momentum_check` + `PAUSE`, `RESUME` | Filas del tramo pausado y de la reanudación en el waterfall |
| 6 | Asset `revenue_schedule_rebuild_contract_ccy` | Lee `contract_item_pauses` (devengo/MRR 0 en el tramo, momentum PAUSE/RESUME), día de ciclo por ítem (9.3.9); se aplica junto al asset de multimoneda |

Sin cambios en `contracts` ni en `invoices`. Ítems de ajuste, RENEWAL, REACTIVATION y eventos usan columnas existentes.

### 9.5 Orden de construcción

1. **B2-1 · Cancelación con decisiones** (9.3.1) y **razón social nueva** (9.3.10): sin esquema; quitan el bloqueo `manual_lines_pending`.
2. **B2-2 · Esquema** (9.4 #1–#5) + **renovación con precio y FX** (9.3.4) + **frecuencia/término** (9.3.7) + pactos R1 (`on_renewal`, CRUD).
3. **B2-3 · Reactivar** (9.3.2) y **ciclo por ítem** (9.3.9, motor + asset RSM).
4. **B2-4 · Auto-renovación con confirmación** (9.3.5) y **pactos en fecha / IPC-UF** (R3, job diario).
5. **B2-5 · Pausa/reanudación** (9.3.3) + asset RSM, luego pausa masiva.
6. **B2-6 · UI por intención** (9.2) en paralelo desde B2-1; documentación funcional y tests por etapa (regla dura).
Multimoneda (MM1–MM6) va antes de B2-2 o en paralelo: `item_add` en otra moneda y la extensión de tasas por par dependen de MM1–MM3.

### 9.6 Construido B2-1 a B2-3 (01-10, código listo; migración sin aplicar) y desvíos

- **B2-1**: `contract_cancel` con `invoice_decisions_required[]` / `change.invoice_decisions[]` / `effective_date_suggestions[]` (9.3.1) y
  `change_entity` con `new_entity` (9.3.10). **B2-2**: migración `1790710000000-ContractModificationsBlock2` (9.4 #1–#5) + entities + 8 policies
  y 2 triggers como assets; `renewal` con precio, pactos `on_renewal` y extensión de FX (9.3.4); `item_change` con frecuencia/plazo (9.3.7);
  pactos R1 (CRUD, `apply/preview`, `apply`, `CreateContractDto.scheduled_changes[]`). **B2-3**: `reactivate` (9.3.2) y ciclo propio por ítem
  (9.3.9, motor + asset RSM). Además: `GET /quotes/:id/contract-targets` y `quote_item_id` en `item_add` / `item_change`; clasificación a
  nivel cliente (9.1 #9). Detalle de contrato API en [`mapa-v2-contratos.md`](./mapa-v2-contratos.md) §2d.
- Desvíos y supuestos (a confirmar con Domi):
  1. `PATCH …/scheduled-changes/:changeId` deja un evento **`SCHEDULED_CHANGE_UPDATED`** (antes/después) además de los tres de 9.3.6.
  2. Renovación con precio y cambio de frecuencia/plazo facturan **una línea neta** por período ligada al RENEWAL (el ajuste no tiene
     líneas propias), como la línea neta de S3-14.
  3. Cambio de frecuencia/plazo: el ítem cortado queda con `end_date` = corte − 1 y `term_months`/`final_price` = mensual × meses que le
     quedan (el mensual no cambia), además de `renewed_by_item_id`. Solo plazo sin cambio de precio → evento `RENEWAL` subtipo `RENEGOTIATION`.
  4. Pacto `index`: `value` = puntos sobre la variación del índice (IPC + `value`); 0 = solo el índice. Desfase con `index_lag_months`.
  5. Pacto de alcance contrato (`contract_item_id` NULL) `on_renewal` se aplica a todos los ítems renovados en el acto (una sola fila).
  6. Extensión de FX: también la tasa `company` "de todo el contrato", además de `invoice` e `item`.
  7. `contract_cancel` con `void` sobre una emitida de varios ítems emite una NC espejo **por ítem** (regla de la baja sin cambios).
  8. `reactivate` (a/b) rehace las PE solo por los días que ninguna factura vigente cubre (una NC emitida "descubre" sus días); las líneas
     sin ítem que la cancelación quitó no se rehacen. Bloqueo nuevo `scheduled_change_not_scheduled` (pacto ya aplicado/omitido).
  9. `prices.quote_id` no se puede llenar en precios del contrato (CHECK `prices_contract_owner_check`): el vínculo con la cotización queda
     en `contract_items.quote_item_id` y en el evento (`metadata.origin`, `metadata.quote_items`).
  10. `contract_scheduled_changes.contract_item_id` borra en cascada (los ítems de un borrador que se quitan se llevan sus pactos);
      `status_changed_by` y `created_by` son `users.id` sin FK.
  11. Hasta aplicar la migración, los specs de deriva entity↔prod (`contratos`, `base-tenancy`) fallan por `billing_anchor_day` y
      `auto_renewal_notice_days` (se refresca el snapshot después de aplicar, como en las migraciones anteriores).

### 9.6b Construido B2-4 y B2-5 (01-10, código listo; misma migración sin aplicar, sin cambios de esquema nuevos) y desvíos

- **B2-4** (9.3.5 / 9.3.6): `ContractsScheduler` (`contracts.scheduler.ts`, `America/Santiago`, `CONTRACT_JOBS_ENABLED=false` apaga) con
  `contracts-scheduled-changes` (05:30) y `contracts-auto-renewal` (06:00) → `ContractRenewalsService`; reglas puras en `contract-renewals.ts`.
  `GET /contracts/renewal-proposals` (`{ data, counts { open, renew_in_30_days, overdue } }`), `POST /contracts/:id/renewal-proposals/:eventId/dismiss
  { reason }`, confirmar = `renewal` con `origin { type: 'renewal_proposal', event_id }` (blocker `renewal_proposal_not_open`; la propuesta
  queda `confirmed` con `confirmed_by_event_id`), `billing_conditions.auto_renew`. Detalle: `renewal_proposals[]` (abiertas). El aplicado de
  `every_n_months` ya creaba la hija `applied` y avanzaba `next_effective_date` (`recordPactApplication`); `index` lee
  `indicadores_economicos (codigo, fecha, valor)` con `index_lag_months`.
- **B2-5** (9.3.3 / 9.4 #6): `pause` / `resume` en `contract-changes.ts` (`planPause`, `planResume`) y el servicio (`insert_pause`,
  `update_pause`, `pause_event_id` / `resume_event_id`); `deriveContractStatus` + `derivedStatusLateral` derivan **Pausado** cuando todos los
  recurrentes vivos están pausados hoy; detalle `pauses[]` y `GET /contracts/:id/items` `items[].pauses[]`; asset
  `revenue_schedule_rebuild_contract_ccy` con devengo prorrateado por días pausados (sobre los días activos del ítem en el mes), MRR 0 con el fin
  de mes pausado, CMRR 0 solo si la pausa es abierta y `momentum` `PAUSE` (primer mes con fin de mes pausado) / `RESUME` (mes del día siguiente
  al fin; ninguno si pausa y reanudación caen en el mismo mes). B2-3 intacto.
- Desvíos y supuestos (a confirmar con Domi):
  12. Actor "sistema" de los jobs = uuid `00000000-0000-0000-0000-000000000000` en `created_by` (columna NOT NULL sin FK) +
      `metadata.created_by_system`; las propuestas y avisos nacen `event_status = 'Pending'` y pasan a `Completed` al confirmar/omitir.
  13. Una propuesta por **contrato** y corrida (agrupa sus ítems); la idempotencia es por ítem y fin (`metadata.proposal_keys`), en cualquier
      estado: una propuesta omitida no se repite para el mismo fin. Ítems ya renovados u omitidos por otra vía no se listan (la propuesta sin
      ítems pendientes desaparece de la lista sin cambiar de estado).
  14. Notificaciones `contract_renewal_proposed` / `contract_scheduled_change_due` (source `contracts`) a los suscritos por tipo + super
      admins (`include_super_admins`); omitir cierra la notificación; confirmar no (queda para B2-6).
  15. El aviso de un pacto `index` lleva la variación a la fecha o `index_value_missing` en `metadata.blockers` (no bloquea el aviso).
  16. `pause` usa `pause_start` como fecha efectiva (y `resume`, `resume_date`); sin lista pausa todos los recurrentes vivos y cada ítem
      arrastra sus ajustes vivos (UPSELL/DOWNSELL con `related_item_id`) con su propia fila. `pause_end` posterior al fin del ítem → 400.
  17. `extend_term` con `pause_end` conocido corre el fin **al pausar** (y factura el tramo nuevo); reanudar antes devuelve la diferencia
      (baja de líneas desde el nuevo fin, NC si hubiera emitidas). Pausa abierta: el fin se corre al reanudar.
  18. Bloqueo nuevo `not_paused` (reanudar sin pausa vigente o futura); reanudar antes de que empiece la pausa la deja `cancelled`.
  19. La NC por días pausados (`void`) usa `credit_reason = downsell` (regla de la NC espejo de las bajas parciales).
  20. `ALLOWED_STATES`: con el contrato Pausado se admiten `billing_conditions`, `change_entity`, `item_remove`, `contract_cancel`,
      `renewal`, `multicurrency` y `resume`; `pause` solo en Activo / Por renovar.

### 9.6c Construido 01-10 (cierre): F4, NC siempre Emitida, tramos con consumo, horizonte de indefinidos

- **F4 · Corregir un dato mal cargado**: §9.2.1 (`item_update` extendido; evento `ITEM_CORRECTED`). Tests `contract-changes.spec.ts`
  "item_update · corregir un dato mal cargado" y `contract-changes.service.spec.ts` "corrección de cantidad…".
- **NC**: `creditNoteStatusFor` devuelve siempre `Emitida` (la factura acreditada puede estar Emitida, Enviada, Pagada, Vencida o
  parcialmente pagada; nunca se copia Pagada/Vencida). Sobre una Por Emitir no se crea NC (se reescribe la factura).
- **`item_change` en un ítem por tramos con consumo registrado**: el período con consumo se re-tarifa con la cantidad registrada por el motor
  (`pricedItemInvoicesByPeriod` con `consumption`, filas por tramo en `per_tier`), nunca por el camino de una fila; aviso
  `consumption_quantity_kept`.
- **Indefinidos**: job diario `contracts-extend-horizon` (05:45, `contracts.scheduler.ts`): por contrato Activo, los recurrentes sin término vivos
  (sin churn, sin renovar, sin pausa abierta) reciben las Por Emitir que faltan para tener siempre 12 períodos desde hoy, solo hacia adelante
  desde el último día facturado (`planHorizonExtension` + `restoreItemBilling` + `mergeTarget`); idempotente con el contrato bloqueado;
  evento `HORIZON_EXTENDED` por contrato solo si creó algo. Tests `contract-horizon.spec.ts`.
- **RSM**: `apply_pending_renewal_tail` v1.3 sin cola en Cancelado/Borrador/En revisión (borra la que hubiera) ni en meses con pausa
  activa/programada del ítem (asset sin aplicar).

### 9.7 Pendientes

- Cambiar el día de ciclo de un ítem vivo (período corto de transición) y del contrato.
- Pausa `scope billing` (posponer cobro sin pausar servicio) y pausa masiva (varios contratos).
- Cerrar la notificación de la propuesta al confirmarla. (Alertas crecientes al vencer sin decisión, S2-1/S5-4: **hechas 02-10**, job `contracts-renewal-reminders`, ver cobertura §3.)
- Intercompañía / cambio de compañía emisora (M10) y cambio de cliente comercial (fuera por decisión).
- Workflow de aprobación (fuera).
- Preguntas abiertas de pactos (IPC acumulado vs. 12 meses, desfase, redondeo, CMRR pactado): se construyen con la propuesta como default por fila
  (ver §7 de [`spec-renovacion-y-ajustes-pactados.md`](./spec-renovacion-y-ajustes-pactados.md)).
