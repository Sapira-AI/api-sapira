-- Índice de public.stripe_sync_jobs que TypeORM no puede declarar con @Index
-- (método no btree, u orden explícito de columnas). Definición verbatim de prod.

CREATE INDEX IF NOT EXISTS idx_stripe_sync_jobs_created_at ON public.stripe_sync_jobs USING btree (created_at DESC);
