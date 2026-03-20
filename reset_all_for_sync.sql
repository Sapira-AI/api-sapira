-- Script completo para resetear clientes, suscripciones y facturas antes de sincronización

-- 1. Limpiar clientes (los 152 restantes + cualquier error)
UPDATE stripe_customers_stg 
SET 
    integration_notes = NULL,
    error_message = NULL,
    processing_status = CASE 
        WHEN processing_status = 'error' THEN 'to_create'
        ELSE processing_status
    END
WHERE holding_id = '5652e95e-bb99-48f5-aa1c-13c8c2638fc6'
  AND (
    (processing_status = 'to_create' AND integration_notes = 'Cliente no valido')
    OR processing_status = 'error'
  );

-- 2. Limpiar suscripciones (todas las 404)
UPDATE stripe_subscriptions_stg 
SET 
    integration_notes = NULL,
    error_message = NULL
WHERE holding_id = '5652e95e-bb99-48f5-aa1c-13c8c2638fc6'
  AND processing_status = 'to_create'
  AND integration_notes = 'Cliente no valido';

-- 3. Limpiar facturas (todas las 2825)
UPDATE stripe_invoices_stg 
SET 
    integration_notes = NULL,
    error_message = NULL
WHERE holding_id = '5652e95e-bb99-48f5-aa1c-13c8c2638fc6'
  AND processing_status = 'to_create'
  AND integration_notes = 'Cliente no valido';

-- 4. Verificar resultados
SELECT 'Clientes' as tipo, processing_status, COUNT(*) as count
FROM stripe_customers_stg
WHERE holding_id = '5652e95e-bb99-48f5-aa1c-13c8c2638fc6'
GROUP BY processing_status
UNION ALL
SELECT 'Suscripciones' as tipo, processing_status, COUNT(*) as count
FROM stripe_subscriptions_stg
WHERE holding_id = '5652e95e-bb99-48f5-aa1c-13c8c2638fc6'
GROUP BY processing_status
UNION ALL
SELECT 'Facturas' as tipo, processing_status, COUNT(*) as count
FROM stripe_invoices_stg
WHERE holding_id = '5652e95e-bb99-48f5-aa1c-13c8c2638fc6'
GROUP BY processing_status
ORDER BY tipo, processing_status;

-- 5. Contar registros listos para sincronizar
SELECT 
    'Clientes disponibles' as descripcion,
    COUNT(*) as count
FROM stripe_customers_stg
WHERE holding_id = '5652e95e-bb99-48f5-aa1c-13c8c2638fc6'
    AND processing_status IN ('to_create', 'to_update', 'error')
    AND (integration_notes IS NULL OR integration_notes != 'Cliente no valido')
UNION ALL
SELECT 
    'Suscripciones disponibles' as descripcion,
    COUNT(*) as count
FROM stripe_subscriptions_stg
WHERE holding_id = '5652e95e-bb99-48f5-aa1c-13c8c2638fc6'
    AND processing_status IN ('to_create', 'to_update', 'error')
    AND (integration_notes IS NULL OR integration_notes != 'Cliente no valido')
UNION ALL
SELECT 
    'Facturas disponibles' as descripcion,
    COUNT(*) as count
FROM stripe_invoices_stg
WHERE holding_id = '5652e95e-bb99-48f5-aa1c-13c8c2638fc6'
    AND processing_status IN ('to_create', 'to_update', 'error')
    AND (integration_notes IS NULL OR integration_notes != 'Cliente no valido');
