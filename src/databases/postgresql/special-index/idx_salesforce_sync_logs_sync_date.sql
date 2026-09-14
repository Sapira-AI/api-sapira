-- Índice de public.salesforce_sync_logs que TypeORM no puede declarar con @Index
-- (método no btree, u orden explícito de columnas). Definición verbatim de prod.

CREATE INDEX IF NOT EXISTS idx_salesforce_sync_logs_sync_date ON public.salesforce_sync_logs USING btree (sync_date DESC);
