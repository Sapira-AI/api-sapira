# Manual de modificaciones de contrato (cómo funciona hoy)

> 23-09-2026 · segunda vuelta de S3 de la [auditoría de contratos](./auditoria-contratos.md). Describe el
> **funcionamiento** caso por caso (no solo bugs), con fórmulas, ejemplos y la intención de diseño. Solo lectura.
> Rutas: `SQL` = `api-sapira/src/databases/postgresql/functions/` (AQD `apply_quote_downsell_to_contract`, ACC
> `apply_contract_contraction`, CCR `create_contract_renewal`, ACA `approve_contract_amendment`, ACPF
> `auto_calculate_pricing_fields`, CMPP `calculate_monthly_and_period_prices`, RSMR `revenue_schedule_rebuild_contract_ccy`,
> ARPS `apply_renewal_price_split`, SCIE `set_contract_item_end_date`) · `FRONT` = `sapira-ai/src/components/` (UPS
> UpsellingModal, CTM ContractionModal, PRU prorationUtils, INVC invoiceCalculator, RSU revenueScheduleUtils, ATC
> AssignToContractModal, CIS ContractItemsSummary) · `DOCS` = `sapira-ai/docs/contratos/` (IMR item-madre-y-renegociacion,
> CU contraccion-unificada, RCP renovacion-con-cambio-de-precio, DPR DOWNSELL_PARCIAL_RPC, OB
> `../facturacion/implementacion_opcion_b_prorrateo.md`). **[NO VERIFICADO]** = inferido del código sin caso real.

## 0. Reglas comunes

- **Modelo acumulativo**: un ítem nunca se edita en su lugar; cada modificación agrega un ítem de ajuste y el original
  queda intacto (base de auditoría, devengo y momentum) (IMR:8-13; CU inv. 1).
- **Precios** (trigger ACPF en cada INSERT/UPDATE): `unit_price` siempre **mensual** (modo anual: `annual_unit_price/12`);
  `monthly_price` (MRR) = `GREATEST(ROUND(unit × qty × (1 − desc%)), 0)` en no DOWNSELL/CHURN (monto fijo: `final/term`)
  (CMPP:16-43); en DOWNSELL/CHURN `ROUND(final/term, 2)` (ACPF:31-35); `billing_period_price` = mensual × meses de la
  frecuencia; `price` y `final_price` los manda cada flujo (`price = unit × qty × term`, `final = price − descuento`).
  La doc `diseno-campos-pricing-mensual.md` §3.2 dice que el mensual no descuenta: **desactualizada** (CMPP sí descuenta).
- **Fin del ítem**: `end_date = inicio + term − 1 día` siempre (SCIE:7-8); los flujos que necesitan otro fin lo fuerzan con
  un UPDATE solo de `end_date`.
- **El RSM lee dos cosas**: el devengo sale de `final_price/term_months` (RSMR:103-104); MRR y CMRR de `monthly_price`
  (RSMR:200, 207). Si difieren, reconocido y MRR divergen.
- **Signos**: DOWNSELL y CHURN con `unit_price` y `final_price` negativos (cantidad positiva, salvo el delta de
  renegociación). UPSELL y CROSS-SELL positivos.
- **Relaciones**: `related_item_id` (ajuste → base), `renews_item_id` (RENEWAL → renovado), `renewed_by_item_id` (en el
  renovado, en el cortado por renegociación y en los UPSELL absorbidos por una renovación).
- **Día de facturación del contrato**: día del `MIN(start_date)` de los recurrentes no DOWNSELL/CHURN, en dos copias
  (PRU:23-41, RSMR:79-83). La intención era el día del **ítem relacionado** (OB:28-29, nunca implementado).
- **Frontera de lo facturado**: `MAX(billing_period_end)` de las líneas emitidas del ítem (AQD:139-149).

## 1. Upsell por cantidad

