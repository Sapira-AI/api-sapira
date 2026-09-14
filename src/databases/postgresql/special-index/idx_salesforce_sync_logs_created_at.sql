-- Índice de public.salesforce_sync_logs que TypeORM no puede declarar con @Index
-- (método no btree, u orden explícito de columnas). Definición verbatim de prod.

CREATE INDEX IF NOT EXISTS idx_salesforce_sync_logs_created_at ON public.salesforce_sync_logs USING btree (created_at DESC);
