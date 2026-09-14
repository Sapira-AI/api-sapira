-- Índice de public.contract_item_change_log que TypeORM no puede declarar con @Index
-- (método no btree, u orden explícito de columnas). Definición verbatim de prod.

CREATE INDEX IF NOT EXISTS idx_cicl_company ON public.contract_item_change_log USING btree (company_id, changed_at DESC);
