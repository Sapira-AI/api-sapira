CREATE OR REPLACE FUNCTION public.process_partner_staging_to_client_entities(holding_id_param uuid, batch_id_param text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
DECLARE
    partner_record RECORD;
    mapping_config JSONB;
    mapped_data JSONB;
    client_entity_data JSONB;
    result_summary JSONB := '{"processed": 0, "errors": 0, "details": []}'::jsonb;
    error_details JSONB;
    processed_count INTEGER := 0;
    error_count INTEGER := 0;
BEGIN
    -- Obtener configuración de mapeo para partners
    SELECT fm.mapping_config INTO mapping_config
    FROM field_mappings fm
    WHERE fm.holding_id = holding_id_param
    AND fm.source_model = 'res.partner'
    AND fm.target_table = 'client_entities'
    LIMIT 1;
    
    -- Si no hay configuración de mapeo, devolver error
    IF mapping_config IS NULL THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', 'No se encontró configuración de mapeo para res.partner -> client_entities',
            'processed', 0,
            'errors', 0
        );
    END IF;
    
    -- Procesar cada partner pendiente
    FOR partner_record IN 
        SELECT id, odoo_id, raw_data, sync_batch_id
        FROM odoo_partners_stg 
        WHERE holding_id = holding_id_param
        AND processing_status = 'pending'
        AND (batch_id_param IS NULL OR sync_batch_id = batch_id_param)
        ORDER BY created_at
    LOOP
        BEGIN
            -- Aplicar mapeo de campos con el nuevo parámetro holding_id
            mapped_data := apply_field_mapping_to_data(
                partner_record.raw_data,
                mapping_config,
                'client_entities',
                holding_id_param  -- NUEVO PARÁMETRO
            );
            
            -- Agregar campos requeridos
            client_entity_data := mapped_data || jsonb_build_object(
                'holding_id', holding_id_param,
                'odoo_partner_id', partner_record.odoo_id,
                'created_at', NOW(),
                'updated_at', NOW()
            );
            
            -- Insertar o actualizar client_entity
            INSERT INTO client_entities (
                holding_id, odoo_partner_id, legal_name, tax_id, 
                email, phone, address, city, state, country, 
                created_at, updated_at
            )
            SELECT 
                (client_entity_data->>'holding_id')::UUID,
                (client_entity_data->>'odoo_partner_id')::INTEGER,
                client_entity_data->>'legal_name',
                client_entity_data->>'tax_id',
                client_entity_data->>'email',
                client_entity_data->>'phone',
                client_entity_data->>'address',
                client_entity_data->>'city',
                client_entity_data->>'state',
                client_entity_data->>'country'
            WHERE client_entity_data ? 'holding_id' AND client_entity_data ? 'odoo_partner_id'
            ON CONFLICT (holding_id, odoo_partner_id) 
            DO UPDATE SET
                legal_name = EXCLUDED.legal_name,
                tax_id = EXCLUDED.tax_id,
                email = EXCLUDED.email,
                phone = EXCLUDED.phone,
                address = EXCLUDED.address,
                city = EXCLUDED.city,
                state = EXCLUDED.state,
                country = EXCLUDED.country,
                updated_at = NOW();
            
            -- Marcar como procesado
            UPDATE odoo_partners_stg 
            SET processing_status = 'processed', processed_at = NOW()
            WHERE id = partner_record.id;
            
            processed_count := processed_count + 1;
            
        EXCEPTION
            WHEN OTHERS THEN
                -- Marcar como error
                UPDATE odoo_partners_stg 
                SET processing_status = 'error', 
                    error_message = SQLERRM,
                    processed_at = NOW()
                WHERE id = partner_record.id;
                
                error_count := error_count + 1;
                
                -- Agregar detalles del error
                error_details := jsonb_build_object(
                    'partner_id', partner_record.odoo_id,
                    'error', SQLERRM
                );
                
                result_summary := jsonb_set(
                    result_summary,
                    '{details}',
                    (result_summary->'details') || error_details
                );
        END;
    END LOOP;
    
    -- Actualizar resumen
    result_summary := jsonb_set(result_summary, '{processed}', to_jsonb(processed_count));
    result_summary := jsonb_set(result_summary, '{errors}', to_jsonb(error_count));
    result_summary := jsonb_set(result_summary, '{success}', to_jsonb(true));
    
    RETURN result_summary;
END;
$function$;

COMMENT ON FUNCTION public."process_partner_staging_to_client_entities"(holding_id_param uuid, batch_id_param text) IS 'Función actualizada que pasa el holding_id a apply_field_mapping_to_data para soportar transformaciones que requieren contexto de holding.';
