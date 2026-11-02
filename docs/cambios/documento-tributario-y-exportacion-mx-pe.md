# Documento tributario por contrato o por factura y facturas de exportación MX/PE (Domi 02-11, bug B de soporte)

Caso: contratos de SimpliRoute México y Perú con razón social de otro país (p. ej. Avon, `ctr-2026-218`) salían con la factura nacional
(CFDI de ingreso 16 % / factura 18 %) porque el catálogo de MX y PE no tenía factura de exportación; al elegir la familia de exportación a
mano, el contrato quedaba sin documento del catálogo. Además `ctr-2026-218` convivía con `CTR-2026-218` (Farmacias EOS): el índice único
distinguía mayúsculas.

## Qué cambia

1. **Catálogo** (`1792500000000-TaxDocumentTypesExportMxPe` + `seed/009-tax-document-types-export-mx-pe.sql`): MX `CFDI-I-EXP` "Factura
   CFDI de ingreso de exportación" y PE `01-EXP` "Factura electrónica de exportación", `kind = export_invoice`, `tax_rate = 0`, `sort 15`.
   Idempotente por (country_code, code). La regla de sugerencia (`suggestTaxDocumentType`: exportación cuando el país de la compañía y el de
   la razón social difieren) ya las toma; el fallback a las filas genéricas `*` (05-10) se conserva para países sin catálogo propio.
2. **Documento solo, para todo el contrato** (`planBillingConditions`): `billing_conditions` con `tax_document_type_id` (o `document_type`
   sin catálogo) distinto del actual guarda el documento y la familia en el contrato (`fields_before/after` + `tax_rate`) y emite
   `update_invoices_document` sobre las Por Emitir desde la fecha efectiva (no facturadas por OC): `document_type`, `export_type` (1 si
   exportación: **es lo que el envío al ERP mira**) y `tax_rate` del documento (`taxRateFor` → `resolveTaxRate`); el IVA de cada línea se
   recalcula en el servicio. Las emitidas no se tocan. Desaparece el bloqueo `tax_document_requires_party_change` (ronda 4, 03-10);
   `change_entity` sigue aceptando el documento junto con la razón social nueva.
3. **Documento de una sola factura** (`EditInvoiceDto.tax_document_type_id`, `planHeader`): la factura toma familia, `export_type` e IVA del
   documento elegido (país de la compañía emisora o genérico, clase invoice | export_invoice; si no → error de campo). `writeHeader` ahora
   escribe `document_type`. Con receptor de otro país y documento elegido en la misma edición no sale el aviso `document_type_review`.
4. **Número de contrato único sin mayúsculas** (`1792510000000-ContractNumberUniqueCaseInsensitive`): reemplaza
   `contracts_holding_number_unique` por `contracts_holding_number_unique_ci` sobre `(holding_id, lower(contract_number))`. Antes de crear
   el índice verifica que no haya repetidos salvo mayúsculas y **falla con la lista** si los hay. La entity conserva la declaración del índice
   viejo (sigue en prod hasta aplicar la migración) y marca el nuevo con `synchronize: false` (`special-index/`).

## Orden de aplicación en producción (datos antes que el índice)

1. Renumerar `ctr-2026-218` (Avon) → `CTR-2026-420` (siguiente correlativo real; `CTR-2026-884106` es un número escrito a mano y se ignora)
   **antes** de desplegar la API: la migración 4 falla si el duplicado sigue. Con respaldo en `sapira_backups` y OK de Domi.
2. Desplegar (migraciones 1 y 4).
3. Avon: `tax_document_type_id` = MX `CFDI-I-EXP`, `document_type = FACTURA_EXPORTACION`; sus Por Emitir: `document_type`, `export_type = 1`,
   `tax_rate = 0` y el IVA de las líneas en 0 (misma cuenta que `update_invoices_document`). Con respaldo y OK de Domi.

## Impacto

- **Quién más lo usa.** `update_invoices_document` ya existía (`change_entity`); `retaxPending` se reutiliza. `taxDocumentOf`/`tax_document`
  del editor no cambian. `planBulkHeader` (edición masiva) no acepta documento: fuera de alcance. `invoice-dte.ts` decide 110 por
  `document_type` de la factura **o** código 110 del contrato: una factura cambiada a nacional en un contrato 110 seguiría saliendo como
  exportación al SII (Chile; caso no pedido, se anota). Front: `conditionsChange` manda el documento; `DocumentoTributarioField` sin
  `disabledReason`; editor con `useContrato` + `useContratoFormOptions` para el catálogo de la compañía.
- **Registros reales.** Prod: 1 contrato con el bug (Avon) y 1 duplicado de número (ver orden arriba). QA sin duplicados (verificado).
- **Qué lo verifica.** `contract-changes.spec` (documento solo con catálogo, familia sin catálogo, tasa propia PE 18 %, 400 de siempre),
  `invoice-edit.spec` (documento por factura, mismo documento, receptor + documento, documento inválido), `contract-invoice-edit.service.spec`
  (`document_type` en el UPDATE), `configuracion-v2.spec` (migración + seed), `indices-declarados.spec`. Front: `cambios.test`,
  `ModificarContratoDrawer.test`, `factura-edicion.test`, `EditarFacturaDrawer.test`.
- **Doc.** Centro de ayuda: Contratos › Modificar un contrato (Condiciones) y Facturas del contrato (Editar) + novedad 02-11; API:
  `contrato-api-configuracion.md` §9.7 y `spec-configuracion-v2.md` (ronda 4, fila 1).
