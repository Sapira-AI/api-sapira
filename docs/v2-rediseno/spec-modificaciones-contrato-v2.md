# Spec · Modificaciones de contrato v2 (M1–M6 del mapa)

> 28-09-2026 · borrador para revisión de Domi; implementadores: api-sapira (`src/modules/contracts`) y front-sapira
> (`app/(protected)/lab/contratos`). Consolida lo ya decidido en [`auditoria-contratos.md`](./auditoria-contratos.md)
> (§6, S2, S3, S4, S5, S6), [`manual-modificaciones-contratos.md`](./manual-modificaciones-contratos.md),
> [`mapa-v2-contratos.md`](./mapa-v2-contratos.md) (§1, §2d, §3, §4, §5), [`flexibilidad-con-trazabilidad.md`](./flexibilidad-con-trazabilidad.md),
> [`mejoras-y-brechas.md`](./mejoras-y-brechas.md) (A.4, E.2) y los benchmarks de `benchmarks/`. Cada regla se marca
> **DECIDIDO** (con la fuente) o **ABIERTO** (qué falta decidir, opciones, recomendación). Lo que no está en ningún
> doc y hace falta para escribir la spec va como **Supuesto**. Este documento no toma decisiones nuevas.

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
- `contract_cancel` con Por Emitir que tienen líneas editadas a mano desde la fecha efectiva → blocker `manual_lines_pending` ("Edita o
  cancela esas facturas primero"); el rediseño completo de la cancelación queda diferido.
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
| **E · Solo después de que Domi decida** | renegociación con cambio de frecuencia/término (S3-15), `pause`/`resume` (§2.6), `price_adjustment` y condiciones pactadas (§2.8, S1-18, M5 indefinido), reversión de churn con ventana (§2.7), clasificación a nivel cliente (§8), cross-sell multimoneda (M3), compañía emisora (M10) | Cada uno tiene puntos abiertos que cambian el modelo de datos |

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
