CREATE OR REPLACE FUNCTION public.apply_field_transformations_from_frontend(source_data jsonb, holding_id_param uuid, source_model text DEFAULT 'account.move'::text, target_table text DEFAULT 'invoices_legacy'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
DECLARE
    mapping_config JSONB;
    result JSONB;
BEGIN
    -- Obtener configuración de mapeo
    SELECT fm.mapping_config INTO mapping_config
    FROM field_mappings fm
    WHERE fm.holding_id = holding_id_param
    AND fm.source_model = source_model
    AND fm.target_table = target_table
    AND fm.is_active = true
    LIMIT 1;
    
    -- Si no hay configuración, retornar datos originales
    IF mapping_config IS NULL THEN
        RETURN source_data;
    END IF;
    
    -- Aplicar transformaciones usando la función existente
    result := apply_field_mapping_to_data(
        source_data,
        mapping_config,
        target_table,
        holding_id_param
    );
    
    RETURN result;
END;
$function$;

COMMENT ON FUNCTION public."apply_field_transformations_from_frontend"(source_data jsonb, holding_id_param uuid, source_model text, target_table text) IS 'Función helper que permite al frontend usar opcionalmente las transformaciones de base de datos.
El frontend puede seguir usando su lógica actual o migrar gradualmente a usar esta función.';
