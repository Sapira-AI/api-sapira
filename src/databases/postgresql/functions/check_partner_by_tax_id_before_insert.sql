
DECLARE
    partner_vat TEXT;
    existing_client_entity RECORD;
    mapping_config JSONB;
    mapping_entry RECORD;
    source_field TEXT;
    target_field TEXT;
    source_value TEXT;
    target_value TEXT;
    has_changes BOOLEAN := FALSE;
    -- Variables para manejo de arrays
    field_name TEXT;
    array_index INTEGER;
    array_value JSONB;
BEGIN
    -- 1. Extracción del VAT
    BEGIN
        partner_vat := (NEW.raw_data::JSONB) ->> 'vat';
    EXCEPTION WHEN OTHERS THEN
        partner_vat := NULL;
    END;
    
    -- 2. Validación de VAT
    IF partner_vat IS NULL OR partner_vat = '' THEN
        NEW.processing_status := 'create';
        NEW.integration_notes := 'Partner sin VAT - marcado para creación';
        RETURN NEW;
    END IF;

    -- 3. Búsqueda por VAT + Odoo ID (identificador único para clientes integrados)
    BEGIN
        SELECT * INTO existing_client_entity
        FROM client_entities 
        WHERE tax_id = partner_vat 
            AND holding_id = NEW.holding_id
            AND odoo_partner_id = NEW.odoo_id;
    EXCEPTION WHEN OTHERS THEN
        existing_client_entity := NULL;
    END;

    -- 4. Si no existe con VAT + Odoo ID, buscar solo por VAT (para clientes creados manualmente)
    IF NOT FOUND THEN
        BEGIN
            SELECT * INTO existing_client_entity
            FROM client_entities 
            WHERE tax_id = partner_vat 
                AND holding_id = NEW.holding_id
                AND (odoo_partner_id IS NULL OR odoo_partner_id = NEW.odoo_id);
        EXCEPTION WHEN OTHERS THEN
            existing_client_entity := NULL;
        END;
        
        -- Si encontramos un cliente sin odoo_partner_id, lo marcamos para update
        -- para que el backend le asigne el odoo_partner_id correcto
        IF FOUND THEN
            NEW.processing_status := 'update';
            NEW.integration_notes := 'Cliente existente sin Odoo ID - marcado para vincular con Odoo';
            RETURN NEW;
        END IF;
    END IF;

    -- 5. Búsqueda final por odoo_partner_id + holding_id (para casos donde el VAT no está mapeado o es incorrecto)
    IF NOT FOUND THEN
        BEGIN
            SELECT * INTO existing_client_entity
            FROM client_entities 
            WHERE odoo_partner_id = NEW.odoo_id
                AND holding_id = NEW.holding_id;
        EXCEPTION WHEN OTHERS THEN
            existing_client_entity := NULL;
        END;
        
        -- Si encontramos el cliente por odoo_partner_id, marcarlo para update
        IF FOUND THEN
            NEW.processing_status := 'update';
            NEW.integration_notes := 'Cliente existente encontrado por Odoo ID - marcado para actualización';
            RETURN NEW;
        END IF;
    END IF;

    -- 6. Si no existe en ninguna búsqueda, marcar para crear
    IF NOT FOUND THEN
        NEW.processing_status := 'create';
        NEW.integration_notes := 'Partner nuevo - marcado para creación';
        RETURN NEW;
    END IF;

    -- 7. Detección de cambios
    BEGIN
        SELECT fm.mapping_config INTO mapping_config
        FROM field_mappings fm
        WHERE fm.holding_id = NEW.holding_id
            AND fm.source_model = 'res.partner'
            AND fm.target_table = 'client_entities'
            AND fm.is_active = true
        ORDER BY fm.created_at DESC
        LIMIT 1;
    EXCEPTION WHEN OTHERS THEN
        mapping_config := NULL;
    END;

    -- Método A: Campos básicos si no hay mapeo
    IF mapping_config IS NULL OR mapping_config->'mappings' IS NULL THEN
        BEGIN
            IF ((NEW.raw_data::JSONB) ->> 'name') IS DISTINCT FROM existing_client_entity.legal_name OR
               ((NEW.raw_data::JSONB) ->> 'email') IS DISTINCT FROM existing_client_entity.email OR
               ((NEW.raw_data::JSONB) ->> 'phone') IS DISTINCT FROM existing_client_entity.phone OR
               ((NEW.raw_data::JSONB) ->> 'street') IS DISTINCT FROM existing_client_entity.legal_address THEN
                has_changes := TRUE;
            END IF;
        EXCEPTION WHEN OTHERS THEN
            has_changes := TRUE;
        END;
    ELSE
        -- Método B: Mapeo configurado con soporte para arrays
        BEGIN
            FOR mapping_entry IN SELECT * FROM jsonb_each(mapping_config->'mappings')
            LOOP
                BEGIN
                    -- Usar 'transformation' que es el campo correcto en el mapeo
                    source_field := COALESCE(
                        mapping_entry.value->>'transformation',
                        (mapping_entry.value->'sourceField'->>'name'),
                        mapping_entry.value->>'source',
                        mapping_entry.value->>'odoo_field'
                    );
                    
                    IF source_field IS NOT NULL THEN
                        -- ✅ MEJORA: Detectar y manejar notación de arrays [índice]
                        BEGIN
                            IF source_field ~ '\[\d+\]$' THEN
                                -- Extraer nombre del campo y el índice con protección
                                field_name := regexp_replace(source_field, '\[\d+\]$', '');
                                array_index := regexp_replace(source_field, '^.*\[(\d+)\]$', '\1')::INTEGER;
                                
                                -- Obtener el array y extraer el elemento en el índice
                                array_value := (NEW.raw_data::JSONB) -> field_name;
                                
                                IF jsonb_typeof(array_value) = 'array' AND jsonb_array_length(array_value) > array_index THEN
                                    source_value := array_value ->> array_index;
                                ELSE
                                    source_value := NULL;
                                END IF;
                            ELSE
                                -- Extracción directa para campos no-array
                                source_value := (NEW.raw_data::JSONB) ->> source_field;
                            END IF;
                        EXCEPTION WHEN OTHERS THEN
                            -- Si falla la extracción, usar NULL
                            source_value := NULL;
                        END;
                        
                        -- Mapear a campos de client_entities
                        CASE mapping_entry.key
                            WHEN 'legal_name' THEN target_value := existing_client_entity.legal_name;
                            WHEN 'tax_id' THEN target_value := existing_client_entity.tax_id;
                            WHEN 'email' THEN target_value := existing_client_entity.email;
                            WHEN 'phone' THEN target_value := existing_client_entity.phone;
                            WHEN 'legal_address' THEN target_value := existing_client_entity.legal_address;
                            WHEN 'country' THEN target_value := existing_client_entity.country;
                            WHEN 'client_number' THEN target_value := existing_client_entity.client_number::TEXT;
                            WHEN 'economic_activity' THEN target_value := existing_client_entity.economic_activity::TEXT;
                            ELSE target_value := NULL;
                        END CASE;
                        
                        IF source_value IS DISTINCT FROM target_value THEN
                            has_changes := TRUE;
                            EXIT;
                        END IF;
                    END IF;
                EXCEPTION WHEN OTHERS THEN
                    -- Si hay error en un campo específico, continuar con el siguiente
                    CONTINUE;
                END;
            END LOOP;
        EXCEPTION WHEN OTHERS THEN
            -- Si hay error general en el loop, asumir que hay cambios
            has_changes := TRUE;
        END;
    END IF;

    -- 8. Establecer estado final
    IF has_changes THEN
        NEW.processing_status := 'update';
        NEW.integration_notes := 'Partner existente con cambios - marcado para actualización';
    ELSE
        NEW.processing_status := 'processed';
        NEW.integration_notes := 'Partner idéntico al existente - marcado como procesado';
    END IF;

    -- ✅ CRÍTICO: SIEMPRE retornar NEW
    RETURN NEW;

-- ✅ PROTECCIÓN FINAL: Si TODO falla, retornar NEW con estado 'error'
EXCEPTION WHEN OTHERS THEN
    NEW.processing_status := 'error';
    NEW.integration_notes := 'Error en trigger: ' || SQLERRM;
    RETURN NEW;  -- ✅ NUNCA retornar NULL
END;
