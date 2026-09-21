-- Índice de public.accounting_period_events que TypeORM no puede declarar con @Index
-- (método no btree, u orden explícito de columnas). Definición verbatim de prod.

CREATE INDEX IF NOT EXISTS idx_period_events_performed_by ON public.accounting_period_events USING btree (performed_by, performed_at DESC);
