CREATE OR REPLACE FUNCTION public.verify_hierarchical_mapping_extension()
 RETURNS TABLE(check_name text, status boolean, details text)
 LANGUAGE plpgsql
AS $function$
BEGIN
    RETURN QUERY
    -- Verificar que las columnas existen
    SELECT 
        'mapping_type_column'::TEXT as check_name,
        EXISTS(
            SELECT 1 FROM information_schema.columns 
            WHERE table_name = 'field_mappings' 
            AND column_name = 'mapping_type'
        ) as status,
        'Columna mapping_type agregada'::TEXT as details
    
    UNION ALL
    
    SELECT 
        'secondary_source_model_column'::TEXT as check_name,
        EXISTS(
            SELECT 1 FROM information_schema.columns 
            WHERE table_name = 'field_mappings' 
            AND column_name = 'secondary_source_model'
        ) as status,
        'Columna secondary_source_model agregada'::TEXT as details
    
    UNION ALL
    
    SELECT 
        'secondary_target_table_column'::TEXT as check_name,
        EXISTS(
            SELECT 1 FROM information_schema.columns 
            WHERE table_name = 'field_mappings' 
            AND column_name = 'secondary_target_table'
        ) as status,
        'Columna secondary_target_table agregada'::TEXT as details
    
    UNION ALL
    
    -- Verificar que los índices existen
    SELECT 
        'hierarchical_indexes'::TEXT as check_name,
        EXISTS(
            SELECT 1 FROM pg_indexes 
            WHERE tablename = 'field_mappings' 
            AND indexname = 'idx_field_mappings_hierarchical'
        ) as status,
        'Índices jerárquicos creados'::TEXT as details
    
    UNION ALL
    
    -- Verificar que las funciones existen
    SELECT 
        'hierarchical_functions'::TEXT as check_name,
        EXISTS(
            SELECT 1 FROM pg_proc 
            WHERE proname = 'get_hierarchical_mapping'
        ) as status,
        'Funciones jerárquicas creadas'::TEXT as details;
END;
$function$

