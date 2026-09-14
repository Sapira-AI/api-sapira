-- Índice de public.contract_change_log que TypeORM no puede declarar con @Index
-- (método no btree, u orden explícito de columnas). Definición verbatim de prod.

CREATE INDEX IF NOT EXISTS idx_ccl_contract ON public.contract_change_log USING btree (contract_id, changed_at DESC);
