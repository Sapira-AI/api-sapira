-- Configuración v2 ronda 3 (decisión de Domi, 03-10): tasa de impuesto por documento tributario (tax_document_types.tax_rate, %).
-- La migración 1790820000000-TaxDocumentTypesTaxRate crea la columna y carga estos valores en las bases que ya tienen el catálogo.
-- En un entorno NUEVO el seed 003 inserta el catálogo DESPUÉS de las migraciones: este seed completa las tasas ahí.
-- Idempotente: solo escribe donde tax_rate sigue NULL (no pisa una tasa ya fijada). No-op en QA y producción tras la migración.
-- Requiere: migración 1790820000000 y seed/003-tax-document-types.sql. NO APLICADO al 03-10.
UPDATE public.tax_document_types t
SET tax_rate = v.rate
FROM (VALUES
  ('CL', '33', 19::numeric),
  ('CL', '34', 0::numeric),
  ('CL', '110', 0::numeric),
  ('CL', '111', 0::numeric),
  ('CL', '112', 0::numeric),
  ('PE', '01', 18::numeric),
  ('PE', '03', 18::numeric),
  ('MX', 'CFDI-I', 16::numeric),
  ('CO', 'FE', 0::numeric)
) AS v(country_code, code, rate)
WHERE t.country_code = v.country_code AND t.code = v.code AND t.tax_rate IS NULL;
