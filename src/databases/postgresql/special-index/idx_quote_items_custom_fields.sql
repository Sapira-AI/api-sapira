-- Índice de public.quote_items que TypeORM no puede declarar con @Index
-- (método no btree, u orden explícito de columnas). Definición verbatim de prod.

CREATE INDEX IF NOT EXISTS idx_quote_items_custom_fields ON public.quote_items USING gin (custom_fields);
