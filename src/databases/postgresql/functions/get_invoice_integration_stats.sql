CREATE OR REPLACE FUNCTION public.get_invoice_integration_stats(holding_id_param uuid, batch_id_param uuid DEFAULT NULL::uuid)
 RETURNS TABLE(total_invoices_in_batch integer, processed_invoices integer, failed_invoices integer, total_lines_in_batch integer, processed_lines integer, failed_lines integer, integration_start_time timestamp without time zone, integration_end_time timestamp without time zone, duration_seconds integer)
 LANGUAGE plpgsql
AS $function$
BEGIN
    RETURN QUERY
    WITH batch_stats AS (
        SELECT 
            COUNT(DISTINCT ois.id) as total_invoices,
            COUNT(DISTINCT CASE WHEN ois.processing_status = 'processed' THEN ois.id END) as proc_invoices,
            COUNT(DISTINCT CASE WHEN ois.processing_status = 'error' THEN ois.id END) as fail_invoices,
            COUNT(oils.id) as total_lines,
            COUNT(CASE WHEN oils.processing_status = 'processed' THEN oils.id END) as proc_lines,
            COUNT(CASE WHEN oils.processing_status = 'error' THEN oils.id END) as fail_lines,
            MIN(ois.created_at) as start_time,
            MAX(COALESCE(ois.last_integrated_at, ois.updated_at)) as end_time
        FROM odoo_invoices_stg ois
        LEFT JOIN odoo_invoice_lines_stg oils ON oils.invoice_staging_id = ois.id
        WHERE ois.holding_id = holding_id_param
            AND (batch_id_param IS NULL OR ois.integration_batch_id = batch_id_param)
    )
    SELECT 
        total_invoices::INTEGER,
        proc_invoices::INTEGER,
        fail_invoices::INTEGER,
        total_lines::INTEGER,
        proc_lines::INTEGER,
        fail_lines::INTEGER,
        start_time,
        end_time,
        COALESCE(EXTRACT(EPOCH FROM (end_time - start_time))::INTEGER, 0)
    FROM batch_stats;
END;
$function$;

COMMENT ON FUNCTION public."get_invoice_integration_stats"(holding_id_param uuid, batch_id_param uuid) IS 'Obtiene estadísticas de integración de facturas por holding y/o lote';
