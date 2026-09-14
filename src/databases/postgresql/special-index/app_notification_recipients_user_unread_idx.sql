-- Índice de public.app_notification_recipients que TypeORM no puede declarar con @Index
-- (método no btree, u orden explícito de columnas). Definición verbatim de prod.

CREATE INDEX IF NOT EXISTS app_notification_recipients_user_unread_idx ON public.app_notification_recipients USING btree (user_id, is_read, created_at DESC);
