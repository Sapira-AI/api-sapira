-- Verificar cuántos clientes quedan por procesar

-- 1. Ver distribución por processing_status
SELECT 
    processing_status,
    COUNT(*) as count
FROM stripe_customers_stg
WHERE holding_id = '5652e95e-bb99-48f5-aa1c-13c8c2638fc6'
GROUP BY processing_status
ORDER BY processing_status;

-- 2. Ver clientes que NO fueron procesados (deberían ser to_create)
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
    AND (integration_notes IS NULL OR integration_notes != 'Cliente no valido')
ORDER BY created_at ASC
LIMIT 20;

-- 3. Contar cuántos fueron marcados como 'processed'
SELECT COUNT(*) as processed_count
FROM stripe_customers_stg
WHERE holding_id = '5652e95e-bb99-48f5-aa1c-13c8c2638fc6'
    AND processing_status = 'processed';

-- 4. Ver suscripciones disponibles
SELECT 
    processing_status,
    integration_notes,
    COUNT(*) as count
FROM stripe_subscriptions_stg
WHERE holding_id = '5652e95e-bb99-48f5-aa1c-13c8c2638fc6'
GROUP BY processing_status, integration_notes
ORDER BY processing_status;
