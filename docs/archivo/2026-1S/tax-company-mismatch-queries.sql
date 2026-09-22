-- ============================================
-- QUERIES PARA DEBUGGING: Tax Company Mismatch
-- ============================================
-- Estas queries ayudan a identificar y corregir mapeos de productos
-- con tax_ids que pertenecen a empresas incorrectas en Odoo

-- 1. Ver todos los mapeos de productos con sus tax_ids
-- ============================================
SELECT 
    opm.id,
    opm.holding_id,
    opm.sapira_product_id,
    opm.odoo_product_id,
    opm.metadata->>'odoo_tax_ids' as tax_ids,
    p.name as product_name,
    opm.created_at,
    opm.updated_at
FROM odoo_product_mappings opm
LEFT JOIN products p ON p.id = opm.sapira_product_id
ORDER BY opm.created_at DESC;

-- 2. Identificar mapeos con tax_ids problemáticos (múltiples taxes)
-- ============================================
-- Los tax_ids con muchos valores pueden indicar que están mezclando empresas
SELECT 
    opm.id,
    opm.holding_id,
    opm.sapira_product_id,
    opm.odoo_product_id,
    opm.metadata->>'odoo_tax_ids' as tax_ids,
    array_length(string_to_array(opm.metadata->>'odoo_tax_ids', ','), 1) as tax_count,
    p.name as product_name
FROM odoo_product_mappings opm
LEFT JOIN products p ON p.id = opm.sapira_product_id
WHERE opm.metadata->>'odoo_tax_ids' IS NOT NULL
  AND array_length(string_to_array(opm.metadata->>'odoo_tax_ids', ','), 1) > 3
ORDER BY tax_count DESC;

-- 3. Ver facturas que usan productos con estos mapeos
-- ============================================
SELECT 
    i.id as invoice_id,
    i.invoice_number,
    i.company_id,
    c.legal_name as company_name,
    c.odoo_integration_id as company_odoo_id,
    ii.product_id as sapira_product_id,
    p.name as product_name,
    opm.odoo_product_id,
    opm.metadata->>'odoo_tax_ids' as mapped_tax_ids
FROM invoices i
JOIN invoice_items ii ON ii.invoice_id = i.id
JOIN companies c ON c.id = i.company_id
LEFT JOIN products p ON p.id = ii.product_id
LEFT JOIN odoo_product_mappings opm ON opm.sapira_product_id = ii.product_id 
    AND opm.holding_id = i.holding_id
WHERE i.status = 'Por Emitir'
  AND i.sent_to_odoo_at IS NULL
  AND opm.metadata->>'odoo_tax_ids' IS NOT NULL
ORDER BY i.issue_date DESC;

-- 4. CORRECCIÓN: Limpiar tax_ids de un mapeo específico
-- ============================================
-- Usar esto para corregir un mapeo individual
-- Reemplazar {mapping_id} con el ID del mapeo a corregir
-- Reemplazar {correct_tax_ids} con los tax_ids correctos (ej: '1' o '1,2')

-- Ejemplo para tax único (IVA 19%):
-- UPDATE odoo_product_mappings 
-- SET metadata = jsonb_set(metadata, '{odoo_tax_ids}', '"1"')
-- WHERE id = '{mapping_id}';

-- Ejemplo para múltiples taxes:
-- UPDATE odoo_product_mappings 
-- SET metadata = jsonb_set(metadata, '{odoo_tax_ids}', '"1,2,3"')
-- WHERE id = '{mapping_id}';

-- 5. Ver todos los mapeos de un holding específico
-- ============================================
-- Reemplazar {holding_id} con el ID del holding
/*
SELECT 
    opm.id,
    opm.sapira_product_id,
    p.name as product_name,
    opm.odoo_product_id,
    opm.metadata->>'odoo_tax_ids' as tax_ids
FROM odoo_product_mappings opm
LEFT JOIN products p ON p.id = opm.sapira_product_id
WHERE opm.holding_id = '{holding_id}'
ORDER BY p.name;
*/

-- 6. Backup antes de hacer cambios masivos
-- ============================================
-- Crear tabla temporal con backup de los mapeos
/*
CREATE TABLE odoo_product_mappings_backup AS
SELECT * FROM odoo_product_mappings
WHERE holding_id = '{holding_id}';
*/

-- 7. CORRECCIÓN MASIVA: Establecer tax_id por defecto para todos los mapeos
-- ============================================
-- PRECAUCIÓN: Esto actualizará TODOS los mapeos de un holding
-- Solo usar si estás seguro de que todos deben tener el mismo tax
/*
UPDATE odoo_product_mappings 
SET metadata = jsonb_set(
    COALESCE(metadata, '{}'::jsonb), 
    '{odoo_tax_ids}', 
    '"1"'
)
WHERE holding_id = '{holding_id}';
*/

-- 8. Ver conexiones de Odoo por holding
-- ============================================
SELECT 
    id,
    holding_id,
    url,
    database_name,
    is_active,
    created_at
FROM odoo_connections
WHERE is_active = true
ORDER BY created_at DESC;

-- 9. Ver companies y sus odoo_integration_id
-- ============================================
SELECT 
    id,
    holding_id,
    legal_name,
    odoo_integration_id,
    created_at
FROM companies
WHERE odoo_integration_id IS NOT NULL
ORDER BY holding_id, legal_name;

-- ============================================
-- NOTAS IMPORTANTES:
-- ============================================
-- 1. Los tax_ids deben pertenecer a la misma empresa (company_id) en Odoo
-- 2. Para México (SimpliRoute S.A.P.I DE C.V), los tax_ids comunes son diferentes
--    que para Colombia (SimpliRoute) o Chile (SimpliRoute S.A.)
-- 3. Antes de hacer cambios masivos, SIEMPRE crear un backup
-- 4. Usar los endpoints de validación para verificar antes de guardar:
--    - GET /odoo/taxes/:companyId - Ver taxes disponibles
--    - POST /odoo/validate-invoice-data - Validar antes de enviar
