-- Índice de public.rag_documents que TypeORM no puede declarar con @Index
-- (método no btree, u orden explícito de columnas). Definición verbatim de prod.

CREATE INDEX IF NOT EXISTS rag_documents_metadata_gin_idx ON public.rag_documents USING gin (metadata);
