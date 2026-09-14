-- Índice de public.odoo_partners_stg que TypeORM no puede declarar con @Index
-- (método no btree, u orden explícito de columnas). Definición verbatim de prod.

CREATE INDEX IF NOT EXISTS idx_odoo_partners_stg_raw_data_gin ON public.odoo_partners_stg USING gin (raw_data);
