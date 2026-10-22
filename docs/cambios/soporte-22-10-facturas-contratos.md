# Cambio: arreglos de soporte del 22-10 en facturas y contratos

> **Rama:** `domi` · Domi 22-10-2026 · par en `front-sapira` (mismo día)
> Origen: gaps vistos en soporte tras el switch (SimpliRoute, COPEC/Carelis, CGE). Sin migraciones ni cambios de datos.

## 1. Aviso "el monto total no coincide con la suma de sus líneas" (`contracts.service.ts`)

- **Antes:** la revisión `header_vs_lines` comparaba `COALESCE(amount_contract_currency, 0)` contra la suma de líneas, así que una
  factura **Unificada/Consolidada spot con líneas en más de una moneda** (encabezado nulo hasta enviar, por spec) contaba como
  descuadre. Caso: unificada CTR-2026-90-LuvEnv + CTR-2026-6A4A47.
- **Después:** esas facturas (encabezado nulo y tipo Unificada/Consolidada) quedan fuera de la revisión. En producción eran 4 de
  24 "descuadres" en Por Emitir.
- **Front:** la lista de facturas muestra "Se calcula al enviar" en vez de "—" en ese caso.

## 2. Devengo al cambiar el estado de una factura desde el webhook del ERP (`odoo-webhook.service.ts`)

- **Antes:** el webhook actualizaba `invoices` (estado, folio, fecha, totales) y nada recalculaba `revenue_schedule_monthly`:
  los triggers de RSM son no-op cuando `sapira.writer = 'api'` (regla
  [lógica en la API, triggers solo invariantes](../reglas-desarrollo/logica-en-api-triggers.md)) y el refresco nocturno solo
  toca del mes en curso en adelante. Una factura de un mes pasado que pasaba de Por Emitir a Enviada/Emitida dejaba el
  devengo de ese mes desactualizado (CGE CTR-2026-96 y 53 contratos SR recalculados a mano el 22-10).
- **Después:** tras el `update`, `rebuildRevenueIfNeeded` llama `SELECT revenue_schedule_rebuild(contract_id, desde)` cuando el
  estado cruza entre Por Emitir y el conjunto facturado (Emitida, Enviada, Pagada, Vencida), cuando cambia el mes de
  `issue_date` o cuando cambia `total_invoice_currency`. `desde` es el mes más antiguo entre la fecha anterior y la nueva. Si el
  rebuild falla se registra el error y la actualización del webhook se conserva (el nocturno la alcanza).
- Enviada → Pagada no recalcula (el devengo no depende del cobro).
- Spec: `odoo-webhook.service.spec.ts` › "devengo (Domi 22-10)".

## 3. Etiqueta de tipo de cambio en facturas spot ya valorizadas (`contract-invoices.ts`)

- **Antes:** `derivedFxPolicy`/`effectiveFxPolicy` decían `fixed` en cuanto la factura tenía `fx_contract_to_invoice`, aunque la
  tasa la hubiera grabado el envío spot (`fx_rate_source = 'spot'`, `invoice-scheduler.service.ts`). El front mostraba "Fija".
- **Después:** con `fx_rate_source = 'spot'` la política sigue siendo `spot`; el front muestra "Spot · valorizada al enviar · par".
- Spec: `contract-invoices.spec.ts` › "derivedFxPolicy (Domi 22-10…)".

## 4. Reorganizar con tasa fija hereda la tasa (`invoice-reorganize.ts`)

- **Antes:** la factura nueva buscaba la tasa solo en los períodos fijos del contrato; si el período no tenía una, quedaba sin tasa
  (`fixed_fx_without_rate`) aunque la factura de origen sí la tuviera.
- **Después:** si no hay tasa de período, hereda la de la factura de origen de sus líneas (`original_invoice_key`).
- Spec: `invoice-reorganize.spec.ts` › "hereda la tasa fija de la factura de origen".

## 5. Corregir inicio y fin de un mismo ítem en un solo cambio (`contract-changes.ts`)

- **Antes:** la regla de combinación exigía corregir el fin solo; mover el inicio sin mover el fin acortaba el plazo del ítem.
- **Después:** una misma entrada puede traer `start_date` y `end_date` (mismo ítem): `startCorrectionSet` recibe el fin explícito,
  valida inicio ≤ fin y deja el recálculo de plazo y precio a `endCorrectionSet`, que corre con el inicio ya corregido. Siguen
  prohibidos: fin de más de un ítem, fin + cantidad/precio/descuento, y fin de un ítem con inicio de otro ("Corrige la fecha de fin
  de un ítem a la vez…"). La API **no** mueve el fin por su cuenta: el front propone en el formulario el fin que conserva el plazo
  y la usuaria lo acepta, cambia o borra (el caso CTR-2026-191 del 07-10, fin fijo y plazo recalculado, sigue igual).
- Spec: `contract-changes.spec.ts` › "inicio y fin juntos (Domi 22-10)".

## Impacto

- Solo lectura de datos existentes; ningún registro se migra. El rebuild del punto 2 escribe `revenue_schedule_monthly` del
  contrato afectado, igual que el nocturno.
- Avisar a Leon del punto 2 (webhook) antes de pasar a `qa`.
