CREATE OR REPLACE FUNCTION public.detect_partner_changes(new_data jsonb, old_data jsonb, holding_id_param uuid)
 RETURNS boolean
 LANGUAGE plpgsql
AS $function$
DECLARE
    mapping_config JSONB;
    mapping_entry RECORD;
    source_field TEXT;
    new_value TEXT;
    old_value TEXT;
BEGIN
    -- Si no hay datos anteriores, es un cambio
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
    
    -- Comparar cada campo mapeado (compatible con nuevo formato)
    FOR mapping_entry IN SELECT * FROM jsonb_each(mapping_config->'mappings')
    LOOP
        -- Extraer el nombre del campo fuente del mapeo (compatible con ambos formatos)
        source_field := COALESCE(
            mapping_entry.value->>'sourceField'->>'name',  -- Formato antiguo
            mapping_entry.value->>'odoo_field'             -- Formato nuevo
        );
        
        IF source_field IS NOT NULL THEN
            -- Obtener valores para comparar
            new_value := new_data ->> source_field;
            old_value := old_data ->> source_field;
            
            -- Si hay diferencia, es un cambio
            IF new_value IS DISTINCT FROM old_value THEN
                RETURN TRUE;
            END IF;
        END IF;
    END LOOP;
    
    -- No se detectaron cambios
    RETURN FALSE;
END;
$function$;

CREATE OR REPLACE FUNCTION public.detect_partner_changes(new_data jsonb, old_data jsonb, relevant_fields text[] DEFAULT ARRAY['name'::text, 'email'::text, 'vat'::text])
 RETURNS boolean
 LANGUAGE plpgsql
AS $function$
DECLARE
    field TEXT;
BEGIN
    -- Si no hay datos anteriores, siempre hay cambios
    IF old_data IS NULL THEN
        RETURN TRUE;
    END IF;
    
    -- Comparar cada campo relevante
    FOREACH field IN ARRAY relevant_fields
    LOOP
        IF (new_data ->> field) IS DISTINCT FROM (old_data ->> field) THEN
            RETURN TRUE;
        END IF;
    END LOOP;
    
    RETURN FALSE;
END;
$function$;

COMMENT ON FUNCTION public."detect_partner_changes"(new_data jsonb, old_data jsonb, holding_id_param uuid) IS 'Función para detectar cambios en partners, compatible con formato antiguo y nuevo de mapeos. Versión limpia sin conflictos.';
COMMENT ON FUNCTION public."detect_partner_changes"(new_data jsonb, old_data jsonb, relevant_fields text[]) IS 'Función de compatibilidad para detectar cambios con campos específicos';
