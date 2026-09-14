-- Índice de public.ai_messages que TypeORM no puede declarar con @Index
-- (método no btree, u orden explícito de columnas). Definición verbatim de prod.

CREATE INDEX IF NOT EXISTS ai_messages_run_idx ON public.ai_messages USING btree (run_id, created_at DESC);
