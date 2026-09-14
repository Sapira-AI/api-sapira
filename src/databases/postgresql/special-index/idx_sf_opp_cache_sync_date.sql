-- Índice de public.salesforce_opportunities_cache que TypeORM no puede declarar con @Index
-- (método no btree, u orden explícito de columnas). Definición verbatim de prod.

CREATE INDEX IF NOT EXISTS idx_sf_opp_cache_sync_date ON public.salesforce_opportunities_cache USING btree (sync_date DESC);
