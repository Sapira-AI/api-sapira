CREATE OR REPLACE FUNCTION public.cleanup_old_processed_records(days_old integer DEFAULT 30, batch_size integer DEFAULT 100)
 RETURNS integer
 LANGUAGE plpgsql
AS $function$
DECLARE
    deleted_count INTEGER := 0;
    current_batch INTEGER;
BEGIN
    -- Eliminar registros procesados antiguos en lotes
    LOOP
        DELETE FROM odoo_partners_stg 
        WHERE id IN (
            SELECT id 
            FROM odoo_partners_stg
            WHERE processing_status = 'processed'
                AND last_integrated_at < NOW() - INTERVAL '1 day' * days_old
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

