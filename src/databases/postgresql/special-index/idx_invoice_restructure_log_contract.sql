-- Índice de public.invoice_restructure_log que TypeORM no puede declarar con @Index
-- (método no btree, u orden explícito de columnas). Definición verbatim de prod.

CREATE INDEX IF NOT EXISTS idx_invoice_restructure_log_contract ON public.invoice_restructure_log USING btree (contract_id, created_at DESC);
