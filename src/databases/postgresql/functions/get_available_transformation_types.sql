CREATE OR REPLACE FUNCTION public.get_available_transformation_types()
 RETURNS TABLE(transformation_type text, description text, requires_config boolean)
 LANGUAGE plpgsql
AS $function$
BEGIN
    RETURN QUERY
    SELECT 
        unnest(enum_range(NULL::transformation_type_enum))::TEXT as transformation_type,
        CASE unnest(enum_range(NULL::transformation_type_enum))::TEXT
            WHEN 'direct' THEN 'Mapeo directo sin transformación'
            WHEN 'company_mapping' THEN 'Mapeo de companies Odoo -> Sapira'
            WHEN 'partner_mapping' THEN 'Mapeo de partners Odoo -> client_entities Sapira'
            WHEN 'invoice_mapping' THEN 'Mapeo de invoices Odoo -> invoices_legacy Sapira'
            WHEN 'value_mapping' THEN 'Mapeo de valores específicos usando tabla de equivalencias'
            WHEN 'lookup_table' THEN 'Lookup genérico en tabla de referencia'
            WHEN 'custom_function' THEN 'Función personalizada'
            ELSE 'Transformación personalizada'
        END as description,
        CASE unnest(enum_range(NULL::transformation_type_enum))::TEXT
            WHEN 'direct' THEN false
            WHEN 'company_mapping' THEN false
            WHEN 'partner_mapping' THEN false
            WHEN 'invoice_mapping' THEN false
            WHEN 'value_mapping' THEN true
            WHEN 'lookup_table' THEN true
            WHEN 'custom_function' THEN true
            ELSE true
        END as requires_config;
END;
$function$;

COMMENT ON FUNCTION public."get_available_transformation_types"() IS 'Función que retorna todos los tipos de transformación disponibles para que el frontend los pueda mostrar en la UI.
Incluye el nuevo tipo value_mapping junto con los existentes.';
