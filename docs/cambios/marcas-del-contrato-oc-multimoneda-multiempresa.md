# Cambio: las marcas del contrato (Requiere OC/HES, Multimoneda, Multiempresa) se prenden y apagan en cualquier momento

> **Rama:** `domi` · Domi 26-10-2026 · caso Carelis, CTR-2026-206 NUR SRL (no pudo quitar "Requiere OC/HES" de un contrato vigente; se ajustó por BD).
> Par en `front-sapira` (interruptores en Modificar facturación › Condiciones, acción masiva y check de la factura). Sin migraciones ni cambios de datos.

## Qué pasaba

- `billing_conditions` ya aceptaba `requires_references_for_billing`, pero el front no lo mandaba y la API solo lo propagaba a las Por Emitir con
  fecha de emisión desde la fecha efectiva (las atrasadas seguían exigiendo OC).
- La marca por factura (`invoices.requires_references_for_billing`) no libera nada si el contrato exige: el envío y el scheduler usan contrato
  **o** factura. En producción, 90 Por Emitir con la del contrato encendida y la de la factura apagada (88 sin referencia).
- Multimoneda tenía su cambio `multicurrency` en los dos sentidos, pero el front solo ofrecía encenderla. Multiempresa
  (`requires_multicompany_billing`) es informativa (lista, filtro, chip del 360) y no tenía cómo editarse.

## Qué cambia (API)

1. **`billing_conditions`** (`contract-changes.ts`, `planBillingConditions`):
   - `requires_references_for_billing` se escribe en el contrato y en **todas** las Por Emitir vivas (`isEditablePending`, sin mirar
     `issue_date`); el preview las lista ("exige OC/HES" / "deja de exigir OC/HES") y, al encenderla, avisa `pending_invoices_without_reference`
     con las que no tienen referencia (`references_count` nuevo en `ChangeInvoiceRow`: propias + vinculadas del contrato).
   - `requires_multicompany_billing`: solo contrato y evento (`track`).
   - `requires_multicurrency_billing`: misma regla que `planMulticurrency` (apagar con ítems en otra moneda → bloqueo
     `foreign_currency_items_present`); enciende/apaga con la op `set_multicurrency` y queda en `fields_before/after` del evento
     `CONDITIONS_UPDATED`. Un apagado bloqueado cuenta como diferencia (no cae en "sin diferencias").
   - `auto_invoice` sigue propagándose solo desde la fecha efectiva (sin cambios).
2. **Acción masiva** (`PATCH /contracts/bulk-settings`, `contract-bulk.service.ts`): acepta las tres marcas además de las automatizaciones.
   Por contrato: `changed`, o `blocked` con motivo (apagar Multimoneda con ítems en otra moneda; la acción sigue con los demás). Requiere OC/HES
   se escribe también en las Por Emitir vivas del contrato (`PENDING_INVOICES_FOR_FLAGS_SQL`, `pending_invoices_updated` en resultado y
   evento). Respuesta: `{ bulk_id, updated, unchanged, blocked, results[{ id, contract_number, changed, blocked?, pending_invoices_updated? }] }`.
   Título del evento `SETTINGS_CHANGED` por marca ("Requiere OC/HES desactivado", "Multimoneda activada", "Multiempresa activada").
   Las marcas no disparan el trigger de moneda: con ítems en otra moneda se cambian igual (solo las automatizaciones siguen con el 400).
3. **Detalles**: `GET /contracts/:id` expone `requires_references_for_billing`; `GET …/invoices/:invoiceId` expone
   `contract_requires_references_for_billing` para que el front bloquee el check de la factura cuando el contrato la exige.
4. **Lista**: `GET /contracts` acepta el filtro `requiresReferences=true|false` (junto a `multicompany` y `multicurrency`) y cada fila trae
   `requires_references_for_billing`, con lo que el diálogo de la acción masiva muestra el estado actual y ofrece la acción contraria.

Regla documentada (decisión Domi 26-10): la OC se exige si lo pide **el contrato o la factura**. Con la marca del contrato encendida, el check
de la factura queda bloqueado ("Lo exige el contrato: cámbialo en Modificar facturación"); sin ella, el check pide la referencia solo en esa
factura. No se adoptó "la factura manda": habría liberado en silencio 88 facturas sin referencia hoy bloqueadas.

## Specs

`contract-changes.spec.ts` (OC a todas las PE con aviso, apagar libera sin aviso, Multiempresa, Multimoneda encender/bloquear),
`contract-bulk.service.spec.ts` (OC con conteo de PE, Multimoneda bloqueada en el resumen, Multiempresa con ítems en otra moneda, títulos),
`contract-invoices.spec.ts` (PE sin referencia se envía con las dos marcas apagadas; bloquea con cualquiera encendida).
`item-end-correction.spec.ts`: se alineó con la regla del 22-10 (inicio y fin del mismo ítem juntos ya no es 400); fallaba desde ese cambio.

## Impacto

- 168 contratos activos con Requiere OC/HES y 594 Por Emitir con la marca en producción; ninguna escritura directa, nada se migra.
  Multiempresa pasa de fija a editable sin efecto en facturación (1 contrato en prod, holding demo).
- Avisar a Leon: el masivo escribe `invoices.requires_references_for_billing` (no viaja al ERP).
