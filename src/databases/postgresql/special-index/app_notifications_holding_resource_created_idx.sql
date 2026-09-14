-- Índice de public.app_notifications que TypeORM no puede declarar con @Index
-- (método no btree, u orden explícito de columnas). Definición verbatim de prod.

CREATE INDEX IF NOT EXISTS app_notifications_holding_resource_created_idx ON public.app_notifications USING btree (holding_id, resource_type, resource_id, created_at DESC) WHERE (resource_id IS NOT NULL);
