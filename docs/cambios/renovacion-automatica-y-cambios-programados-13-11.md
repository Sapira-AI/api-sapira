# Renovación automática y cambios programados que se aplican solos (SimpliRoute, 13-11)

Pedido de Carelis (SimpliRoute, 27-10): un ajuste de precio masivo desde diciembre y renovar en bloque los contratos que vencen en
diciembre y enero. Decisiones de Domi del 13-11. Reemplaza el modo "confirmar" de `spec-renovacion-y-ajustes-pactados.md` §5.

## Decisiones

| Tema | Decisión |
|---|---|
| Renovación automática | Se aplica sola **30 días antes del fin** (`holding_settings.auto_renewal_notice_days`), sin confirmar |
| Cambios programados | Se aplican solos en la renovación o cuando entran al mismo plazo de 30 días |
| "Desde el mes" | Cada ítem toma el cambio desde su primer período de ese mes, sin prorrateo |
| Lo ya facturado | No se ajusta: si ese mes ya está emitido, el cambio rige desde el día siguiente al último período emitido |
| Modelos de precio | Un reajuste de alcance contrato no toca ítems con modelo de precio (tramos, consumo) |
| Ajuste en la renovación | Se guarda como ítem de ajuste aparte (RENEWAL al valor vigente + UPSELL/DOWNSELL); en pantalla se muestra como uno |
| Plazo de la renovación | `auto_renew_term_months` del ítem; sin él, **12 meses** (no el plazo original del ítem) |
| Nombre | "Programar un cambio" / "Cambio programado" (antes "Acordamos un cambio futuro" / "cambio pactado") |

Los nombres internos no cambian: tabla `contract_scheduled_changes`, `pact*` en el código, rutas `scheduled-changes`.

## Qué cambió

### Jobs (`contract-renewals.service.ts`)

- `contracts-auto-renewal` (06:00): por contrato con ítems `auto_renew` que terminan dentro del plazo, aplica el mismo cambio `renewal` que
  confirma una persona, con el actor sistema (`SYSTEM_ACTOR_ID`) y clave de idempotencia `auto-renewal:<fin>:<ítems>`.
  - Propuesta abierta → la confirma (`origin: renewal_proposal`) y cierra su notificación. Propuesta omitida → no renueva.
  - Bloqueada por el motor → queda la propuesta `RENEWAL_PROPOSED` con el motivo (`metadata.auto_renewal_blocked`), avisa una vez y
    reintenta cada día.
  - **Ya vencido** → no renueva (facturaría hacia atrás): queda como propuesta. El filtro ahora incluye contratos `expired`, que antes
    nunca recibían propuesta.
- `contracts-scheduled-changes` (05:30): aplica cada cambio en fecha dentro del plazo con `ContractScheduledChangesService.apply` y el
  actor sistema. Si no se puede (índice sin dato, período cerrado), deja el evento `SCHEDULED_CHANGE_DUE` con el motivo
  (`metadata.auto_apply_blocked`) una vez y reintenta cada día.
- Actor sistema: `ContractChangesService.apply` lo acepta sin usuario; las columnas con FK a `users` (`prices.created_by`,
  `invoice_adjustments.adjusted_by`) van en null.

### Motor (`scheduled-changes.ts`, `contract-changes.ts`)

- Fecha por ítem (`PlanOptions.item_effective_dates`): antes todos los ítems partían en la fecha del más temprano y los de otro ciclo
  quedaban prorrateados.
- Lo emitido no se ajusta: `pactApplication` corre la fecha del ítem al día siguiente de su último período emitido.
- Ítem ya renovado que sigue vigente (`PlanOptions.renewed_item_ids`): un cambio programado agregado después de la renovación aplica a lo
  que le queda al ítem y a su renovación. Lo mismo para un cambio manual de precio o cantidad (`item_change`), con el aviso
  `renewed_item_change`; antes se bloqueaba con `item_already_renewed`. Un ítem renovado que ya terminó sigue bloqueado.
- Alcance contrato con reajuste de precio: se excluyen los ítems con modelo de precio (`hasPriceModel`).

### Endpoints nuevos

