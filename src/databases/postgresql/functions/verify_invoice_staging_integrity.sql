CREATE OR REPLACE FUNCTION public.verify_invoice_staging_integrity()
 RETURNS TABLE(issue_type text, issue_count bigint, description text)
 LANGUAGE plpgsql
AS $function$
BEGIN
    RETURN QUERY
    -- Líneas huérfanas (sin factura padre)
    SELECT 
        'orphaned_lines'::TEXT as issue_type,
        COUNT(*)::BIGINT as issue_count,
        'Líneas sin factura padre en staging'::TEXT as description
    FROM odoo_invoice_lines_stg oil
    WHERE NOT EXISTS (
        SELECT 1 FROM odoo_invoices_stg oi 
        WHERE oi.id = oil.invoice_staging_id
    )
    
    UNION ALL
    
    -- Inconsistencia de holding_id
    SELECT 
        'holding_mismatch'::TEXT as issue_type,
        COUNT(*)::BIGINT as issue_count,
        'Líneas con holding_id diferente a su factura padre'::TEXT as description
    FROM odoo_invoice_lines_stg oil
    JOIN odoo_invoices_stg oi ON oi.id = oil.invoice_staging_id
    WHERE oil.holding_id != oi.holding_id
    
    UNION ALL
    
    -- Inconsistencia de odoo_invoice_id
    SELECT 
        'odoo_id_mismatch'::TEXT as issue_type,
        COUNT(*)::BIGINT as issue_count,
        'Líneas con odoo_invoice_id diferente a su factura padre'::TEXT as description
    FROM odoo_invoice_lines_stg oil
    JOIN odoo_invoices_stg oi ON oi.id = oil.invoice_staging_id
    WHERE oil.odoo_invoice_id != oi.odoo_id;
END;
$function$

