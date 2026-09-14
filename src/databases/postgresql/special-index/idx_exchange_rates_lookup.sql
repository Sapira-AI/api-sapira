-- Índice de public.exchange_rates que TypeORM no puede declarar con @Index
-- (método no btree, u orden explícito de columnas). Definición verbatim de prod.

CREATE INDEX IF NOT EXISTS idx_exchange_rates_lookup ON public.exchange_rates USING btree (from_currency, to_currency, rate_date DESC);
