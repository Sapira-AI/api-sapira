-- Índice de public.invoice_items que TypeORM no puede declarar con @Index
-- (método no btree, u orden explícito de columnas). Definición verbatim de prod.

CREATE INDEX IF NOT EXISTS idx_invoice_items_custom_fields ON public.invoice_items USING gin (custom_fields);