Más unidades al mismo precio. **Desde el contrato** (UpsellingModal): ítem base (solo vigentes sin `related_item_id`: no
hay upsell sobre upsell), modo final/delta, switch mensual/anual; `qty = Δq`, `unit` = unitario mensual del base, `term`
= meses entre inicio y fin (+1 si el día de fin ≥ día de inicio), `final = unit × qty × term × (1 − desc del base)`
(UPS:283-401). **Desde la cotización**: "Cantidad final" o "Solo Δ cantidad" (ATC:147-162, 239-261). Crea un UPSELL con
`related_item_id`. Facturas: cronograma propio (con prorrateo si el día no calza, §11) fusionado con las Por Emitir —
UpsellingModal por **mes de emisión**, AssignToContract por **fecha exacta**; ambos con moneda del ítem, fx 1 y `due =
emisión`; sin NC. Ítem madre: cantidad + Δq, MRR + Δq × unit.
**Ejemplo**: base 5 × 100, upsell 1 × 100 → madre 6 × 100 = 600.
**Intención vs hoy**: debería heredar ciclo, método, moneda y vencimiento y terminar con el contrato; sin ítem
relacionado el plazo no se acota (Bosch; 20 de 44 ítems).

## 2. Upsell por precio unitario

Misma cantidad a mayor precio. UpsellingModal: `unit = Δp` mensual, `qty = qty del base`; AssignToContract: `unit =
|ingresado − relacionado|` (final) o el ingresado (delta). UPSELL con `qty` = cantidad total (**ancla**) y `unit = Δp`, así
`qty × unit = ΔMRR` (IMR:84-87). Ítem madre: un ajuste con cantidad **igual** a la del relacionado se reconoce como "de
precio" y aporta 0 a la cantidad (CIS:264-272).
**Ejemplo**: 1 × 100 → 120 = UPSELL 1 × 20; madre 1 × 120.
**Intención vs hoy**: si la cantidad de la cotización difiere, el ítem madre lo suma como cantidad (el detector exige
igualdad exacta).

## 3. Final vs delta, mensual vs anual

| Entrada | UpsellingModal | AssignToContract |
|---|---|---|
| Final | `Δ = nuevo − actual` | `Δ = ingresado − relacionado` |
| Delta | `Δ = ingresado` | `Δ = ingresado` |
| Anual | `Δ mensual = Δ/12`; guarda `price_entry_mode='annual'` | switch M/A; unitario mensual |
| Default | "final" | **"Solo Δ precio"** |

**Dos ejes a la vez en UpsellingModal** guarda `unit = Δp` y `qty = Δq` y **pierde el término cruzado** (el propio
código lo dice, UPS:129-131): STG 160 × 13,68 → 140 × 16 daría −46,40 cuando el cambio real es **+51,20**. La única forma
correcta es la renegociación (§8). Plazo: UpsellingModal "alineado" o "N meses"; AssignToContract amarra el fin al
relacionado en delta/cantidad, no en "Precio final".

## 4. Cross-sell

Producto nuevo. CrossSellingModal: `final = unit × qty × term × (1 − desc)` → RPC `create_contract_cross_sell` →
`approve_contract_amendment` rama CROSS_SELL (plazo 12 y USD por defecto). AssignToContract: bloquea si el producto ya
existe. Facturas (RPC): períodos desde el inicio **sin prorrateo**, `(final/term) × freq`, fusión por mes de emisión sin
excluir unificadas, `due = emisión`, fx 1, línea con `unit = mensual` (no cumple qty × unit = subtotal). RSM: primer
mes prorrateado si el día ≠ ciclo (la factura no).
**Ejemplo**: CTR-2026-86 DATAMART 1 × 25,10, 12 meses, final 301,20.
**Intención vs hoy**: S3-5 dice que el cross-sell prorratea por días; por la RPC la factura no lo hace (sí por
AssignToContract).

## 5. Downsell parcial por cantidad

