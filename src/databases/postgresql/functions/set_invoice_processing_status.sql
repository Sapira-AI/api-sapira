
DECLARE
    invoice_number_from_odoo TEXT;
    existing_invoice RECORD;
    has_changes BOOLEAN := FALSE;
BEGIN
    -- Extraer invoice_number de los datos de Odoo
    BEGIN
        -- Intentar obtener invoice_number, si no existe usar name como fallback
        invoice_number_from_odoo := NEW.raw_data ->> 'invoice_number';
        IF invoice_number_from_odoo IS NULL OR invoice_number_from_odoo = '' THEN
            invoice_number_from_odoo := NEW.raw_data ->> 'name';
        END IF;
    EXCEPTION WHEN OTHERS THEN
        invoice_number_from_odoo := NULL;
    END;
    
    -- Si no hay invoice_number, marcar como create
    IF invoice_number_from_odoo IS NULL OR invoice_number_from_odoo = '' THEN
        NEW.processing_status := 'create';
        NEW.integration_notes := 'Sin invoice_number - marcada para creación';
        RETURN NEW;
    END IF;
    
    -- Buscar factura existente por invoice_number en invoices_legacy
    BEGIN
        SELECT * INTO existing_invoice
        FROM invoices_legacy 
        WHERE holding_id = NEW.holding_id
            AND invoice_number = invoice_number_from_odoo
        LIMIT 1;
    EXCEPTION WHEN OTHERS THEN
        existing_invoice := NULL;
    END;
    
    -- Si no existe factura, marcar como create
    IF existing_invoice IS NULL THEN
        NEW.processing_status := 'create';
        NEW.integration_notes := format('Factura nueva (invoice_number: %s) - marcada para creación', invoice_number_from_odoo);
        RETURN NEW;
    END IF;
    
    -- Factura existe - comparar campos mapeados
    BEGIN
        has_changes := compare_mapped_invoice_fields(
            NEW.raw_data,
            existing_invoice.id,
            NEW.holding_id
        );
    EXCEPTION WHEN OTHERS THEN
        -- En caso de error en comparación, asumir cambios
        has_changes := TRUE;
        NEW.integration_notes := 'Error en comparación de campos: ' || SQLERRM;
    END;
    
    -- Determinar estado final basado en cambios
    IF has_changes THEN
        NEW.processing_status := 'update';
        NEW.integration_notes := format('Factura existente (invoice_number: %s) con cambios - marcada para actualización', invoice_number_from_odoo);
    ELSE
        NEW.processing_status := 'processed';
        NEW.integration_notes := format('Factura existente (invoice_number: %s) sin cambios - marcada como procesada', invoice_number_from_odoo);
    END IF;
    
    RETURN NEW;
    
EXCEPTION WHEN OTHERS THEN
    -- En caso de cualquier error, permitir inserción pero marcar como error
    NEW.processing_status := 'error';
    NEW.integration_notes := 'Error en trigger de clasificación: ' || SQLERRM;
    RETURN NEW;
END;
