CREATE OR REPLACE FUNCTION public.get_invoice_staging_stats(holding_id_param uuid DEFAULT NULL::uuid)
 RETURNS TABLE(total_invoices bigint, pending_invoices bigint, processed_invoices bigint, error_invoices bigint, total_lines bigint, pending_lines bigint, processed_lines bigint, error_lines bigint)
 LANGUAGE plpgsql
AS $function$
BEGIN
    RETURN QUERY
    SELECT 
        -- Estadísticas de facturas
        (SELECT COUNT(*) FROM odoo_invoices_stg 
         WHERE (holding_id_param IS NULL OR holding_id = holding_id_param)) as total_invoices,
        (SELECT COUNT(*) FROM odoo_invoices_stg 
         WHERE processing_status = 'pending' 
         AND (holding_id_param IS NULL OR holding_id = holding_id_param)) as pending_invoices,
        (SELECT COUNT(*) FROM odoo_invoices_stg 
         WHERE processing_status = 'processed' 
         AND (holding_id_param IS NULL OR holding_id = holding_id_param)) as processed_invoices,
        (SELECT COUNT(*) FROM odoo_invoices_stg 
         WHERE processing_status = 'error' 
         AND (holding_id_param IS NULL OR holding_id = holding_id_param)) as error_invoices,
        
        -- Estadísticas de líneas
        (SELECT COUNT(*) FROM odoo_invoice_lines_stg 
         WHERE (holding_id_param IS NULL OR holding_id = holding_id_param)) as total_lines,
        (SELECT COUNT(*) FROM odoo_invoice_lines_stg 
         WHERE processing_status = 'pending' 
         AND (holding_id_param IS NULL OR holding_id = holding_id_param)) as pending_lines,
        (SELECT COUNT(*) FROM odoo_invoice_lines_stg 
         WHERE processing_status = 'processed' 
         AND (holding_id_param IS NULL OR holding_id = holding_id_param)) as processed_lines,
        (SELECT COUNT(*) FROM odoo_invoice_lines_stg 
         WHERE processing_status = 'error' 
         AND (holding_id_param IS NULL OR holding_id = holding_id_param)) as error_lines;
END;
$function$;

COMMENT ON FUNCTION public."get_invoice_staging_stats"(holding_id_param uuid) IS 'Obtiene estadísticas del staging de facturas y líneas por holding';