ContractionModal "Reducción parcial" (`final_quantity`/`delta_quantity`) o cotización DOWNSELL → AQD con `quantity` =
unidades a quitar. `mensual_ds = (monthly_price/qty) × uds` (incluye descuento); `term` = meses entre inicio y
`LEAST(fin pedido, fin original) + 1`; `final = −(mensual_ds × term)` (AQD:466-505). Crea DOWNSELL con `related_item_id`,
sin `churn_date`. Facturas: en las Por Emitir con período ≥ fecha efectiva **baja la cantidad de la línea del original**
(escala montos; si llega a 0, borra la línea); emitidas → **NC de anulación + reemplazo** rebajado; el período que
contiene la fecha **no se toca** (sin prorrateo). Ítem madre: resta `uds`.
**Ejemplos**: S04172 (−3 → neto 2: emitida del 28-06 con NC + reemplazo 1,94; PE jul–dic 1,94) · Pehuen 9 → 7 (una línea
7 × UF 0,96 = 6,72).
**Intención vs hoy**: el 100% debería ir a churn (S3-7): la guarda solo rechaza `uds > qty` (AQD:494). ContractionModal sí
lo desvía; AssignToContract no.

## 6. Downsell por precio o por mensual (los "6 modos")

`computeNewMonthly` (CTM:150-202), base `monthly_price`:

| Modo | Mensual nuevo | RPC |
|---|---|---|
| `full` | 0 | ACC (§7) |
| `final_monthly` | ingresado | AQD `new_monthly` |
| `final_unit_price` | `(p_nuevo/p_actual) × mensual` | AQD `new_monthly` |
| `final_quantity` | `(q_nueva/q_actual) × mensual` | AQD `quantity` |
| `delta_unit_price` | `max(0, p − Δ)/p × mensual` | AQD `new_monthly` |
| `delta_quantity` | `max(0, q − Δ)/q × mensual` | AQD `quantity` |
| `renegotiation` | `q × p × (1 − desc)` | AQD renegociación (§8) |

Rama precio de AQD: `ds = mensual_orig − new_monthly`, `qty` = la del original, `unit = −ds/qty` (ancla); guardas
`new_monthly ≤ 0` → "usa churn", `≥ actual` → "no es reducción"; en las PE la cantidad queda y unitarios y montos se
escalan por `new_monthly/monthly_price`; emitidas con NC + reemplazo.
**Ejemplo**: 1000 → 800 con 20% de descuento → 160 → 128, descuento preservado.
**Intención vs hoy**: desde la cotización la rebaja por **precio** se ejecuta como downsell por cantidad; un segundo
downsell escala contra el mensual del original, no contra el neto.

## 7. Downsell total y churn (early vs non-renewal)

ContractionModal tipo CHURN (todos los ítems) o DOWNSELL modo `full` → ACC; motivo de `churn_reasons`; fecha sugerida =
próxima PE. `delta = mensual_orig − nuevo`; ítems con mensual 0: en CHURN se marcan, en DOWNSELL se saltan.
**Non-renewal** (efectiva = fin + 1 o posterior): sin ítem; `churn_date` al original; fila RSM CHURN/DOWNSELL = −delta en
el mes efectivo y el rebuild agrega BOP "tail" +mensual: netean 0. **Early** (efectiva ≤ fin): **fantasma** con la
categoría del tipo pedido, desde el **día 1 del mes** efectivo hasta el fin del original, `term = meses + 1`, `unit =
−delta`, `final = −delta × term`, `related_item_id` al original.
Facturas: **cancela la PE completa** si tiene alguna línea del ítem con período ≥ efectiva (incluye líneas de otros
ítems); **prorratea por días servidos** la PE que contiene la fecha; emitidas con período ≥ efectiva → **NC por los días
no consumidos** que nace Emitida (bug de moneda con conversión); TV = Σ finales; en CHURN sin ítems activos el contrato
pasa a Cancelado; rebuild.
**Ejemplos**: non-renewal PEN-01 SICT (feb-26: BOP +7.491,67 y CHURN −7.491,67) · early 1.000/mes con baja el 15-06 →
fantasma 01-06 a 31-12, term 7, final −7.000.
**Intención vs hoy**: la fecha que manda es el inicio del ítem CHURN; hoy el fantasma parte el día 1 y NC y cortes usan el
día exacto (20 de 51 contratos; La Mascota).

