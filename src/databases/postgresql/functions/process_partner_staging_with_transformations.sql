CREATE OR REPLACE FUNCTION public.process_partner_staging_with_transformations(staging_ids uuid[] DEFAULT NULL::uuid[], holding_id_param uuid DEFAULT NULL::uuid)
 RETURNS TABLE(processed_count integer, error_count integer, details jsonb)
 LANGUAGE plpgsql
AS $function$
DECLARE
    staging_record RECORD;
    mapping_config JSONB;
    mapped_data JSONB;
    processed INTEGER := 0;
    errors INTEGER := 0;
    result_details JSONB := '[]';
    detail_entry JSONB;
BEGIN
    -- Obtener configuración de mapeo
    SELECT fm.mapping_config INTO mapping_config
    FROM field_mappings fm
    WHERE fm.holding_id = holding_id_param
        AND fm.source_model = 'res.partner'
        AND fm.target_table = 'client_entities'
        AND fm.is_active = true
    ORDER BY fm.created_at DESC
    LIMIT 1;
    
    -- Si no hay mapeo, usar configuración básica
    IF mapping_config IS NULL THEN
        RAISE NOTICE 'No se encontró configuración de mapeo para holding %', holding_id_param;
        RETURN QUERY SELECT 0, 0, '[]'::JSONB;
        RETURN;
    END IF;
    
    -- Procesar registros staging
    FOR staging_record IN 
        SELECT * FROM odoo_partners_stg 
        WHERE (staging_ids IS NULL OR id = ANY(staging_ids))
        AND (holding_id_param IS NULL OR holding_id = holding_id_param)
        AND processing_status = 'pending'
    LOOP
        BEGIN
            -- Aplicar mapeo con transformaciones
            SELECT apply_partner_mapping_with_transformations(
                staging_record.raw_data,
                mapping_config,
                staging_record.holding_id
            ) INTO mapped_data;
            
            -- Agregar metadatos
            mapped_data := mapped_data || jsonb_build_object(
                'holding_id', staging_record.holding_id,
                'odoo_partner_id', staging_record.odoo_id,
                'sync_batch_id', staging_record.sync_batch_id,
                'created_at', NOW(),
                'updated_at', NOW()
            );
            
            -- Insertar en tabla destino
            INSERT INTO client_entities 
            SELECT * FROM jsonb_populate_record(null::client_entities, mapped_data)
            ON CONFLICT (odoo_partner_id, holding_id) 
            DO UPDATE SET
                updated_at = NOW(),
                sync_batch_id = EXCLUDED.sync_batch_id;
            
            -- Marcar como procesado
            UPDATE odoo_partners_stg 
            SET 
                processing_status = 'processed',
                processed_at = NOW()
            WHERE id = staging_record.id;
            
            processed := processed + 1;
            
            -- Agregar detalle de éxito
            detail_entry := jsonb_build_object(
                'id', staging_record.id,
                'odoo_id', staging_record.odoo_id,
                'status', 'success'
            );
            result_details := result_details || detail_entry;
            
        EXCEPTION WHEN OTHERS THEN
            -- Marcar como error
            UPDATE odoo_partners_stg 
            SET 
                processing_status = 'error',
                error_message = SQLERRM,
                processed_at = NOW()
            WHERE id = staging_record.id;
            
            errors := errors + 1;
            
            -- Agregar detalle de error
            detail_entry := jsonb_build_object(
                'id', staging_record.id,
                'odoo_id', staging_record.odoo_id,
                'status', 'error',
                'message', SQLERRM
            );
            result_details := result_details || detail_entry;
            
            RAISE NOTICE 'Error procesando partner %: %', staging_record.odoo_id, SQLERRM;
        END;
    END LOOP;
    
    RETURN QUERY SELECT processed, errors, result_details;
END;
$function$;

COMMENT ON FUNCTION public."process_partner_staging_with_transformations"(staging_ids uuid[], holding_id_param uuid) IS 'Procesa partners desde staging usando el nuevo sistema de transformaciones';
