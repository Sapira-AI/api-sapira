-- Índice de public.contract_amendments que TypeORM no puede declarar con @Index
-- (método no btree, u orden explícito de columnas). Definición verbatim de prod.

CREATE INDEX IF NOT EXISTS idx_contract_amendments_contract_date ON public.contract_amendments USING btree (contract_id, effective_date DESC, created_at DESC);
