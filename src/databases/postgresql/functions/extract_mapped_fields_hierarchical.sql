CREATE OR REPLACE FUNCTION public.extract_mapped_fields_hierarchical(mapping_config jsonb, mapping_section text DEFAULT 'primary_mappings'::text)
 RETURNS text[]
 LANGUAGE plpgsql
AS $function$
DECLARE
    fields TEXT[] := ARRAY[]::TEXT[];
    field_key TEXT;
    field_config JSONB;
    source_field_name TEXT;
BEGIN
    -- Verificar que existe la sección solicitada
    IF NOT (mapping_config ? mapping_section) THEN
        RETURN fields;
    END IF;
    
    -- Extraer campos de la sección especificada
    FOR field_key IN SELECT jsonb_object_keys(mapping_config -> mapping_section)
    LOOP
        field_config := mapping_config -> mapping_section -> field_key;
        
        -- Extraer nombre del campo fuente
        IF field_config ? 'sourceField' AND 
           field_config -> 'sourceField' ? 'name' THEN
            source_field_name := field_config -> 'sourceField' ->> 'name';
            
            IF source_field_name IS NOT NULL AND source_field_name != '' THEN
                fields := array_append(fields, source_field_name);
            END IF;
        END IF;
    END LOOP;
    
    RETURN fields;
END;
$function$

