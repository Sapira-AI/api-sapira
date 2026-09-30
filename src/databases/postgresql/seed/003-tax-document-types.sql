-- Catálogo de documentos tributarios por país (Contratos v2, mapa §6). Tabla creada por la migración
-- `1790620000000-CreateTaxDocumentTypes`; este seed solo carga las filas. Idempotente por (country_code, code).
--
-- country_code = ISO-2; '*' = filas genéricas para compañías cuyo país no tiene documentos propios en el catálogo.
-- kind: invoice | export_invoice | credit_note | debit_note | receipt. De él se deriva contracts.document_type.
-- Agregar países o documentos: seed nuevo con número siguiente. Corregir una fila existente: migración con UPDATE.
INSERT INTO public.tax_document_types (country_code, code, name, kind, is_electronic, sort)
VALUES
	-- Chile (SII)
	('CL', '33', 'Factura electrónica', 'invoice', TRUE, 10),
	('CL', '34', 'Factura no afecta o exenta electrónica', 'invoice', TRUE, 20),
	('CL', '110', 'Factura de exportación electrónica', 'export_invoice', TRUE, 30),
	('CL', '61', 'Nota de crédito electrónica', 'credit_note', TRUE, 40),
	('CL', '56', 'Nota de débito electrónica', 'debit_note', TRUE, 50),
	('CL', '111', 'Nota de débito de exportación electrónica', 'debit_note', TRUE, 60),
	('CL', '112', 'Nota de crédito de exportación electrónica', 'credit_note', TRUE, 70),
	-- Perú (SUNAT)
	('PE', '01', 'Factura electrónica', 'invoice', TRUE, 10),
	('PE', '03', 'Boleta de venta electrónica', 'receipt', TRUE, 20),
	('PE', '07', 'Nota de crédito', 'credit_note', TRUE, 30),
	('PE', '08', 'Nota de débito', 'debit_note', TRUE, 40),
	-- México (SAT)
	('MX', 'CFDI-I', 'Factura CFDI de ingreso', 'invoice', TRUE, 10),
	('MX', 'CFDI-E', 'Nota de crédito CFDI de egreso', 'credit_note', TRUE, 20),
	-- Colombia (DIAN)
	('CO', 'FE', 'Factura electrónica de venta', 'invoice', TRUE, 10),
	('CO', 'NC', 'Nota crédito electrónica', 'credit_note', TRUE, 20),
	-- Genéricos (cualquier país sin catálogo propio)
	('*', 'FACTURA', 'Factura', 'invoice', FALSE, 10),
	('*', 'FACTURA_EXPORTACION', 'Factura de exportación', 'export_invoice', FALSE, 20)
ON CONFLICT (country_code, code) DO NOTHING;
