-- Facturas de exportación de México y Perú (Domi 02-11, bug B de soporte): exentas (kind export_invoice, tax_rate 0).
-- La migración 1792500000000-TaxDocumentTypesExportMxPe las inserta en las bases que ya tienen el catálogo; en un entorno NUEVO el
-- seed 003 corre después de las migraciones y este seed completa las dos filas. Idempotente por (country_code, code).
INSERT INTO public.tax_document_types (country_code, code, name, kind, is_electronic, sort, active, tax_rate)
VALUES
	('MX', 'CFDI-I-EXP', 'Factura CFDI de ingreso de exportación', 'export_invoice', TRUE, 15, TRUE, 0),
	('PE', '01-EXP', 'Factura electrónica de exportación', 'export_invoice', TRUE, 15, TRUE, 0)
ON CONFLICT (country_code, code) DO NOTHING;
