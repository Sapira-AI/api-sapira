
DECLARE
    line_name TEXT;
    existing_line RECORD;
    has_changes BOOLEAN := FALSE;
    parent_invoice_id UUID;
BEGIN
    -- ✅ REGLA: SIEMPRE permitir la inserción
    
    -- Extraer identificadores únicos de la línea
    BEGIN
        line_name := (NEW.raw_data::JSONB) ->> 'name';
        
        -- Si no hay name, usar display_name como fallback
        IF line_name IS NULL OR line_name = '' THEN
            line_name := (NEW.raw_data::JSONB) ->> 'display_name';
        END IF;
        
    EXCEPTION WHEN OTHERS THEN
        line_name := NULL;
    END;
    
    -- Si no hay identificadores únicos, marcar como CREATE
    IF line_name IS NULL OR line_name = '' THEN
        NEW.processing_status := 'create';
        NEW.integration_notes := 'Línea sin identificadores únicos - marcada para creación';
        RETURN NEW;
    END IF;

    -- Buscar la factura padre en invoices_legacy para vincular líneas
    BEGIN
        SELECT id INTO parent_invoice_id
        FROM invoices_legacy 
        WHERE holding_id = NEW.holding_id
            AND odoo_integration_id = (NEW.raw_data::JSONB -> 'move_id' ->> 0)::TEXT;
    EXCEPTION WHEN OTHERS THEN
        parent_invoice_id := NULL;
    END;

    -- Si no existe la factura padre, marcar como CREATE (se procesará cuando exista la factura)
    IF parent_invoice_id IS NULL THEN
        NEW.processing_status := 'create';
        NEW.integration_notes := 'Línea nueva (factura padre no encontrada) - marcada para creación';
        RETURN NEW;
    END IF;

    -- Búsqueda de línea existente por odoo_line_id y factura padre
    BEGIN
        SELECT * INTO existing_line
        FROM invoice_items_legacy 
        WHERE invoices_legacy_id = parent_invoice_id
            AND odoo_line_id = (NEW.raw_data::JSONB ->> 'id');
        
    EXCEPTION WHEN OTHERS THEN
        existing_line := NULL;
    END;

    -- Si no existe, marcar como CREATE
    IF existing_line IS NULL THEN
        NEW.processing_status := 'create';
        NEW.integration_notes := 'Línea nueva - marcada para creación';
        RETURN NEW;
    END IF;

    -- ✅ COMPARACIÓN DINÁMICA USANDO MAPEO
    BEGIN
        has_changes := detect_invoice_line_changes_with_dynamic_mapping(
            NEW.raw_data::JSONB,
            existing_line.id,
            NEW.holding_id
        );
        
    EXCEPTION WHEN OTHERS THEN
        has_changes := TRUE;
        NEW.integration_notes := 'Error en comparación dinámica: ' || SQLERRM;
    END;

    -- Determinar estado final
    IF has_changes THEN
        NEW.processing_status := 'update';
        IF NEW.integration_notes IS NULL THEN
            NEW.integration_notes := 'Línea existente con cambios - marcada para actualización';
        END IF;
    ELSE
        NEW.processing_status := 'processed';
        NEW.integration_notes := 'Línea idéntica a la existente - marcada como procesada';
    END IF;

    -- ✅ SIEMPRE retornar NEW (nunca rechazar)
    RETURN NEW;
    
EXCEPTION WHEN OTHERS THEN
    -- ✅ Incluso con errores, SIEMPRE insertar
    NEW.processing_status := 'error';
    NEW.integration_notes := 'Error general en trigger: ' || SQLERRM;
    RETURN NEW;
END;
