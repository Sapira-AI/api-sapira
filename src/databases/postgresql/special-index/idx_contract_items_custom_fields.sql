-- Índice de public.contract_items que TypeORM no puede declarar con @Index
-- (método no btree, u orden explícito de columnas). Definición verbatim de prod.

CREATE INDEX IF NOT EXISTS idx_contract_items_custom_fields ON public.contract_items USING gin (custom_fields);
