-- Índice de public.contract_lifecycle_events que TypeORM no puede declarar con @Index
-- (método no btree, u orden explícito de columnas). Definición verbatim de prod.

CREATE INDEX IF NOT EXISTS idx_contract_lifecycle_events_contract_effective ON public.contract_lifecycle_events USING btree (contract_id, effective_date DESC);
