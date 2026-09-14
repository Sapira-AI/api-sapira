-- Índice de public.workflow_step_documents que TypeORM no puede declarar con @Index
-- (método no btree, u orden explícito de columnas). Definición verbatim de prod.

CREATE INDEX IF NOT EXISTS idx_wsd_uploaded_at ON public.workflow_step_documents USING btree (uploaded_at DESC);
