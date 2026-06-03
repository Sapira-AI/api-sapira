-- ============================================================================
-- OBTENER USER_ID VÁLIDO PARA SIMPLIROUTE
-- ============================================================================
-- Este script te ayuda a encontrar un user_id válido del holding de SimpliRoute

-- Opción 1: Obtener usuarios del holding SimpliRoute desde user_holdings
SELECT 
    uh.user_id,
    u.email,
    u.created_at as user_created_at,
    uh.created_at as assigned_to_holding_at
FROM user_holdings uh
JOIN auth.users u ON u.id = uh.user_id
WHERE uh.holding_id = '5652e95e-bb99-48f5-aa1c-13c8c2638fc6'
ORDER BY uh.created_at ASC
LIMIT 10;

-- Opción 2: Si user_holdings no tiene datos, buscar cualquier usuario activo
SELECT 
    id as user_id,
    email,
    created_at
FROM auth.users
WHERE deleted_at IS NULL
ORDER BY created_at ASC
LIMIT 10;

-- ============================================================================
-- INSTRUCCIONES
-- ============================================================================
-- 1. Ejecuta la Opción 1 primero
-- 2. Si retorna resultados, copia uno de los user_id
-- 3. Si NO retorna resultados, ejecuta la Opción 2
-- 4. Copia el user_id que quieras usar
-- 5. Actualiza el archivo migrate-bigquery-simpliroute.sql con el user_id correcto
-- 6. Vuelve a ejecutar el script de migración
-- ============================================================================
