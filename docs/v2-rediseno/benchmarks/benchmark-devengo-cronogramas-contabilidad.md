# Benchmark — devengo, cronogramas de facturación, FX en reportes, intercompañía y asientos

> 24-09-2026 · insumo de S5 de [`../auditoria-contratos.md`](../auditoria-contratos.md) y de la observación de Domi en S4
> (facturación no estándar con trazabilidad línea ↔ ítem). No repite §1 (métodos para no recurrentes, granularidad) ni §4
> (FX contable, IFRIC 22) de [`benchmark-contratos-revrec-multimoneda.md`](./benchmark-contratos-revrec-multimoneda.md).
> Etiquetas: **[Norma]** · **[Mercado]** · **[Opinión]**. Las páginas de Zuora y Salesforce Help no cargaron completas: lo
> citado sale de los fragmentos de búsqueda de sus propias URLs.
>
> **Ya existe en Sapira y se reutiliza**: `revenue_schedule_monthly` trae `recognized_*`, `billed_*`,
> `deferred_balance_eom_*` y `unbilled_balance_eom_*` en tres monedas (`_ccy`, `_contract_ccy`, `_system_ccy`) + MRR y CMRR;
> existen `accounting_period_cutoff` y `accounting_period_events`; `spec-tablas-por-modulo.md` planea `journal_entries` y
> `recognition_methods`.

## 1. Cronograma de facturación separado del de devengo

