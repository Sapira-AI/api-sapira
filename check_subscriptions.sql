-- Verificar estado de suscripciones en staging

-- 1. Distribución por processing_status
SELECT 
    processing_status,
    COUNT(*) as count
FROM stripe_subscriptions_stg
WHERE holding_id = '5652e95e-bb99-48f5-aa1c-13c8c2638fc6'
GROUP BY processing_status
ORDER BY processing_status;

-- 2. Distribución por integration_notes
SELECT 
    integration_notes,
    COUNT(*) as count
FROM stripe_subscriptions_stg
WHERE holding_id = '5652e95e-bb99-48f5-aa1c-13c8c2638fc6'
    AND processing_status IN ('to_create', 'to_update', 'error')
GROUP BY integration_notes
ORDER BY count DESC;

-- 3. Contar suscripciones disponibles para sincronizar
SELECT COUNT(*) as available_count
FROM stripe_subscriptions_stg
WHERE holding_id = '5652e95e-bb99-48f5-aa1c-13c8c2638fc6'
    AND processing_status IN ('to_create', 'to_update', 'error')
    AND (integration_notes IS NULL OR integration_notes != 'Cliente no valido');

-- 4. Ver ejemplos de suscripciones
SELECT 
    id,
    stripe_id,
    stripe_customer_id,
    processing_status,
    integration_notes,
    error_message
FROM stripe_subscriptions_stg
WHERE holding_id = '5652e95e-bb99-48f5-aa1c-13c8c2638fc6'
ORDER BY created_at ASC
LIMIT 10;

-- 5. Total de suscripciones en staging
SELECT COUNT(*) as total_subscriptions
FROM stripe_subscriptions_stg
WHERE holding_id = '5652e95e-bb99-48f5-aa1c-13c8c2638fc6';
