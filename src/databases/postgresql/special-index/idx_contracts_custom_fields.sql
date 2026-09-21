-- Índice de public.contracts que TypeORM no puede declarar con @Index
-- (método no btree, u orden explícito de columnas). Definición verbatim de prod.

CREATE INDEX IF NOT EXISTS idx_contracts_custom_fields ON public.contracts USING gin (custom_fields);
