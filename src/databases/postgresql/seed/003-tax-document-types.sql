-- Catálogo de documentos tributarios por país (Contratos v2, mapa §6). Tabla creada por la migración
-- `1790620000000-CreateTaxDocumentTypes`; este seed solo carga las filas. Idempotente por (country_code, code).
--
-- country_code = ISO-2; '*' = filas genéricas para compañías cuyo país no tiene documentos propios en el catálogo.
-- kind: invoice | export_invoice | credit_note | debit_note | receipt. De él se deriva contracts.document_type.
-- description_max_chars: largo máximo de la glosa de una línea (SII NmbItem = 80); NULL = sin límite (MX y PE a confirmar con Leon).
-- La columna la agrega la migración `1790670000000-InvoiceDescriptionTemplate`, que también fija 80 en las filas CL ya sembradas.
-- Agregar países o documentos: seed nuevo con número siguiente. Corregir una fila existente: migración con UPDATE.
INSERT INTO public.tax_document_types (country_code, code, name, kind, is_electronic, sort, description_max_chars)
VALUES
	-- Chile (SII)
	('CL', '33', 'Factura electrónica', 'invoice', TRUE, 10, 80),
	('CL', '34', 'Factura no afecta o exenta electrónica', 'invoice', TRUE, 20, 80),
	('CL', '110', 'Factura de exportación electrónica', 'export_invoice', TRUE, 30, 80),
	('CL', '61', 'Nota de crédito electrónica', 'credit_note', TRUE, 40, 80),
	('CL', '56', 'Nota de débito electrónica', 'debit_note', TRUE, 50, 80),
	('CL', '111', 'Nota de débito de exportación electrónica', 'debit_note', TRUE, 60, 80),
	('CL', '112', 'Nota de crédito de exportación electrónica', 'credit_note', TRUE, 70, 80),
	-- Perú (SUNAT)
	('PE', '01', 'Factura electrónica', 'invoice', TRUE, 10, NULL),
	('PE', '03', 'Boleta de venta electrónica', 'receipt', TRUE, 20, NULL),
	('PE', '07', 'Nota de crédito', 'credit_note', TRUE, 30, NULL),
	('PE', '08', 'Nota de débito', 'debit_note', TRUE, 40, NULL),
	-- México (SAT)
	('MX', 'CFDI-I', 'Factura CFDI de ingreso', 'invoice', TRUE, 10, NULL),
	('MX', 'CFDI-E', 'Nota de crédito CFDI de egreso', 'credit_note', TRUE, 20, NULL),
	-- Colombia (DIAN)
	('CO', 'FE', 'Factura electrónica de venta', 'invoice', TRUE, 10, NULL),
	('CO', 'NC', 'Nota crédito electrónica', 'credit_note', TRUE, 20, NULL),
	-- Genéricos (cualquier país sin catálogo propio)
	('*', 'FACTURA', 'Factura', 'invoice', FALSE, 10, NULL),
	('*', 'FACTURA_EXPORTACION', 'Factura de exportación', 'export_invoice', FALSE, 20, NULL)
ON CONFLICT (country_code, code) DO NOTHING;