## 8. Renegociación (cantidad y precio a la vez)

Menú "Renegociación" o cotización tipo "Renegociación (cant. + precio)": siempre **valores nuevos completos** (cantidad,
unitario mensual, descuento, opcional frecuencia y fin) → AQD con `new_quantity`/`new_unit_price`.
**Validaciones explicativas**: q, p > 0 · sin overrides de cantidades variables · inicio > inicio del ítem · inicio >
frontera de lo facturado · inicio = inicio de ciclo · término en meses enteros múltiplo de la frecuencia · "sin cambio" es
error.
**Fórmula unificada del delta** (IMR:82-106):

```
mensual_nuevo = ROUND(q_n × p_n × (1 − desc%), 2)
ΔMRR  = mensual_nuevo − mensual_actual        → el signo decide UPSELL o DOWNSELL
Δq    = q_n − q_actual
si Δq ≠ 0: qty = (DOWNSELL ? −Δq : +Δq);  unit = ΔMRR / qty
si Δq = 0: qty = q_actual (ancla);         unit = ΔMRR / q_actual
final = ΔMRR × term                        → qty × unit = ΔMRR siempre
```

**Rama A (misma frecuencia y término)**: original intacto + un ítem delta sin descuento; las PE con período ≥ inicio se
**reescriben al valor nuevo** y siguen apuntando al original. **Rama B (cambia frecuencia o término)**: corte del
original en `inicio − 1`; RENEWAL **al valor anterior** con `renews_item_id`; delta relacionado al RENEWAL; se borran las
líneas PE del original ≥ inicio; facturas nuevas por período con el monto consolidado apuntadas al RENEWAL (+30, cabecera
copiada); **extiende `contract_end_date`** (único lugar).

| Caso | Datos | Resultado |
|---|---|---|
| STG-38 | 160 × 13,68 = 2.188,80 → 140 × 16 = 2.240 | ΔMRR +51,20 → UPSELL −20 × −2,56; madre 140 × 16 |
| Cruzado | 100 × 10 → 120 × 7 | ΔMRR −160 → DOWNSELL −20 × +8; madre 120 × 7 |
| Cooprinsem | 2 × 1,45 mensual → 2 × 1,25 anual | corte + RENEWAL 2 × 1,45 (34,80) + DOWNSELL 2 × −0,20 (−4,80) → PE anual 30,00 |
| Moving Food | 9 × 1,21 → 9 × 1,10 anual | RENEWAL 130,68 + DOWNSELL 9 × −0,11; PE anual 118,80 |

**En prod hoy ninguno quedó con el modelo de la RPC**: STG-38 es un ítem único 140 × 16 (arreglo manual), Moving Food un
RENEWAL sin delta (el waterfall no muestra la contracción), Cooprinsem se revirtió → 0 usos reales.

## 9. Renovación

EnhancedRenewalModal (1 ítem, overrides de unitario, cantidad, final y precio) o MultiItem (**una llamada por ítem**) →
CCR. Guardas: no renueva churneados, ya renovados ni DOWNSELL/CHURN. `term` = override o el del original; frecuencia y
método override o del original; detecta cambio de precio (`final_override/term` vs mensual). **Absorbe los UPSELL hijos**
vivos (suma su mensual × term al final y los marca `renewed_by_item_id`); RENEWAL con `renews_item_id`; si cambió el
precio guarda `renewal_base_unit_price`. Facturas: un período por frecuencia `(final/term) × freq`, `export_type = 1`
fijo, `due +30`, o cronograma personalizado. **RSM (price split)**: mes 1 separa RENEWAL a la base y UPSELL/DOWNSELL al
delta; del mes 2 en adelante BOP al precio nuevo (ARPS:49-70).
**Ejemplos**: 1.000 → 1.500 (junio RENEWAL 1.000 + UPSELL 500; julio BOP 1.500) · 1.000 → 800 (RENEWAL 1.000 + DOWNSELL
−200) · CTR-2026-86 FORCEFIELD: RENEWAL 25 × 0,58 + UPSELL 105 × 0,58 → madre 130 × 0,58 = 75,40.
**Intención vs hoy**: la absorción de hijos suma al `final` pero el trigger recalcula `monthly` sin hijos → el MRR no los
contaría [NO VERIFICADO]; **0 casos en prod**. El split ignora el descuento del original [NO VERIFICADO]. No actualiza fin
ni TV; `export_type = 1` fijo.

