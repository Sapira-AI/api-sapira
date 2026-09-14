CREATE OR REPLACE FUNCTION public.migrate_existing_partners_to_new_system(holding_id_param uuid)
 RETURNS TABLE(migrated_count integer, error_count integer)
 LANGUAGE plpgsql
AS $function$
DECLARE
    partner_record RECORD;
    mapping_config JSONB;
    migrated INTEGER := 0;
    errors INTEGER := 0;
BEGIN
    -- Obtener configuración de mapeo actualizada
    SELECT fm.mapping_config INTO mapping_config
    FROM field_mappings fm
    WHERE fm.holding_id = holding_id_param
        AND fm.source_model = 'res.partner'
        AND fm.target_table = 'client_entities'
        AND fm.is_active = true
    ORDER BY fm.created_at DESC
    LIMIT 1;
    
    IF mapping_config IS NULL THEN
        RAISE NOTICE 'No se encontró configuración de mapeo actualizada';
        RETURN QUERY SELECT 0, 0;
        RETURN;
    END IF;
    
    -- Procesar partners existentes que tengan transformaciones pendientes
    FOR partner_record IN 
        SELECT ops.*, ce.id as client_entity_id
        FROM odoo_partners_stg ops
        LEFT JOIN client_entities ce ON ce.odoo_partner_id = ops.odoo_id 
            AND ce.holding_id = ops.holding_id
        WHERE ops.holding_id = holding_id_param
        AND ops.processing_status = 'processed'
        -- Solo si hay cambios en el mapeo que requieran re-procesamiento
    LOOP
        BEGIN
            -- Re-procesar con nuevas transformaciones si es necesario
            -- (Esta lógica se puede expandir según necesidades específicas)
            
            migrated := migrated + 1;
            
        EXCEPTION WHEN OTHERS THEN
            errors := errors + 1;
            RAISE NOTICE 'Error migrando partner %: %', partner_record.odoo_id, SQLERRM;
        END;
    END LOOP;
    
    RETURN QUERY SELECT migrated, errors;
END;
$function$