| Endpoint | Qué hace |
|---|---|
| `POST /contracts/:id/scheduled-changes/preview` | Simula un cambio programado antes de guardarlo (mismo cuerpo que crear). Devuelve el `ChangePreview` leído "cómo quedará" (`readablePactPreview`) |
| `POST /contracts/bulk-scheduled-changes/preview` y `…/bulk-scheduled-changes` | `{ ids, change, product_ids? }`: el mismo cambio en varios contratos. Sin `product_ids`, alcance contrato; con ellos, un cambio de alcance ítem por cada ítem vigente de esos productos (la fila trae `products`; el contrato sin esos productos se omite). Fila por contrato; al guardar, una transacción por cambio |
| `POST /contracts/bulk-auto-renew/preview` y `…/bulk-auto-renew` | `{ ids, auto_renew }`: estado actual por contrato (`current: on \| partial \| off`) y cambio `billing_conditions` por contrato |
| `GET /contracts?autoRenew=true\|false` | Filtro de la lista: algún ítem recurrente vigente con renovación automática, o ninguno |
| `GET /contracts?itemType=a,b` | Filtro de la lista: algún ítem del contrato es de esos tipos (`contract_items.item_type`). `GET /contracts/filter-options` agrega `item_types` (los que usan los contratos del holding) |

`GET /contracts/:id/overview` agrega `lifecycle.milestones[]` (`buildMilestones`): renovaciones, ampliaciones, reducciones, productos
agregados y cambios programados, compactados cuando hay varios seguidos del mismo tipo.

Sin cambios de esquema.

## Análisis de impacto

1. **Quién más lo usa.**
   - `planItemChange`: lo usan "Cambiar precio o cantidad", "Cambiar frecuencia o plazo" y aplicar un cambio programado. Sin
     `item_effective_dates` el comportamiento es el de antes; el único cambio para pedidos manuales es el ítem ya renovado y vigente.
   - `planRenewal`: no cambia. El job le pasa `term_months` explícito.
   - `proposeRenewalsForHolding` / `flagDueForHolding`: solo los llama `ContractsScheduler`.
   - `ContractChangesService.apply`: todos los cambios del 360; el actor sistema es un camino nuevo que solo usan los jobs.
2. **Cuántos registros reales toca** (producción, solo lectura, 13-11). Aplica a **todos los holdings**.
   - Primer día de los jobs (ítems que terminan hasta el 13-12): SimpliRoute 4 contratos (30 facturas por emitir nuevas) y otro holding
     1 contrato (1 factura). Los demás, ninguno.
   - SimpliRoute hasta el 31-01-2027: 209 contratos con renovación automática, los 209 se renuevan sin bloqueos (285 ítems, 2.441 facturas
     por emitir). 22 tienen tipo de cambio fijo sin tasa para el plazo nuevo (la tasa se pide antes de emitir, como hoy). 21 ítems sin
     `auto_renew_term_months` toman 12 meses.
   - Cambios programados vigentes: 2 en toda la base al 13-11. El de SimpliRoute (S07212, cantidad nueva desde el 01-12) se canceló el 13-11 por pedido de Domi (creado por error); antes **se aplicaría en la
     primera corrida**; el del otro holding es de renovación.
   - No se migran datos.
3. **Qué lo verifica.** `contract-renewal-auto.spec.ts` (renovación en un ítem, fecha por ítem, lo emitido, ítem ya renovado),
   `contract-renewals.service.spec.ts` (jobs), `contract-scheduled-changes.service.spec.ts` (vista previa), `contract-bulk-changes.service.spec.ts`,
   `contract-360.spec.ts` (hitos). Simulaciones sobre producción en solo lectura: `scripts/simular-renovacion-automatica.ts` y
   `scripts/simular-ajuste-precio-lote.ts`.
4. **Qué doc cambia.** Centro de ayuda (`contratos/renovar-y-programar-cambios.md`, `contratos/lista-de-contratos.md`, novedad del 13-11)
   y este documento. La spec `spec-renovacion-y-ajustes-pactados.md` §5 queda superada por lo de arriba.

## Pedidos de las usuarias (reunión del 13-11)

- **Filtro por tipo de ítem** en la lista (`itemType`). Producción, solo lectura: SimpliRoute usa 3 tipos (Digital, Fijo, Variable) en 1.141 ítems, ninguno sin tipo;
  los demás holdings entre 1 y 9 tipos. Solo lee; no cambia datos.
- **Programar cambio en lote por producto** (`product_ids`): sin esquema nuevo, reutiliza el alcance ítem que ya existía (`contract_item_id`).
  Los contratos de la selección sin esos productos se omiten con su motivo.
