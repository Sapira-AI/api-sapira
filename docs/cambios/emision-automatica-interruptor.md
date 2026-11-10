# Interruptor "Emisión automática": baja a las Por Emitir, la reemisión lo hereda del contrato y el envío manual avisa (Domi 02-11 / 10-11)

Reporte de soporte (SimpliRoute, Fernanda, CTR-2026-419, S07969, CTR-2026-227, CTR-2026-415): el interruptor de la pestaña Facturas y la
acción masiva de la lista escribían solo `contracts.auto_invoice`; el envío al ERP (job y "Enviar al ERP") lee `invoices.auto_invoice`
(`invoice-scheduler.service.ts`: `auto_post = invoice.auto_invoice ? 'at_date' : 'no'`). Apagarlo no frenaba lo Por Emitir, encenderlo no
lo emitía, y la reemisión copiaba el valor de la factura anulada.

## Qué cambia

1. **Ajustes masivos** (`contract-bulk.service.ts`, `PATCH /contracts/bulk-settings`): al cambiar `auto_invoice` (en los dos sentidos) se
   escribe el mismo valor en las Por Emitir vivas del contrato **sin `odoo_invoice_id`** (misma transacción; las que ya tienen borrador en
   el ERP viajaron con su `auto_post`). Cuentan en `pending_invoices_updated` (resumen y evento `SETTINGS_CHANGED`); una factura tocada por
   dos marcas en la misma acción cuenta una vez. Mismo criterio de "Por Emitir viva" que Requiere OC/HES (`PENDING_INVOICES_FOR_FLAGS_SQL`).
2. **Reemisión** (`invoice-void.ts` `planReissue`): nace con `contracts.auto_invoice` vigente (`ContractInvoiceContext.auto_invoice`,
   `CONTRACT_CONTEXT_SELECT` ahora trae `c.auto_invoice`); un `auto_invoice` explícito en `reissue_changes` manda.
3. **Enviar al ERP a mano** (`contract-invoices.ts` `planSendNow`): aviso `will_post_on_send` cuando la factura tiene la emisión encendida
   ("al enviarse se emite sin revisión y no queda como borrador"). Aviso, no bloqueo: con el punto 1 el caso que queda es una factura
   encendida a mano desde Editar factura, que sigue siendo válido.
4. Sin migración ni cambio de esquema.

## Consulta de control (solo lectura)

Por Emitir sin ERP cuyo interruptor no coincide con el del contrato, en las dos direcciones. Debe dar 0 tras la corrección de datos.

```sql
BEGIN TRANSACTION READ ONLY;
SELECT c.contract_number, c.auto_invoice AS contrato, i.auto_invoice AS factura, count(*) AS facturas
FROM invoices i JOIN contracts c ON c.id = i.contract_id
WHERE i.status = 'Por Emitir' AND i.is_active AND COALESCE(i.is_legacy, false) = false AND i.odoo_invoice_id IS NULL
  AND i.invoice_type IS DISTINCT FROM 'Unificada' AND COALESCE(i.document_type, '') !~* '^(NC|ND)$'
  AND c.deleted_at IS NULL AND COALESCE(c.auto_invoice, false) <> COALESCE(i.auto_invoice, false)
GROUP BY 1, 2, 3 ORDER BY 1;
ROLLBACK;
```

## Datos (pendiente, con OK de Domi y respaldo)

Prod 02-11: 59 Por Emitir sin ERP con contrato encendido y factura apagada (CTR-2026-131, 225, 227, 415, 47F05E, S04620, S07146, S07866) y
4 ya en borrador en el ERP (no se tocan). La dirección contraria (17) la corrigió soporte el 02-11. Pasar las 59 a `true` significa que se
emitirán sin revisión al enviarse: confirmar con Fernanda contrato por contrato antes.

## Impacto

- Quién más lee `invoices.auto_invoice`: scheduler (emitir y prefactura sin OC), envío manual, editor de factura (sigue pudiendo cambiar
  una sola), reorganización y activación (copian del contrato), reemisión (corregida), Modificar facturación (ya propagaba). El scheduler no
  cambia. `ContractInvoiceContext.auto_invoice` es opcional: los contextos que no lo cargan (360) no cambian.
- Tests: `contract-bulk.service.spec` (encender, apagar, solo envío, dos marcas), `invoice-void.spec` (reemisión con contrato apagado /
  encendido / explícito / sin dato), `contract-invoice-void.service.spec` (INSERT de la reemisión con el valor del contrato),
  `contract-invoices.spec` (aviso). Front: `AutomatizacionesFacturacion.test`.
- Doc: centro de ayuda Contratos › Facturas del contrato (franja) y novedad.
