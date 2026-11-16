# Code review del 28-10 (puntos 1 y 3), prorrateo visible y renegociación (Domi 02-11)

Primer lote aprobado por Domi el 02-11 (puntos 0, 1, 3, 4 y 5 de la lista; el 2 se resuelve con datos, y 6, 7 y 8 vienen después).

## 1 · La alerta agrupada ya no se cierra entera (`notifications.service.ts`)

`createOrUpdate` no reescribía `resource_id`/`resource_type` al actualizar una alerta abierta. Un aviso de envío al ERP que crecía de 1 a
N facturas conservaba el `resource_id` de la primera; cuando esa se enviaba bien, `detachInvoiceFromOdooFailureAlerts` → `resolveOpen({ type,
resourceId })` resolvía el aviso entero aunque las otras N−1 siguieran fallando. Ahora el recurso sigue al productor: si el dto trae
`resource_type`, se escriben `resource_type` y `resource_id ?? null`; sin `resource_type` en el dto (otros productores) no se toca. Test en
`notifications.service.spec.ts`.

## 3 · Glosa: el mes en palabras solo para un mes completo; el tramo prorrateado con su período real

- `formatPeriod` (`invoice-description.ts`): `month_year` y `mmm_yy` nombran el mes solo cuando la línea cubre el mes calendario completo
  ("noviembre 2026"); un tramo parcial (1–7 nov), un ciclo que cruza meses (21-10 → 20-11) o varios meses van con fechas
  ("01/11/2026 a 07/11/2026"). Antes "noviembre 2026" para un tramo de 7 días y "octubre a noviembre 2026" para el ciclo del 21 (Domi:
  ninguno dice qué días cubre). `isWholeCalendarMonth` nuevo. Afecta solo glosas que se generan desde ahora.
- Tramo actual del downsell prorrateado (`planItemChange`): deja de llevar el sufijo "(hasta 2026-11-07: 7/30 días)" sobre la glosa vieja y
  recibe una glosa completa con su período real, renderizada con la plantilla del contrato (`lineGlosa` → `fitDescription`), igual que el
  tramo nuevo. `update_line` acepta `description` (reemplaza la glosa salvo `description_locked`); `ChangeLineAmounts.description`.

## 4 · La cuenta del prorrateo en la vista previa (`proration` en las líneas del detalle)

`ChangeInvoiceDetailLine.proration = { days, cycle_days, monthly_unit_price } | null` en las líneas que cambian o se agregan y cubren un
tramo parcial dentro de un ciclo (`Planner.prorationOf`: `monthsBetween` del tramo con el ancla del ítem; `unit_price = monthly_unit_price
/ cycle_days × days`, 38,499999 se lee 38,50). El front (`FacturasAfectadas`) muestra debajo de "Cantidad × unitario": "USD 47,96 / 30 días
× 23 días = USD 36,77" (Carelis, S06879) y "USD 38,50 / 30 días × 7 días = USD 8,98". Centro de ayuda: Contratos › Modificar un contrato ›
"Cómo se calcula un unitario prorrateado o no mensual" (con el ejemplo semestral de Refaccionaria Moderna: 28 × 5.700 = 6 × 26.600, se
conserva la cantidad y el ajuste va en el unitario).

## 5 · Renegociación (front)

La API ya lo guardaba (subtipo `RENEGOTIATION` cuando cambian cantidad y unitario; categoría por el MRR nuevo contra el anterior). Front:
tarjeta "Cambió el precio y/o la cantidad de un producto" con el chip Renegociación junto a Upsell y Downsell; "Solo el cambio (+ o −)"
gana la opción **Cantidad y precio** con los dos deltas (`extra_by: 'both'`, `extra_price`); la frase del formulario, cuando cambian los
dos ejes, dice "Renegociación: 30 × USD 38,50 → 5 × USD 47,96 c/u · MRR −USD 915,20 · downsell" en vez de la aritmética del ajuste
interno ("Baja 25 a USD 36,61 c/u"). Tests en `cambios.test.ts` y `ModificarContratoDrawer.test.tsx`.

## 0 · Correos de QA (sin cambio de código)

Verificado en prod: las preferencias de Domi se respetan (ninguna alerta por correo desde el 14-10; el resumen semanal llega solo de los
dos holdings donde no guardó la preferencia). Los correos "de más" los manda el **cron de QA**, que tiene espejo de los holdings con los
mismos ids y envía resúmenes reales a los correos de `INVITE_TEST_ALLOWLIST`; como comparte cuenta y clave de envío con prod, el envío de
prod un minuto después falla por clave repetida ("idempotency key used with a different body": uPlanner todas las semanas). Acción: poner
`NOTIFICATION_EMAILS_ENABLED=false` en el entorno de la API de QA (fuera del repo).

## 2 · Mensual del DOWNSELL en filas legadas (se resuelve con datos, no con lógica)

Prod (solo lectura, 02-11): 33 ajustes DOWNSELL, ninguno con el signo de `quantity × unit_price` distinto al del valor; 6 del sistema viejo
con `quantity × unit_price ≠ monthly_price` (CTR-2026-007 CRM Lite, S07608, S06975, S01688, S06426, CTR-2025-001). Riesgo: solo si la API
vuelve a escribir las columnas de precio de esas 6 (una corrección), su mensual cambiaría al producto. Propuesta de Domi: corregir el dato
(`unit_price = monthly_price / quantity` en esas 6 filas, con respaldo) en vez de agregar lógica para datos del sistema anterior.

