CREATE OR REPLACE FUNCTION public.cleanup_duplicate_partners_by_vat(holding_id_param uuid, batch_size integer DEFAULT 100)
 RETURNS integer
 LANGUAGE plpgsql
AS $function$
DECLARE
    deleted_count INTEGER := 0;
    current_batch INTEGER;
BEGIN
    -- Eliminar registros duplicados por VAT (mantener el más reciente)
    LOOP
        DELETE FROM odoo_partners_stg 
        WHERE id IN (
            SELECT s1.id 
            FROM odoo_partners_stg s1
            JOIN (
                SELECT raw_data ->> 'vat' as vat, MAX(created_at) as max_created
                FROM odoo_partners_stg 
                WHERE holding_id = holding_id_param
                    AND processing_status IN ('create', 'update')
                    AND raw_data ->> 'vat' IS NOT NULL
                GROUP BY raw_data ->> 'vat'
                HAVING COUNT(*) > 1
            ) s2 ON s1.raw_data ->> 'vat' = s2.vat
            WHERE s1.holding_id = holding_id_param
                AND s1.processing_status IN ('create', 'update')
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

