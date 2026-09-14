-- Índice de public.ai_runs que TypeORM no puede declarar con @Index
-- (método no btree, u orden explícito de columnas). Definición verbatim de prod.

CREATE INDEX IF NOT EXISTS ai_runs_agent_idx ON public.ai_runs USING btree (agent_id, created_at DESC);