- **Zuora** "Billing Schedule": factura cargos específicos con fechas y montos propios; cuotas **monto fijo o %** (suman
  100%, centavo a la última); el **consumo queda fuera**; si el contrato cambia, el cronograma se actualiza; el devengo es un
  revenue schedule **por cargo**, aparte.
  [overview](https://knowledgecenter.zuora.com/Zuora_Billing/Bill_your_customers/Flexible_Billing/Billing_Schedule/AA_Overview_of_Billing_Schedule) ·
  [hitos %](https://knowledgecenter.zuora.com/Zuora_Billing/Bill_your_customers/Leverage_advanced_capabilities/Flexible_Billing/Billing_Schedule/Billing_Schedule_use_cases/BA_Create_percentage-based_invoice_schedules_for_professional_services_during_project_milestone_billing)
- **NetSuite**: *billing schedule* (cuándo y cuánto facturar) ≠ *revenue recognition schedule*; hitos como % del total
  atados a tareas; para devengar hitos a precio fijo, **el plazo del devengo no puede salir del cronograma de facturación**
  (separación obligatoria). [milestone](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_N1206555.html)
- **Salesforce Billing**: *billing treatment* con ítems (30% al activar, 70% a 90 días) y *revenue recognition treatments*
  separados, incluso varios en paralelo.
  [milestone billing](https://help.salesforce.com/s/articleView?language=en_US&id=sf.blng_milestone_billing.htm&type=5)
- **Chargebee**: advance invoice schedules (hasta 5), payment schedules (cuotas de **cobro**, no de facturación), ramps.

**Patrón**: plan de facturación **por cargo/ítem** con cuotas `{fecha, % | monto}` que suman el total; el devengo se deriva
del ítem y su método, **no de las facturas**; la factura conserva el vínculo cargo → línea aunque cambie la glosa.
**Sapira [Opinión]**: `contract_item_billing_plan` modo `standard` (frecuencia × anticipado/vencido) o `custom` (cuotas con
fecha, % o monto en moneda de contrato, hito y período opcionales; Σ = valor del ítem, redondeo a la última).
**Reestructurar cronograma pasa a ser el editor de ese plan**; "Aplicar cambios" (S4-2) materializa las Por Emitir; edición
libre del borrador (S4-1) con `invoice_items.contract_item_id` **obligatorio** salvo líneas `adhoc`; desvío plan ↔ facturado
por ítem como aviso; **el devengo nunca lee el cronograma de facturación**.

## 2. Deferred, unbilled y saldos a fin de mes

**[Norma]** IFRS 15 ¶105-108: activo o pasivo del contrato según desempeño vs pago; la factura emitida es cuenta por cobrar
aparte; presentación **neta por contrato** (TRG / PwC).
**Mercado**: **Stripe** period summary (reconocido por origen: facturas del mes, previamente diferido, consumo, servicios no
facturados; roll-forward **inicial + facturado − reconocido − créditos = final**; waterfall solo de lo facturado;
drill-down a línea) ([doc](https://docs.stripe.com/revenue-recognition/reports/period-summary)) · **NetSuite ARM** (D Unbilled
/ H Deferred al cierre, neteo por contrato, reverso el período siguiente) · **Chargebee RevRec** (unbilled por contrato con
auto-reverso; roll-forwards con ajustes FX).
**Sapira [Opinión]**: invariante por ítem y mes `deferred_eom − unbilled_eom = billed_cum − recognized_cum` en las tres
monedas (regla triple A.9); vista **neta por contrato** derivada + bruta por ítem; reporte roll-forward por
emisora/contrato/ítem con drill-down; waterfall en dos capas (facturado y contratado, el CMRR da la segunda). **Variables**:
`as_billed`; consumo medido no facturado al cierre → unbilled; sin deferred proyectado.

## 3. Granularidad y evergreen (lo nuevo)

NetSuite distingue "even periods" / "exact days" por regla; Stripe admite 4-4-5 (no aplica en LatAm). Mantener la política
**por razón social emisora** (S1-6).
**Evergreen [Norma ¶11]**: con terminación sin penalidad el contrato es del período en curso. **Zuora** extiende la fecha de
fin del devengo y el monto booked **con cada factura**; para CCV usa un fin estimado.
**Sapira [Opinión]** (M5): RSM del ítem evergreen en **ventana móvil** (período en curso + N meses para CMRR/pronóstico); filas
futuras `projected`, sin deferred ni asiento; proceso mensual que extiende la ventana.

## 4. Moneda de reporte, efecto FX y diferencias de cambio

**[Norma]** IAS 21 ¶39-41: conversión a moneda de presentación: activos y pasivos a tasa de cierre, ingresos a tasa de la
transacción (**promedio** si no fluctúa significativamente) → la diferencia va a **ORI (CTA)**, no a resultados. Distinto: la
diferencia de **transacción** (factura en moneda extranjera vs funcional) → resultados (no realizada al cierre, realizada al
cobro). **Moneda constante** (métrica de gestión): efecto FX = actual a tasa actual − actual a tasa del período base.
**Mercado**: Stripe (ingreso a tasa de facturación, cobro a tasa de pago, diferencia a FxLoss); NetSuite (ajuste FX sobre lo
facturado y, opcional, sobre el **unbilled**; el deferred no se re-mide).
**Sapira [Opinión]** (M8, M9): tres efectos en tres lugares: (1) diferencia de **transacción** en asientos de facturación y
cobro (realizada, no realizada y **reajuste UF** separados); (2) re-medición del unbilled, opcional por emisora (apagada por
defecto); (3) conversión a moneda de sistema **solo en reportes** (CTA, sin asiento). Reporte con columnas a tasa real · a
tasa constante · **efecto FX**, también para MRR y CMRR.
⚠️ **Choque con S1-17**: el promedio mensual es válido para convertir resultados (¶40), pero cuando se factura por adelantado
IFRIC 22 fija la **tasa de la factura** para el deferred. Propuesta: promedio mensual para lo reconocido sin factura previa y
tasa de factura para lo liberado desde deferred; `fx_rate_source` por fila. **Decisión de Domi con el contador.**

## 5. Intercompañía

**[Norma]** IFRS 10 B86: en el consolidado se eliminan saldos, ingresos y gastos intragrupo; en los individuales cada entidad
evalúa principal/agente. **NetSuite**: el ingreso va en la subsidiaria **que factura**; cross-charges intercompañía al cierre
y asientos de eliminación.
**Sapira [Opinión]** (M10): `contracting_company_id` (firma y presta) y `billing_company_id` por ruta/línea (A.5), por defecto
iguales; si difieren: devengo en la emisora que factura, cargo IC sugerido al cierre (regla % o costo + margen) y marca de
eliminación. ⚠️ En LatAm el documento IC puede requerir DTE: validar con Leon y el contador; fase 1 = reportar ingreso por
entidad contratante vs facturadora y dejar el asiento IC como sugerido.

## 6. Asientos y cierre

| Evento | Asiento típico |
|---|---|
| Facturación | D CxC / H Deferred (o H Ingreso si se reconoce al facturar) + IVA |
| Reconocimiento | D Deferred / H Ingreso |
| Reclasificación al cierre | D Unbilled / H Deferred (o al revés), revertida el período siguiente |
| NC / anulación | Reverso contra ingreso o deferred |
| FX | Realizada al cobro, no realizada al cierre sobre CxC (y opcional sobre unbilled) |

NetSuite no asienta en períodos cerrados. **Zuora**: Open / Pending Close / Closed; lo distribuido en abiertos se puede
modificar; reapertura con reglas. **Stripe**: correcciones sobre períodos cerrados se registran **en el período abierto en
curso**. **Zenskar**: reposteo respetando bloqueos.
**Sapira [Opinión]**: `journal_entries` generado desde el delta del RSM por (emisora, período); **mapeo de cuentas por razón
social emisora × tipo de ítem/producto** (ingreso, deferred, unbilled, CxC, FX realizada, no realizada, reajuste UF, IC); cierre
`open | closing | closed` sobre `accounting_period_cutoff`: lo cerrado no se reescribe, los cambios posteriores generan una
**fila de catch-up en el primer período abierto** con referencia al origen y motivo; la reapertura queda auditada y regenera
asientos.

## Resumen

| Tema | Recomendación | Impacto en modelo (sin eliminar campos) |
|---|---|---|
| Cronograma de facturación | Plan por ítem `standard`/`custom`; Reestructurar edita el plan | `contract_item_billing_plan` (+ cuotas); `contract_invoices` = registro de lo firmado (S4-4) |
| Trazabilidad | Glosa libre, `contract_item_id` obligatorio salvo `adhoc`; desvío como aviso | flag `adhoc` + evento de desvío |
| Separación | El devengo nunca lee el cronograma de facturación | RSM desde `contract_items` + `recognition_methods` |
| Deferred / unbilled | Por ítem, neto por contrato, invariante triple, reclasificación con reverso | reutiliza columnas EOM; vista neta; flag `unbalanced` |
| Roll-forward / waterfall | Por emisora/contrato/ítem con drill-down; facturado + contratado | reportes sobre el RSM |
| Variables | `as_billed`; consumo no facturado al cierre → unbilled | método en `recognition_methods` |
| Evergreen | Ventana móvil con filas `projected` | `row_kind` en el RSM + proceso mensual |
| FX en reportes | Tasa real, tasa constante, efecto FX; conversión = CTA | reutiliza `_system_ccy` (+ constante calculada) |
| Diferencias de cambio | Realizada / no realizada / UF separadas; deferred sin re-medir | `fx_rate_source` por fila; **conciliar con S1-17** |
| Intercompañía | Devengo en la emisora que factura; cargo IC sugerido; eliminación | `contracting_company_id` vs `billing_company_id`; asientos IC |
| Asientos | `journal_entries` desde el delta del RSM; mapeo por emisora × tipo | tabla de mapeo (M11) + `journal_entries` |
| Cierre | Lo cerrado no se reescribe; catch-up en el primer abierto; reapertura auditada | `accounting_period_*` como API; filas de ajuste con `adjusts_period` |
