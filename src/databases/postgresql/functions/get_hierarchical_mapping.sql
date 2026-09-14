CREATE OR REPLACE FUNCTION public.get_hierarchical_mapping(holding_id_param uuid, primary_source_model text, secondary_source_model text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
DECLARE
    mapping_record RECORD;
    result JSONB;
BEGIN
    -- Buscar mapeo jerárquico activo
    SELECT * INTO mapping_record
    FROM field_mappings fm
    WHERE fm.holding_id = holding_id_param
        AND fm.source_model = primary_source_model
        AND (secondary_source_model IS NULL OR fm.secondary_source_model = secondary_source_model)
        AND fm.mapping_type = 'hierarchical'
        AND fm.is_active = true
    ORDER BY fm.created_at DESC
    LIMIT 1;
    
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;
    
    -- Construir resultado con metadatos
    result := jsonb_build_object(
        'id', mapping_record.id,
        'mapping_name', mapping_record.mapping_name,
        'primary_source_model', mapping_record.source_model,
        'primary_target_table', mapping_record.target_table,
        'secondary_source_model', mapping_record.secondary_source_model,
        'secondary_target_table', mapping_record.secondary_target_table,
        'mapping_config', mapping_record.mapping_config,
        'created_at', mapping_record.created_at
    );
    
    RETURN result;
END;
$function$