## Impacto

- `createOrUpdate`: solo cambia qué columnas escribe cuando el dto trae `resource_type`; Kame, Salesforce, FX y pactos no lo traen o lo
  traen igual que antes. `formatPeriod`: glosas nuevas; las guardadas no se tocan. `update_line.description`: solo lo usa el tramo
  prorrateado. `proration`: campo opcional nuevo en la vista previa. Front: renegociación y prorrateo son textos y un modo de ingreso más.
- Registros: ninguno migrado. Tests: API `contract-changes.spec` (+ glosa y `proration`), `invoice-description.spec`,
  `notifications.service.spec`; suites de contratos y notificaciones 1354 en verde. Front: 1012 tests de Contratos en verde.

## Pendiente del review (sin corrección al 13-11)

Estado en [`ROADMAP-OPERATIVO.md`](../ROADMAP-OPERATIVO.md) → "Pendientes del sistema nuevo" (C3 a CX). La parte E del envío automático
y A10166 están en [`errores-emision-erp-28-10.md`](./errores-emision-erp-28-10.md) → "E · Pendiente".

- **C3** · `odoo-failure-alert.ts`: la clave de agrupación lleva el hash del mensaje; en `unknown`/`validation` el texto crudo puede
  traer datos de la factura y cada una sale como alerta aparte. Falta agrupar por causa.
- **C4** · `revertIfNotPosted` no deshace `issue_date` ni los montos que pudo escribir un aviso falso de "emitida". Verificar qué
  `invoice_date` manda `mapInvoiceToOdooFormat`.
- **C5** · Upsell sobre períodos prepagados ya emitidos (anual o trimestral): facturas de diferencia con fecha pasada o tramo que supera
  el fin del ítem. Sin bug confirmado: falta el test.
- **C6** · Downsell prorrateado (`contract-changes.ts`): el tramo actual = Σ líneas del grupo × ratio asume que todas cubren el período
  completo; un tramo previo (upsell a mitad del mismo mes) se prorratea mal y se borra. Calcular por línea con su solape de días.
- **C7** · `coveringPendingLine` toma solo la primera Por Emitir que cubre la fecha: con el período partido en dos facturas, la segunda
  queda entera.
- **C9** · `BILLED_STATUSES` duplicado en el scheduler, el webhook e `ISSUED_STATUSES`. Unificar.
- **CX** · Anotado el 02-11: la edición masiva (`planBulkHeader`) no ofrece documento tributario; `invoice-dte.ts` trata como exportación
  una factura nacional de un contrato 110 (Chile).

### C8 · Cambiar el modelo de precio desde el primer período (análisis del 28-10, sin OK)

Caso: CTR-2026-413 (Arca EC), contrato recién creado, PATHFINDER+ 332 × 9,06 mes vencido 01-01 → 31-12-2026, 12 Por Emitir sin emitir;
pasar a "por consumo" desde enero. La vista previa con fecha efectiva 01-01 avisa `price_model_from_next_period` (01-02), enero queda
fijo y el plan quita y recrea líneas de todo el plazo. Producción ya corregida por datos: no reparar.

- **Causa.** `nextPeriodStart` (`billing-engine.ts`) exige `period.period_start > item.start_date` y excluye siempre el primer período.
  Lo usan `planPriceModelChange`, `planItemChange` (DOWNSELL y precio), `planReterm` (ahí debe seguir excluyendo: un cambio de plazo en
  el inicio es una corrección) y `scheduled-changes.ts` (pactos, que ya cubren `item.start_date >= date`).
- **Segundo problema.** `mergeTarget` solo funde en Por Emitir con `issue_date >= hoy`: en un contrato con vigencia retroactiva las
  Por Emitir pasadas quedan sin destino, se quitan sus líneas y se crean facturas nuevas.
- **Esperado (Domi).** (1) Fecha efectiva = inicio de un período del ítem, incluido el primero, sin emitidas desde ahí → rige desde
  ahí; el bloqueo `issued_after_effective_date` ya protege lo emitido. (2) A mitad de período se mantiene el corrimiento. (3) Con
  `cut === item.start_date` no se crea ítem ni tramo vacío ni se rearman facturas: se recalculan las Por Emitir existentes.
- **Propuesta.** `nextPeriodStart(…, { includeFirst: true })` en `planPriceModelChange` y `planItemChange`; `planReterm` y pactos sin
  cambio. En `planPriceModelChange`, si `cut === item.start_date`: variante en el lugar (`update_item` del ítem original con el modelo
  nuevo, precio nuevo como versión siguiente, sin RENEWAL ni `renewed_by_item_id`, conservando el id) y recálculo de las Por Emitir por
  período con `pricedItemInvoicesByPeriod` + `mergePricedLines`; el generador solo para períodos sin factura.
- **Tests pedidos.** Fijo → por consumo con fecha efectiva = inicio y nada emitido (sin facturas de más); igual con la primera emitida
  (bloqueo); mitad de período (corre); mes vencido y anticipado; día de ciclo distinto del inicio; downsell según lo que se decida.
