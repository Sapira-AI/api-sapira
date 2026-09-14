-- Índice de public.period_guard_warnings que TypeORM no puede declarar con @Index
-- (método no btree, u orden explícito de columnas). Definición verbatim de prod.

CREATE INDEX IF NOT EXISTS idx_pgw_company_time ON public.period_guard_warnings USING btree (holding_id, company_id, occurred_at DESC);
