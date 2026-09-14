CREATE OR REPLACE FUNCTION public.apply_partner_mapping_with_transformations(raw_data jsonb, mapping_config jsonb, holding_id_param uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
DECLARE
    result JSONB := '{}';
    mapping_entry RECORD;
    source_field TEXT;
    target_field TEXT;
    source_value TEXT;
    transformed_value TEXT;
    transformation_type TEXT;
    transformation_config JSONB;
BEGIN
    -- Si no hay configuración de mapeo, devolver objeto vacío
    IF mapping_config IS NULL OR mapping_config->'mappings' IS NULL THEN
        RETURN result;
    END IF;
    
    -- Procesar cada mapeo
    FOR mapping_entry IN SELECT * FROM jsonb_each(mapping_config->'mappings')
    LOOP
        -- Extraer información del mapeo (compatible con ambos formatos)
        source_field := COALESCE(
            mapping_entry.value->>'sourceField'->>'name',  -- Formato antiguo
            mapping_entry.value->>'odoo_field'             -- Formato nuevo
        );
        
        target_field := COALESCE(
            mapping_entry.value->>'targetField'->>'name',  -- Formato antiguo
            mapping_entry.value->>'sapira_field'           -- Formato nuevo
        );
        
        transformation_type := COALESCE(
            mapping_entry.value->>'transformation_type',
            'direct'  -- Por defecto, transformación directa
        );
        
        transformation_config := mapping_entry.value->'transformation_config';
        
        -- Continuar solo si tenemos campos válidos
        IF source_field IS NOT NULL AND target_field IS NOT NULL THEN
            -- Obtener valor del campo fuente
            source_value := raw_data ->> source_field;
            
            -- Aplicar transformación
            SELECT resolve_field_transformation(
                transformation_type::transformation_type_enum,
                transformation_config,
                source_value,
                holding_id_param
            ) INTO transformed_value;
            
            -- Agregar al resultado
            result := jsonb_set(result, ARRAY[target_field], to_jsonb(transformed_value));
        END IF;
    END LOOP;
    
    RETURN result;
END;
$function$