## 10. Ítem madre ("Estado vigente por producto")

Agrupa por `product_name | cuenta` (la cuenta separa). Ámbito = vigentes **ya iniciados** (inicio futuro no cuenta).
**Cantidad vigente** = Σ qty de las bases + por cada ajuste: de precio aporta 0; UPSELL suma, DOWNSELL resta. MRR vigente
= Σ `monthly_price`; monto por factura = Σ `billing_period_price`; unitario efectivo = MRR ÷ cantidad. **Próxima factura
por grupo**: la PE activa más próxima con líneas del grupo; check verde si la diferencia ≤ 0,05.
**Ejemplos**: Cooprinsem 2 × 1,25, MRR 2,50, por factura 30,00 ✓ · FORCEFIELD 130 × 0,58.
**Intención vs hoy**: tras un churn early el fantasma CHURN seguiría "vigente" y el grupo mostraría MRR negativo [NO
VERIFICADO]; upsell de dos ejes deja el MRR mal; el comentario de cabecera describe la regla anterior; se perdió la
columna "Tipo".

## 11. Prorrateo por días ("Opción B")

**Intención** (OB:9-30): el devengo arranca en el mes del inicio y dura `term` meses; el prorrateo es una excepción **solo
del primer período** de un ítem relacionado (UPSELL, CROSS-SELL o DOWNSELL) cuyo día ≠ día del relacionado; NEW, RENEWAL y
REACTIVATION nunca prorratean. ⚠️ OB incluye DOWNSELL, lo que **contradice S3-5** → actualizar ese doc.

```
día_ciclo  = día de MIN(start_date) de los recurrentes no DOWNSELL/CHURN
próximo    = próxima fecha con día = día_ciclo (o último día del mes)
stub       = [inicio, próximo − 1]
monto_stub = precio_período × días_stub / días_del_mes_de_inicio
luego      = períodos completos alineados desde "próximo" hasta el fin
```

**Ejemplos**: ciclo día 1, upsell el 27-ene, 100/mes → 100 × 5/31 = **16,13**, luego 100 desde el 01-feb · **Bosch**: ciclo
día 1, upsell 1 × 47,91 desde el 08-09 → stub 23/30 × 47,91 = **36,73** + oct/nov/dic 47,91 = **180,46**.

| Flujo | Dónde queda el stub |
|---|---|
| UpsellingModal | Fusionado en la PE del mismo mes; período del stub mal (`emisión + freq − 1`); cuotas truncadas |
| AssignToContract | Factura **separada** en la fecha de inicio; `term = meses + 1` infla el final (Bosch 239,55 vs 180,46) |
| Cross-sell RPC | Sin prorrateo |
| Renegociación | Prohibido (inicio de ciclo) |

Diseño decidido: el stub va en la **factura del ciclo del contrato** (Bosch reparado: stub de septiembre en la PE del
01-10). **RSM**: prorratea el primer mes calendario `(final/term) × días/días_mes`; como `final/term` ya trae el stub,
en Bosch hay **doble prorrateo**: 23/30 × 45,115 + 3 × 45,115 = 169,94 (−10,52, el −10,51 registrado).
**Por qué no en downsell (S3-5)**: hoy hay tres criterios para el mismo downsell a mitad de ciclo (AQD no toca el período
y calcula `term` por meses; el RSM prorratea por días calendario; ACC prorratea PE y NC por días exactos y el fantasma
parte el día 1) → tres números distintos. "El downsell rige desde el próximo inicio de período" los colapsa.
**Hallazgo lateral** [NO VERIFICADO]: en frecuencias trimestral/semestral/anual el stub se valoriza como `precio_período ×
días / días_del_mes` → cobra 3, 6 o 12 veces el tramo real.

