-- Query para verificar si hay datos de BigQuery duplicados en diferentes holdings
-- Esto ayuda a identificar si los datos de SimpliRoute se asociaron incorrectamente a otros holdings

-- 1. Ver cuántos registros hay por holding
SELECT 
    h.name as holding_name,
    h.id as holding_id,
    COUNT(*) as total_registros
FROM stripe_customers_bigquery scb
JOIN company_holdings h ON h.id = scb.holding_id
GROUP BY h.name, h.id
ORDER BY total_registros DESC;

-- 2. Ver si hay registros duplicados (mismo stripe_customer_id en diferentes holdings)
SELECT 
    scb.stripe_customer_id,
    scb.client_name,
    COUNT(DISTINCT scb.holding_id) as holdings_count,
    STRING_AGG(DISTINCT h.name, ', ') as holdings_names
FROM stripe_customers_bigquery scb
JOIN company_holdings h ON h.id = scb.holding_id
GROUP BY scb.stripe_customer_id, scb.client_name
HAVING COUNT(DISTINCT scb.holding_id) > 1
ORDER BY holdings_count DESC;

-- 3. Ver todos los holdings que tienen datos de BigQuery
SELECT DISTINCT
    h.name as holding_name,
    h.id as holding_id
FROM stripe_customers_bigquery scb
JOIN company_holdings h ON h.id = scb.holding_id
ORDER BY h.name;

-- 4. Si necesitas eliminar datos incorrectos de holdings que NO son SimpliRoute:
-- DESCOMENTAR SOLO SI ESTÁS SEGURO
-- DELETE FROM stripe_customers_bigquery 
-- WHERE holding_id IN (
--     SELECT id FROM company_holdings WHERE name != 'SimpliRoute'
-- );

-- ============================================================================
-- MIGRACIÓN DE CONFIGURACIÓN DE BIGQUERY PARA SIMPLIROUTE
-- ============================================================================
-- Después de aplicar la migración 20260603000000_create_bigquery_connections.sql
-- ejecutar los siguientes pasos para migrar la configuración existente:

-- Paso 1: Obtener el holding_id de SimpliRoute
-- SELECT id, name FROM company_holdings WHERE name = 'SimpliRoute';

-- Paso 2: Obtener un user_id de administrador del holding
-- SELECT uh.user_id 
-- FROM user_holdings uh 
-- WHERE uh.holding_id = '[HOLDING_ID_DE_SIMPLIROUTE]' 
-- LIMIT 1;

-- Paso 3: Crear el registro de conexión BigQuery para SimpliRoute
-- REEMPLAZAR [HOLDING_ID], [USER_ID] y [BIGQUERY_CREDENTIALS_JSON] con valores reales
-- 
-- INSERT INTO bigquery_connections (
--   holding_id,
--   user_id,
--   name,
--   project_id,
--   credentials,
--   is_active,
--   created_at,
--   updated_at
-- ) VALUES (
--   '[HOLDING_ID_DE_SIMPLIROUTE]',
--   '[USER_ID_ADMIN]',
--   'BigQuery Production',
--   'datawarehouse-a2e2',
--   '[COPIAR_BIGQUERY_CREDENTIALS_DEL_.ENV]',
--   true,
--   NOW(),
--   NOW()
-- );

-- Paso 4: Verificar que la conexión se creó correctamente
-- SELECT * FROM bigquery_connections WHERE holding_id = '[HOLDING_ID_DE_SIMPLIROUTE]';

-- Paso 5: Después de verificar, puedes remover BIGQUERY_CREDENTIALS del .env
-- ya que ahora se usa la configuración de la base de datos

-- ============================================================================
-- VERIFICACIÓN DEL ESTADO DE LA MIGRACIÓN
-- ============================================================================

-- Query para verificar todas las conexiones BigQuery configuradas
SELECT 
    bc.id,
    bc.name,
    h.name as holding_name,
    bc.project_id,
    bc.is_active,
    bc.last_sync_at,
    bc.created_at,
    bc.updated_at
FROM bigquery_connections bc
JOIN company_holdings h ON h.id = bc.holding_id
ORDER BY bc.created_at DESC;

-- Query para verificar cuántos holdings tienen BigQuery configurado
SELECT 
    COUNT(DISTINCT bc.holding_id) as holdings_con_bigquery,
    COUNT(*) as total_conexiones,
    SUM(CASE WHEN bc.is_active THEN 1 ELSE 0 END) as conexiones_activas
FROM bigquery_connections bc;
