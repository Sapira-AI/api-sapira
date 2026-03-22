-- Resetear clientes para permitir nueva sincronización
-- Esto limpia integration_notes y cambia processing_status de 'invalid' a 'to_create'

UPDATE stripe_customers_stg 
SET 
    integration_notes = NULL,
    error_message = NULL,
    processing_status = CASE 
        WHEN processing_status = 'invalid' THEN 'to_create'
        ELSE processing_status
    END
WHERE holding_id = '5652e95e-bb99-48f5-aa1c-13c8c2638fc6'
  AND processing_status IN ('to_create', 'to_update', 'error', 'invalid');

-- Verificar el resultado
SELECT 
    processing_status,
    integration_notes,
    COUNT(*) as count
FROM stripe_customers_stg
WHERE holding_id = '5652e95e-bb99-48f5-aa1c-13c8c2638fc6'
GROUP BY processing_status, integration_notes
ORDER BY processing_status;
