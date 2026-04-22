-- ============================================
-- CORRECCIÓN: Tax IDs para México (Company ID 4)
-- ============================================
-- Este script corrige los mapeos de productos que tienen taxes incorrectos
-- para la empresa SimpliRoute S.A.P.I DE C.V (México)

-- PASO 1: Identificar el problema
-- ============================================
-- Ver los mapeos actuales con taxes incorrectos
SELECT 
    opm.id,
    opm.holding_id,
    opm.sapira_product_id,
    p.name as product_name,
    opm.odoo_product_id,
    opm.metadata->>'odoo_tax_ids' as current_tax_ids,
    opm.created_at
FROM odoo_product_mappings opm
LEFT JOIN products p ON p.id = opm.sapira_product_id
WHERE opm.holding_id = '5652e95e-bb99-48f5-aa1c-13c8c2638fc6'
  AND opm.metadata->>'odoo_tax_ids' LIKE '%1,19,40,80,84,91,116%'
ORDER BY opm.created_at DESC;

-- PASO 2: Crear backup antes de modificar
-- ============================================
CREATE TABLE IF NOT EXISTS odoo_product_mappings_backup_20260422 AS
SELECT * FROM odoo_product_mappings
WHERE holding_id = '5652e95e-bb99-48f5-aa1c-13c8c2638fc6';

-- Verificar backup
SELECT COUNT(*) as total_backed_up 
FROM odoo_product_mappings_backup_20260422;

-- PASO 3: Consultar taxes disponibles para México
-- ============================================
-- Primero, usa el endpoint API para ver los taxes disponibles:
-- GET /odoo/taxes/4?company_id=4
-- Header: x-holding-id: 5652e95e-bb99-48f5-aa1c-13c8c2638fc6

-- Los taxes comunes para México (IVA 16%) suelen ser:
-- - IVA(16%) VENTAS
-- - IVA EXCENTO (si aplica)

-- PASO 4: Actualizar mapeos con el tax correcto
-- ============================================
-- OPCIÓN A: Si solo necesitas IVA 16% (tax_id que corresponda a México)
-- Primero verifica cuál es el tax_id correcto consultando el endpoint

-- Ejemplo si el tax correcto para México es el ID 91:
/*
UPDATE odoo_product_mappings 
SET metadata = jsonb_set(
    COALESCE(metadata, '{}'::jsonb), 
    '{odoo_tax_ids}', 
    '"91"'
)
WHERE holding_id = '5652e95e-bb99-48f5-aa1c-13c8c2638fc6'
  AND sapira_product_id IN (
    '89e1c03c-fa42-4436-9aec-3a60e8cc5095',
    '7ffc00a7-f560-4d69-91ad-46784b52b861'
  );
*/

-- OPCIÓN B: Actualizar todos los mapeos del holding con el tax correcto
/*
UPDATE odoo_product_mappings 
SET metadata = jsonb_set(
    COALESCE(metadata, '{}'::jsonb), 
    '{odoo_tax_ids}', 
    '"91"'  -- Reemplazar con el tax_id correcto de México
)
WHERE holding_id = '5652e95e-bb99-48f5-aa1c-13c8c2638fc6';
*/

-- PASO 5: Verificar los cambios
-- ============================================
SELECT 
    opm.id,
    opm.sapira_product_id,
    p.name as product_name,
    opm.odoo_product_id,
    opm.metadata->>'odoo_tax_ids' as updated_tax_ids,
    opm.updated_at
FROM odoo_product_mappings opm
LEFT JOIN products p ON p.id = opm.sapira_product_id
WHERE opm.holding_id = '5652e95e-bb99-48f5-aa1c-13c8c2638fc6'
ORDER BY opm.updated_at DESC;

-- PASO 6: Restaurar desde backup si algo sale mal
-- ============================================
/*
-- Solo ejecutar si necesitas revertir los cambios
DELETE FROM odoo_product_mappings 
WHERE holding_id = '5652e95e-bb99-48f5-aa1c-13c8c2638fc6';

INSERT INTO odoo_product_mappings 
SELECT * FROM odoo_product_mappings_backup_20260422;
*/

-- ============================================
-- INSTRUCCIONES DE USO:
-- ============================================
-- 1. Ejecuta PASO 1 para ver el problema
-- 2. Ejecuta PASO 2 para crear backup
-- 3. Usa el endpoint GET /odoo/taxes/4?company_id=4 para ver taxes de México
-- 4. Identifica el tax_id correcto (probablemente IVA 16%)
-- 5. Actualiza la query en PASO 4 con el tax_id correcto
-- 6. Ejecuta PASO 4 para corregir los mapeos
-- 7. Ejecuta PASO 5 para verificar
-- 8. Prueba enviar la factura nuevamente

-- NOTAS:
-- - El tax_id 91 es solo un ejemplo, debes verificar el correcto
-- - Para México generalmente se usa IVA(16%) VENTAS
-- - Si necesitas múltiples taxes, usa formato: '"91,92"'
