-- Verificar valores de integration_notes en stripe_customers_stg

-- 1. Ver distribución de valores de integration_notes
SELECT 
    integration_notes,
    COUNT(*) as count
FROM stripe_customers_stg
WHERE holding_id = '5652e95e-bb99-48f5-aa1c-13c8c2638fc6'
    AND processing_status IN ('to_create', 'to_update', 'error')
GROUP BY integration_notes
ORDER BY count DESC;

-- 2. Ver algunos ejemplos de registros
SELECT 
    id,
    stripe_id,
    processing_status,
    integration_notes,
    error_message,
    last_integrated_at
FROM stripe_customers_stg
WHERE holding_id = '5652e95e-bb99-48f5-aa1c-13c8c2638fc6'
    AND processing_status IN ('to_create', 'to_update', 'error')
LIMIT 10;

-- 3. Contar cuántos tienen integration_notes NULL vs no NULL
SELECT 
    CASE 
        WHEN integration_notes IS NULL THEN 'NULL'
        ELSE 'NOT NULL'
    END as notes_status,
    COUNT(*) as count
FROM stripe_customers_stg
WHERE holding_id = '5652e95e-bb99-48f5-aa1c-13c8c2638fc6'
    AND processing_status IN ('to_create', 'to_update', 'error')
GROUP BY notes_status;