- **Resumen diario de renovaciones automáticas**: una notificación por holding y día (`contracts:auto-renewals:<fecha>`, tipo
  `contract_renewal_proposed`, sin recurso ni acción) con el total y el conteo por compañía (`autoRenewalSummary`). El tipo pasa a llamarse
  "Renovaciones de contratos" en preferencias y roles; sus suscriptores son los mismos (Administrador y Finanzas), sin semilla nueva.
- **Revertir un cambio programado ya aplicado** (incluso facturado): construido con OK de Domi, ver la sección siguiente.

## Revertir un cambio programado aplicado

`POST /contracts/:id/scheduled-changes/:changeId/revert/preview` y `…/revert` (`{ reason }`). El servicio lee el evento que aplicó el cambio
(`applied_event_id` → `metadata.created_items`) y llama al motor con el cambio `scheduled_change_revert` y `PlanOptions.revert`
(`planScheduledChangeRevert`). El tipo existe en `CHANGE_TYPES`, pero por `POST …/changes` se bloquea (`revert_from_scheduled_change`).

| Qué | Cómo |
|---|---|
| Ítem de ajuste (UPSELL / DOWNSELL colgado de su ítem) | Se borra (`delete_reverted_item`, después de la NC). `invoice_items.contract_item_id` es `ON DELETE SET NULL`: las líneas de facturas canceladas quedan sin ítem |
| Por Emitir | Ajuste con línea propia: se quita esa línea. Reducción (línea neta): se quitan las líneas del grupo desde el inicio del ajuste y el generador las rehace al valor anterior, en la misma factura |
| Emitidas que lo incluyen | NC espejo de todas las líneas → emitida y NC Canceladas (regla del 12-10). El generador crea la Por Emitir del mismo período sin el ajuste; emisión = la del período, u hoy si ya pasó |
| Cambio programado | `cancelled` con `status_reason = 'Revertido: <motivo>'` (no hay estado nuevo: sin cambio de esquema) |
| Evento | `SCHEDULED_CHANGE_REVERTED`; el evento que lo aplicó recibe `metadata.reversed_by` y deja de ser un hito de la línea de tiempo |
| MRR / RSM | `amount_delta` = el ajuste con signo contrario; el RSM se reconstruye desde el mes del ajuste |

Bloqueos (409 `blocked` con la vista previa): `period_closed`, `invoice_paid`, `invoice_electronic` (`invoices.dte_id`),
`invoice_partially_credited`, `invoice_with_consumption`, `adjustment_closed` (ajuste ya renovado o con baja), `revert_needs_manual`
(grupo con otra reducción o con modelo de precio), `revert_not_supported` (plazo / frecuencia), `nothing_to_revert`,
`scheduled_change_not_applied`. Una factura unificada sigue las reglas de siempre (`assertNoUnified`). Una renovación aplicada con el cambio
no se deshace: solo se quita su ajuste. Si un mismo evento aplicó varios cambios, se quitan todos los ajustes de ese evento.

**Impacto.** (1) *Quién más lo usa:* el motor es compartido, pero el camino nuevo solo se alcanza con `options.revert`; `loadContext` agrega
`electronic` a cada factura (solo lectura) y `delete_reverted_item` reutiliza el SQL de `delete_item`. Los hitos del 360 ahora omiten los
eventos con `reversed_by` (también una baja reactivada). (2) *Registros reales:* en producción hay 0 cambios programados aplicados al 13-11
(2 programados), así que nada existente se puede revertir todavía; rige para los que se apliquen desde el despliegue. No se migran datos.
(3) *Qué lo verifica:* `contract-scheduled-change-revert.spec.ts` (sin facturar, ya facturado, bloqueos, reducción; el estado aplicado
sale del plan real de aplicar el cambio), `contract-scheduled-changes.service.spec.ts` (servicio y rutas). Falta la prueba de punta a punta
contra una base. (4) *Doc:* ayuda `contratos/renovar-y-programar-cambios.md` y la novedad del 13-11.

## Pendiente

- Revertir: probar de punta a punta en QA (aplicar un cambio, emitir la factura, revertir) antes de producción; no se probó contra una base.
- Dar de baja un ítem ya renovado durante sus últimos 30 días sigue bloqueado: hay que decidir si la baja deshace la renovación.
- Las renovaciones automáticas exitosas no notifican una por una (quedan en el Historial); falta decidir si se quiere un resumen diario.
- Reajuste de ítems con modelo de precio (ajustar los tramos de la tarifa): fuera de alcance.
- Prueba de punta a punta de los jobs contra una base (dev o QA): hasta ahora se verificó con tests y con simulaciones de solo lectura.
