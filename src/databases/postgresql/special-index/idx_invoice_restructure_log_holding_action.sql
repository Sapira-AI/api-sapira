-- Índice de public.invoice_restructure_log que TypeORM no puede declarar con @Index
-- (método no btree, u orden explícito de columnas). Definición verbatim de prod.

CREATE INDEX IF NOT EXISTS idx_invoice_restructure_log_holding_action ON public.invoice_restructure_log USING btree (holding_id, action, created_at DESC);
