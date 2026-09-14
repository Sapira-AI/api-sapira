-- Índice de public.overdue_check_log que TypeORM no puede declarar con @Index
-- (método no btree, u orden explícito de columnas). Definición verbatim de prod.

CREATE INDEX IF NOT EXISTS idx_overdue_check_log_holding_id ON public.overdue_check_log USING btree (holding_id, created_at DESC);
