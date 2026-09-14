CREATE OR REPLACE FUNCTION public.cleanup_duplicate_pending_records(batch_size integer DEFAULT 100)
 RETURNS integer
 LANGUAGE plpgsql
AS $function$
DECLARE
    deleted_count INTEGER := 0;
    current_batch INTEGER;
BEGIN
    -- Eliminar registros pending duplicados (mantener el más reciente)
    LOOP
        DELETE FROM odoo_partners_stg 
        WHERE id IN (
            SELECT s1.id 
            FROM odoo_partners_stg s1
            JOIN (
                SELECT odoo_id, MAX(created_at) as max_created
                FROM odoo_partners_stg 
                WHERE processing_status = 'pending'
                GROUP BY odoo_id
                HAVING COUNT(*) > 1
            ) s2 ON s1.odoo_id = s2.odoo_id
            WHERE s1.processing_status = 'pending'
                AND s1.created_at < s2.max_created
            LIMIT batch_size
        );
        
        GET DIAGNOSTICS current_batch = ROW_COUNT;
        deleted_count := deleted_count + current_batch;
        
        -- Salir si no hay más registros para eliminar
        EXIT WHEN current_batch = 0;
        
        -- Pequeña pausa para evitar saturar la base de datos
        PERFORM pg_sleep(0.1);
    END LOOP;
    
    RETURN deleted_count;
END;
$function$

