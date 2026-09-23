CREATE OR REPLACE FUNCTION public.resolve_field_transformation(p_transformation_type transformation_type_enum, p_transformation_config jsonb, p_source_value text, p_holding_id uuid)
 RETURNS text
 LANGUAGE plpgsql
AS $function$
DECLARE
    v_result TEXT;
    v_lookup_table TEXT;
    v_source_column TEXT;
    v_target_column TEXT;
    v_filter_column TEXT;
    v_filter_value TEXT;
    v_value_mappings JSONB;
    v_default_value TEXT;
BEGIN
    -- Transformación directa (sin cambios)
    IF p_transformation_type = 'direct' THEN
        RETURN p_source_value;
    END IF;
    
    -- Mapeo de companies Odoo -> Sapira
    IF p_transformation_type = 'company_mapping' THEN
        SELECT id::TEXT INTO v_result
        FROM companies 
        WHERE odoo_integration_id = p_source_value::INTEGER 
        AND holding_id = p_holding_id;
        
        RETURN COALESCE(v_result, p_source_value);
    END IF;
    
    -- Mapeo de partners Odoo -> client_entities Sapira
    IF p_transformation_type = 'partner_mapping' THEN
        SELECT id::TEXT INTO v_result
        FROM client_entities 
        WHERE odoo_partner_id = p_source_value::INTEGER 
        AND holding_id = p_holding_id;
        
        RETURN COALESCE(v_result, p_source_value);
    END IF;
    
    -- Mapeo de invoices Odoo -> invoices_legacy Sapira
    IF p_transformation_type = 'invoice_mapping' THEN
        SELECT id::TEXT INTO v_result
        FROM invoices_legacy 
        WHERE odoo_integration_id = p_source_value::INTEGER 
        AND holding_id = p_holding_id;
        
        RETURN COALESCE(v_result, p_source_value);
    END IF;
    
    -- NUEVO: Mapeo de valores específicos (value_mapping)
    IF p_transformation_type = 'value_mapping' THEN
        -- Extraer configuración de mapeo
        v_value_mappings := p_transformation_config->'mappings';
        v_default_value := p_transformation_config->>'default_value';
        
        -- Buscar el valor en el mapeo
        v_result := v_value_mappings->>p_source_value;
        
        -- Si no se encuentra, usar valor por defecto o el valor original
        RETURN COALESCE(v_result, v_default_value, p_source_value);
    END IF;
    
    -- Lookup genérico en tabla
    IF p_transformation_type = 'lookup_table' THEN
        v_lookup_table := p_transformation_config->>'table';
        v_source_column := p_transformation_config->>'source_column';
        v_target_column := p_transformation_config->>'target_column';
        v_filter_column := p_transformation_config->>'filter_column';
        v_filter_value := p_transformation_config->>'filter_value';
        
        -- Construir y ejecutar query dinámico
        EXECUTE format(
            'SELECT %I FROM %I WHERE %I = $1 %s LIMIT 1',
            v_target_column,
            v_lookup_table,
            v_source_column,
            CASE 
                WHEN v_filter_column IS NOT NULL THEN 
                    format('AND %I = %L', v_filter_column, v_filter_value)
                ELSE ''
            END
        ) INTO v_result USING p_source_value;
        
        RETURN COALESCE(v_result, p_source_value);
    END IF;
    
    -- Función personalizada (placeholder para futuras extensiones)
    IF p_transformation_type = 'custom_function' THEN
        -- Por ahora retorna el valor original
        RETURN p_source_value;
    END IF;
    
    -- Por defecto, retornar el valor original
    RETURN p_source_value;
END;
$function$;

COMMENT ON FUNCTION public."resolve_field_transformation"(p_transformation_type transformation_type_enum, p_transformation_config jsonb, p_source_value text, p_holding_id uuid) IS 'Función actualizada que incluye soporte para value_mapping. 

Tipos de transformación soportados:
- direct: Mapeo directo sin transformación
- company_mapping: Mapeo de companies Odoo -> Sapira
- partner_mapping: Mapeo de partners Odoo -> client_entities Sapira  
- invoice_mapping: Mapeo de invoices Odoo -> invoices_legacy Sapira
- value_mapping: Mapeo de valores específicos usando tabla de equivalencias
- lookup_table: Lookup genérico en tabla de referencia
- custom_function: Función personalizada (placeholder)

Para value_mapping, la configuración debe tener esta estructura:
{
  "mappings": {
    "not_paid": "Enviada",
    "in_payment": "Enviada", 
    "paid": "Pagada",
    "partial": "Enviada",
    "reversed": "Enviada",
    "invoicing_legacy": "Pagada"
  },
  "default_value": "Enviada"
}';
