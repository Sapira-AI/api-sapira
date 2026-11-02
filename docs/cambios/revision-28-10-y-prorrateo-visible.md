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
