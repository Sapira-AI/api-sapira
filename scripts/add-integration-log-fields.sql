-- =====================================================
-- SCRIPT PARA AGREGAR CAMPOS A integration_logs
-- =====================================================
-- Este script agrega únicamente los campos nuevos sin tocar
-- FK existentes, constraints o políticas RLS

-- Agregar campos nuevos a integration_logs
ALTER TABLE integration_logs 
ADD COLUMN IF NOT EXISTS integration_type varchar(100),
ADD COLUMN IF NOT EXISTS progress_total integer DEFAULT 0,
ADD COLUMN IF NOT EXISTS result jsonb,
ADD COLUMN IF NOT EXISTS metadata jsonb DEFAULT '{}',
ADD COLUMN IF NOT EXISTS connection_id uuid;

-- Crear índices para los campos nuevos
CREATE INDEX IF NOT EXISTS idx_integration_logs_integration_type 
ON integration_logs (integration_type);

CREATE INDEX IF NOT EXISTS idx_integration_logs_connection_id 
ON integration_logs (connection_id);

CREATE INDEX IF NOT EXISTS idx_integration_logs_progress_total 
ON integration_logs (progress_total);

-- Verificar que los campos se agregaron correctamente
SELECT 
    column_name,
    data_type,
    is_nullable,
    column_default
FROM information_schema.columns 
WHERE table_name = 'integration_logs' 
  AND table_schema = 'public'
  AND column_name IN ('integration_type', 'progress_total', 'result', 'metadata', 'connection_id')
ORDER BY column_name;

-- Verificar índices creados
SELECT 
    indexname,
    indexdef
FROM pg_indexes 
WHERE tablename = 'integration_logs' 
  AND schemaname = 'public'
  AND indexname LIKE '%integration_type%' 
   OR indexname LIKE '%connection_id%'
   OR indexname LIKE '%progress_total%'
ORDER BY indexname;
