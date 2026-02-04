
DECLARE
    result JSONB := '{}'::jsonb;
    mapping_entry JSONB;
    field_key TEXT;
    source_field TEXT;
    target_field TEXT;
    source_value TEXT;
    transformation_type TEXT;
    transformation_config JSONB;
    odoo_field TEXT;
    final_value TEXT;
    array_value JSONB;
    array_index INTEGER;
BEGIN
    -- Si no hay mapeo, retornar objeto vacío
    IF mapping_config IS NULL THEN
        RETURN result;
    END IF;
    
    -- Procesar cada mapeo
    FOR field_key IN SELECT jsonb_object_keys(mapping_config)
    LOOP
        mapping_entry := mapping_config -> field_key;
        
        -- Extraer configuración del mapeo (nuevo formato)
        odoo_field := mapping_entry ->> 'odoo_field';
        transformation_type := mapping_entry ->> 'transformation_type';
        transformation_config := mapping_entry -> 'transformation_config';
        target_field := field_key;
        
        -- Si no hay odoo_field, saltar
        IF odoo_field IS NULL OR odoo_field = '' THEN
            CONTINUE;
        END IF;
        
        -- Manejar arrays (ej: company_id[0])
        IF odoo_field LIKE '%[%]%' THEN
            -- Extraer nombre del campo y índice del array
            source_field := split_part(odoo_field, '[', 1);
            array_index := split_part(split_part(odoo_field, '[', 2), ']', 1)::INTEGER;
            
            -- Obtener el array del source_data
            array_value := source_data -> source_field;
            
            -- Extraer el valor del índice específico
            IF jsonb_typeof(array_value) = 'array' AND jsonb_array_length(array_value) > array_index THEN
                source_value := array_value -> array_index ->> 0; -- Primer elemento si es array de arrays
                IF source_value IS NULL THEN
                    source_value := array_value ->> array_index; -- Valor directo si es array simple
                END IF;
            END IF;
        ELSE
            -- Campo directo
            source_value := source_data ->> odoo_field;
        END IF;
        
        -- Aplicar transformaciones usando la función centralizada
        final_value := source_value;
        
        IF transformation_type IS NOT NULL AND source_value IS NOT NULL THEN
            -- Usar la función centralizada resolve_field_transformation
            BEGIN
                final_value := resolve_field_transformation(
                    transformation_type::transformation_type_enum,
                    transformation_config,
                    source_value,
                    holding_id_param
                );
            EXCEPTION
                WHEN OTHERS THEN
                    -- En caso de error, usar el valor original y loggear
                    RAISE NOTICE 'Error en transformación % para valor %: %', transformation_type, source_value, SQLERRM;
                    final_value := source_value;
            END;
        END IF;
        
        -- CORRECCIÓN CRÍTICA: Usar target_field directamente SIN agregar prefijos adicionales
        -- Esto evita la duplicación de prefijos (invoice_amount_invoice_currency)
        IF final_value IS NOT NULL THEN
            result := result || jsonb_build_object(target_field, final_value);
        END IF;
    END LOOP;
    
    RETURN result;
END;
