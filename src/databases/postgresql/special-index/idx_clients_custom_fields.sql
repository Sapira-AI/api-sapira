-- Índice de public.clients que TypeORM no puede declarar con @Index
-- (método no btree, u orden explícito de columnas). Definición verbatim de prod.

CREATE INDEX IF NOT EXISTS idx_clients_custom_fields ON public.clients USING gin (custom_fields);
