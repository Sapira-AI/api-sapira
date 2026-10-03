-- Índice de public.client_activity_notes que TypeORM no puede declarar con @Index
-- (método no btree, u orden explícito de columnas). Definición verbatim de prod.

CREATE INDEX IF NOT EXISTS client_activity_notes_mentions_idx ON public.client_activity_notes USING gin (mentioned_user_ids);