## Lo que tiene que seguir funcionando sí o sí

1. Ítems acumulativos: el original nunca cambia; los ajustes van con signo y relación.
2. `qty × unit` del delta = ΔMRR siempre, con ancla en la dimensión que no cambia (STG; cruzado).
3. Convergencia: un cambio de solo precio o solo cantidad produce la misma fila entre por la puerta que entre.
4. Frontera de lo facturado: nunca reescribir lo emitido; corte del ítem o NC con reemplazo (S04172, Pehuen, Moving Food).
5. Renegociación con cambio de frecuencia/término: corte + RENEWAL al valor anterior + delta; el waterfall muestra
   renovación **y** contracción (Moving Food, Cooprinsem).
6. Las PE rebajadas quedan en una línea neta, nunca líneas negativas hacia Odoo (Pehuen).
7. El ítem madre coincide con la próxima factura (Cooprinsem 30,00; FORCEFIELD; la cuenta separa, Turboboy).
8. Primer período proporcional por días en upsell y cross-sell, en la factura del ciclo, y **Σ facturas = TV = devengo**
   sin doble prorrateo (Bosch 180,46).
9. Downsell sin prorrateo: rige desde el próximo inicio de período (S3-5/S3-6).
10. Downsell del 100% → churn o contracción (S3-7).
11. Churn: non-renewal sin ítem (UPSERT + tail BOP), early con fantasma; manda el inicio del ítem CHURN; ítems en $0 no
    bloquean (PEN-01, La Mascota, Porvenir).
12. Renovación con cambio de precio: mes 1 separa RENEWAL y delta, luego BOP (TIMining; FORCEFIELD).
13. Renovación que absorbe los UPSELL hijos sin doble renovación (0 casos hoy: cubrir con test antes de rediseñar).
14. Switch mensual/anual en todas las entradas; `unit_price` persistido mensual.
15. Descuento % preservado en rebajas y renegociación (DPR: 160 → 128; Sinba).
16. Cantidades variables fuera de la renegociación, sin pisar el MRR contractual.

## Dónde la complejidad es accidental

1. **Tres puertas** para cambiar un ítem (UpsellingModal, ContractionModal en 7 modos, AssignToContract en 5 tipos) + dos
   RPC de downsell + upsell inline → **una sola entrada: "valores nuevos completos (q, p, desc, frecuencia, fin) + fecha
   efectiva"** con la fórmula unificada del delta. Upsell por cantidad, por precio, downsell parcial y renegociación son el
   mismo cálculo con distinto signo.
2. Final/delta/por mensual son **ayudas de captura**: en el backend todo es `(q_n, p_n)`.
3. **Dos formas de guardar la renovación con cambio de precio** para el mismo modelo de negocio: el camino corto (1 RENEWAL
   al precio nuevo + `renewal_base_unit_price` + split en el RSM) y la renegociación (RENEWAL al valor anterior + delta).
   Mantener el camino corto como experiencia (un paso) y unificar el almacenamiento en la forma explícita, que ya usa el
   ítem madre (S3-15, por confirmar).
4. **Dos modelos de contracción** (fantasma negativo en ACC vs DOWNSELL sin churn en AQD): la única diferencia real es
   total vs parcial.
5. **Seis generadores de períodos, tres criterios de prorrateo y dos de fusión** → un solo generador con el día de ciclo del
   contrato, stub en la factura del ciclo y fusión por período excluyendo unificadas.
6. **Dos fuentes de mensual** (`monthly_price` del trigger vs `final/term`): raíz del −10,51 de Bosch.
7. **Día de facturación derivado de `MIN(start_date)`** en dos copias → dato explícito del contrato (o día del ítem
   relacionado, como decía OB).
8. **Aprobaciones y amendments** que no se usan (S3-10) → un evento único con usuario.
