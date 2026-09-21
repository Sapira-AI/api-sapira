CREATE OR REPLACE FUNCTION public.detect_invoice_line_changes_with_dynamic_mapping(new_data jsonb, existing_line_id uuid, holding_id_param uuid)
 RETURNS boolean
 LANGUAGE plpgsql
AS $function$
DECLARE
    mapping_config JSONB;
    mapping_entry RECORD;
    source_field TEXT;
    target_field TEXT;
    source_value TEXT;
    target_value TEXT;
    has_changes BOOLEAN := FALSE;
    dynamic_sql TEXT;
BEGIN
    -- Obtener configuración de mapeo jerárquico para líneas
    SELECT fm.mapping_config INTO mapping_config
    FROM field_mappings fm
    WHERE fm.holding_id = holding_id_param
        AND fm.source_model = 'account.move'
        AND fm.target_table = 'invoices_legacy'
        AND fm.mapping_type = 'hierarchical'
        AND fm.is_active = true
    ORDER BY fm.created_at DESC
    LIMIT 1;

    -- Si hay mapeo configurado, usar comparación dinámica
    IF mapping_config IS NOT NULL AND mapping_config->'line_mappings' IS NOT NULL THEN
        -- Iterar sobre cada mapeo de línea configurado
        FOR mapping_entry IN SELECT * FROM jsonb_each(mapping_config->'line_mappings')
        LOOP
            -- Extraer campo fuente (Odoo)
            source_field := COALESCE(
                (mapping_entry.value->>'source'),
                (mapping_entry.value->>'odoo_field')
            );
            
            -- Campo destino (invoice_items_legacy)
            target_field := mapping_entry.key;
            
            IF source_field IS NOT NULL AND target_field IS NOT NULL THEN
                -- Obtener valor de Odoo (manejo de campos anidados)
                IF source_field LIKE '%_id' AND source_field != 'name' THEN
                    -- Campos relacionales como product_id (tomar el nombre)
                    source_value := new_data -> source_field ->> 1;
                ELSE
                    -- Campos simples
                    source_value := new_data ->> source_field;
                END IF;
                
                -- Consulta dinámica para obtener valor de invoice_items_legacy
                BEGIN
                    dynamic_sql := format(
                        'SELECT %I FROM invoice_items_legacy WHERE id = $1',
                        target_field
                    );
                    
                    EXECUTE dynamic_sql INTO target_value USING existing_line_id;
                    
                EXCEPTION WHEN OTHERS THEN
                    target_value := NULL;
                    RAISE NOTICE 'Error accediendo campo %: %', target_field, SQLERRM;
                END;
                
                -- Comparar valores
                IF source_value IS DISTINCT FROM target_value THEN
                    has_changes := TRUE;
                    RAISE NOTICE 'Cambio detectado en línea %: % -> %', target_field, target_value, source_value;
                    EXIT; -- Salir del loop si encuentra cambios
                END IF;
            END IF;
        END LOOP;
        
        -- Siempre comparar odoo_line_id (crítico)
        BEGIN
            EXECUTE 'SELECT odoo_line_id FROM invoice_items_legacy WHERE id = $1' 
            INTO target_value USING existing_line_id;
            
            IF (new_data ->> 'id') IS DISTINCT FROM target_value THEN
                has_changes := TRUE;
                RAISE NOTICE 'Cambio detectado en odoo_line_id';
            END IF;
        EXCEPTION WHEN OTHERS THEN
            has_changes := TRUE;
        END;
        
    ELSE
        -- FALLBACK: Si no hay mapeo, usar comparación básica de campos críticos
        BEGIN
            SELECT 
                CASE 
                    WHEN (new_data ->> 'name') IS DISTINCT FROM iil.description OR
                         (new_data ->> 'quantity') IS DISTINCT FROM iil.quantity::TEXT OR
                         (new_data ->> 'price_unit') IS DISTINCT FROM iil.unit_price::TEXT OR
                         (new_data ->> 'price_subtotal') IS DISTINCT FROM iil.subtotal::TEXT OR
                         (new_data -> 'product_id' ->> 1) IS DISTINCT FROM iil.product_name OR
                         (new_data ->> 'id') IS DISTINCT FROM iil.odoo_line_id
                    THEN TRUE
                    ELSE FALSE
                END
            INTO has_changes
            FROM invoice_items_legacy iil
            WHERE iil.id = existing_line_id;
            
        EXCEPTION WHEN OTHERS THEN
            has_changes := TRUE;
        END;
    END IF;

    RETURN has_changes;
    
EXCEPTION WHEN OTHERS THEN
    -- Si hay error, asumir que hay cambios
    RAISE NOTICE 'Error en detect_invoice_line_changes_with_dynamic_mapping: %', SQLERRM;
    RETURN TRUE;
END;
$function$

