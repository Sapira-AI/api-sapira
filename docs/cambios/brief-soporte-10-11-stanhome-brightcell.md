# Brief de soporte 10-11 (Domi): Stanhome CTR-2026-884106 y Brightcell CTR-2026-110 / CTR-2026-109-EntelExp

Texto de Domi tal cual, guardado para no perder el contexto entre sesiones. Plan y orden acordados en `traspaso-28-10.md` (memoria).

## Stanhome (soporte 09-11, holding 5652e95e-bb99-48f5-aa1c-13c8c2638fc6)

La usuaria necesitaba pasar un contrato de cobro Anticipado a Vencido (cada mes se factura el día 1 del mes siguiente). Se resolvió con datos
(ítem 344a6272 billing_method = 'Vencido' y rescheduleBulk shift_months = 1 de las Por Emitir dic-26 → ago-27). Dos gaps:

1. No hay forma de cambiar el modo de cobro (Anticipado ↔ Vencido) de un ítem con precio fijo. "Vencido" solo se elige en "Cambió el modelo
   de precio" (IntencionForms.tsx ~1075); si el modelo no cambia la API rechaza (contract-changes.ts ~4905 `same_model` compara solo el
   PriceSpec). Esperado: cambiar solo el modo de cobro, con vista previa y evento. Reglas: a) Anticipado → Vencido: el período ya facturado
   no se repite, las siguientes salen el día siguiente al fin de su período; b) Vencido → Anticipado: mes de transición con dos facturas,
   avisado; c) Por Emitir con borrador en el ERP se bloquean o avisan; d) encabezado "Mensual anticipada/vencida" y ayuda consistentes.
   Tests por dirección, con período en curso emitido y sin emitir.
2. "Anular y reemplazar" deja la reemisión con emisión hoy y emisión automática encendida (A10198 → A10216 emitida el mismo día, cancelada
   en el SAT). Opciones: (a) reemisión nace apagada; (b) la vista previa avisa "sale hoy de forma automática" y deja elegir la fecha
   (`reissue_changes.issue_date` ya existe en la API). Verificar que `credit_note_to_erp` sea claro en México (se cancela sin NC).

## Brightcell (soporte 10-11)

Principio rector: una factura de origen dentro de una unificada vigente no es un documento propio; se ve, edita y envía a través de su
unificada, y lo que la usuaria hizo sobre la unificada (OC, fecha, glosas, tasa) no se pierde cuando el sistema la rehace.

1. Pestaña Facturas: una fila por unificada vigente con orígenes desplegables; sin filas sueltas de orígenes; canceladas por rehacer solo en
   Anuladas como "Unificación deshecha"; contadores y paginación igual; revisar Facturación y 360 de cliente y razón social.
2. Montos del contrato sin mezclar monedas ni contar dos veces (Estado de cobro: "Pagado USD 13.124.996,84" son CLP; aviso "suman USD
   43.284 y el valor total es USD 48.494"). Regla: moneda en que se cobra o convertir con la tasa de cada factura; unificada o sus orígenes,
   nunca ambas; en multicontrato cada contrato suma solo sus líneas.
3. Proforma y detalle de una unificada con líneas en otra moneda (`_lib/proforma.ts` usa `detail.contract_currency`): en spot muestra
   1.800 / 800 / 27 / 1 como "CLP", suma USD + UF, sin nota referencial. Corrección: valorizar referencialmente con la tasa del día por par
   (misma fuente que `calculatePairAmountsAtIssue`) con la nota "Montos referenciales…", o cada línea en su moneda con subtotales; con tasa
   fijada, usarla. Revisar detalle y totales de la pestaña. Test: unificada spot USD + CLF en CLP (848e8889 de CTR-2026-110).
4. Tipo de cambio en unificadas: a) unificar pierde la tasa por línea (`fx_rate_source`/tasa/fecha) → con política fija no se puede enviar
   (6b72c2b0, 848e8889); copiar por línea. b) cambiar tasas/política del contrato no recalcula los orígenes dentro de una unificada
   (`planBillingConditions` + `isEditablePending`); caso 22-10 (984,82 vs 929,18); incluir orígenes de unificadas Por Emitir sin borrador y
   re-unificar en la misma transacción, o al menos avisar. c) "Tipo de cambio de la factura" sobre una unificada se bloquea: ofrecer
   aplicarlo a los orígenes y re-unificar; para OC debe poder fijarse en la unificada. d) vista previa de unificación avisa si los orígenes
   mezclan spot y fija o tasas distintas del mismo par. Invariante: en una unificada Por Emitir todas las líneas del mismo par tienen la
   misma tasa o todas van al día; con política fija ninguna queda sin tasa salvo spot.
5. Cambios de contrato sobre unificadas Por Emitir (`assertNoUnified`, 5 planners): sin borrador en el ERP preguntar "¿Agregar este cambio
   a la factura unificada?" y aplicar en orígenes + `reunifyInvoices` en la misma transacción (contrato principal de la regla); con
   borrador bloquear con paso siguiente; emitida, camino de NC. `item_add` hoy no se bloquea (crea sueltas que la regla absorbe a las
   06:30): unificar con el nuevo comportamiento. Tests: upsell, downsell, renegociación, quitar, cambio de modelo × (Por Emitir, borrador,
   emitida) × (con regla, sin regla).
6. Desde una cotización: ofrecer "Agregar como ítem nuevo (otra cuenta)" por línea que calza con un producto existente (`item_add` con
   `account` y `quote_item_id`; el resto `item_change`); revisar si la API acepta ambos tipos en un pedido; cotización queda procesada;
   texto breve.
7. Vista previa de la regla marca "Bloqueado" lo que sí se rehace (`monthView` con `action === 'reunify'` llama a `preview` con orígenes
   inactivos → `not_pending`/`already_consolidated`; `save`/`runRule` sí rehacen). Simular el deshacer y mostrar "Se vuelve a unificar".
8. Rehacer una unificada no debe perder lo de la usuaria: pausar con `undo_pending` + guardar (`applyInvoices`, no `reunifyInvoices`)
   perdió la OC POZN025647, la emisión reprogramada al 10-11 y el día de emisión (`emissionDayOf` toma la próxima Por Emitir de cualquier
   ítem: pasó del 12 al 1). "Corregir un dato" no actualiza glosas en unificadas (`skipped_reason: unified_invoice`) ni en orígenes.
   Conservar referencias, fecha, glosas y tasa por cualquier camino; día de emisión el de la regla (o el de la anterior); Descripciones y
   Corregir un dato actualizan orígenes y su unificada Por Emitir.
9. La tasa fijada por factura (OC) debe sobrevivir a consumos y ediciones: el consumo reescribe `fx_rate_source = 'consumption'`
   (`consumption.service.ts` ~2305) y se pierde la marca "fijada": `explicitlyFixed` queda false (contrato spot → revaloriza al día) y
   `keepsRateAtIssue` no incluye `consumption`. Corrección: conservar el origen fijado al recalcular (o marca a nivel de cabecera); revisar
   editor, reorganización y líneas de cambios de contrato. Tests: spot con tasa manual + consumo/upsell en simple, multimoneda y unificada;
   repetir con política fija.

Al terminar: tests de regresión por punto con Brightcell como fixtures; docs (manual de modificaciones y glosario en docs/v2-rediseno;
centro de ayuda: unificada, modificar contrato, tipo de cambio por factura y por OC); invariantes de 2, 4 y 9 en
`docs/agentes/conocimiento-soporte-contratos-facturacion.md`. Resumen antes de commitear.
