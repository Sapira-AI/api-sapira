-- Índice de public.invoices que TypeORM no puede declarar con @Index
-- (método no btree, u orden explícito de columnas). Definición verbatim de prod.

CREATE INDEX IF NOT EXISTS idx_invoices_custom_fields ON public.invoices USING gin (custom_fields);
