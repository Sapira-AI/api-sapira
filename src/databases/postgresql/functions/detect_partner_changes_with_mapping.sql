CREATE OR REPLACE FUNCTION public.detect_partner_changes_with_mapping(new_data jsonb, old_data jsonb, holding_id_param uuid)
 RETURNS boolean
 LANGUAGE plpgsql
AS $function$
DECLARE
    mapping_config JSONB;
    mapping_entry JSONB;
    source_field TEXT;
BEGIN
    -- Si no hay datos anteriores, siempre hay cambios
    IF old_data IS NULL THEN
        RETURN TRUE;
    END IF;
    
    -- Obtener el mapeo activo para este holding
    SELECT fm.mapping_config INTO mapping_config
    FROM field_mappings fm
    WHERE fm.holding_id = holding_id_param
        AND fm.source_model = 'res.partner'
        AND fm.target_table = 'client_entities'
        AND fm.is_active = true
    ORDER BY fm.created_at DESC
    LIMIT 1;
    
    -- Si no hay mapeo configurado, usar campos básicos
    IF mapping_config IS NULL OR mapping_config->'mappings' IS NULL THEN
        -- Fallback a campos básicos comunes
        IF (new_data ->> 'name') IS DISTINCT FROM (old_data ->> 'name') OR
           (new_data ->> 'email') IS DISTINCT FROM (old_data ->> 'email') OR
           (new_data ->> 'vat') IS DISTINCT FROM (old_data ->> 'vat') THEN
            RETURN TRUE;
        END IF;
        RETURN FALSE;
    END IF;
    
    -- Comparar cada campo mapeado
    FOR mapping_entry IN SELECT * FROM jsonb_each(mapping_config->'mappings')
    LOOP
        -- Extraer el nombre del campo fuente del mapeo
        source_field := mapping_entry.value->>'sourceField'->>'name';
        
        IF source_field IS NOT NULL THEN
            -- Comparar el valor del campo fuente
            IF (new_data ->> source_field) IS DISTINCT FROM (old_data ->> source_field) THEN
                RETURN TRUE;
            END IF;
        END IF;
    END LOOP;
    
    RETURN FALSE;
END;
$function$

