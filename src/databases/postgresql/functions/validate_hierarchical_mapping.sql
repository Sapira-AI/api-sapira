CREATE OR REPLACE FUNCTION public.validate_hierarchical_mapping(mapping_config jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
AS $function$
BEGIN
    -- Verificar que tenga las secciones requeridas
    IF mapping_config IS NULL THEN
        RETURN FALSE;
    END IF;
    
    -- Debe tener al menos primary_mappings
    IF NOT (mapping_config ? 'primary_mappings') THEN
        RETURN FALSE;
    END IF;
    
    -- Si es jerárquico, debe tener secondary_mappings
    IF (mapping_config ? 'mapping_type') AND 
       (mapping_config ->> 'mapping_type' = 'hierarchical') AND
       NOT (mapping_config ? 'secondary_mappings') THEN
        RETURN FALSE;
    END IF;
    
    -- Verificar que primary_mappings sea un objeto
    IF jsonb_typeof(mapping_config -> 'primary_mappings') != 'object' THEN
        RETURN FALSE;
    END IF;
    
    -- Si existe secondary_mappings, verificar que sea un objeto
    IF (mapping_config ? 'secondary_mappings') AND
       jsonb_typeof(mapping_config -> 'secondary_mappings') != 'object' THEN
        RETURN FALSE;
    END IF;
    
    RETURN TRUE;
END;
$function$

