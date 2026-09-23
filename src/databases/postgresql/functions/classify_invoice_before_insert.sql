CREATE OR REPLACE FUNCTION public.classify_invoice_before_insert()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
    invoice_name TEXT;
    invoice_number TEXT;
    existing_invoice RECORD;
    has_changes BOOLEAN := FALSE;
BEGIN
    -- ✅ REGLA: SIEMPRE permitir la inserción
    
    -- Extraer identificadores únicos de la factura
    BEGIN
        invoice_name := (NEW.raw_data::JSONB) ->> 'name';
        invoice_number := (NEW.raw_data::JSONB) ->> 'invoice_number';
        
        -- Si no hay name, usar display_name como fallback
        IF invoice_name IS NULL OR invoice_name = '' THEN
            invoice_name := (NEW.raw_data::JSONB) ->> 'display_name';
        END IF;
        
    EXCEPTION WHEN OTHERS THEN
        invoice_name := NULL;
        invoice_number := NULL;
    END;
    
    -- Si no hay identificadores únicos, marcar como CREATE
    IF (invoice_name IS NULL OR invoice_name = '') AND (invoice_number IS NULL OR invoice_number = '') THEN
        NEW.processing_status := 'create';
        NEW.integration_notes := 'Factura sin identificadores únicos - marcada para creación';
        RETURN NEW;
    END IF;

    -- Búsqueda de factura existente por name o invoice_number
    BEGIN
        SELECT * INTO existing_invoice
        FROM invoices_legacy 
        WHERE holding_id = NEW.holding_id
            AND (
                invoice_number = COALESCE(invoice_number, invoice_name) OR
                invoice_number = invoice_name OR
                odoo_integration_id = (NEW.raw_data::JSONB ->> 'id')
            );
        
    EXCEPTION WHEN OTHERS THEN
        existing_invoice := NULL;
    END;

    -- Si no existe, marcar como CREATE
    IF existing_invoice IS NULL THEN
        NEW.processing_status := 'create';
        NEW.integration_notes := 'Factura nueva - marcada para creación';
        RETURN NEW;
    END IF;

    -- ✅ COMPARACIÓN DINÁMICA USANDO MAPEO
    BEGIN
        has_changes := detect_invoice_changes_with_dynamic_mapping(
            NEW.raw_data::JSONB,
            existing_invoice.id,
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
            NEW.integration_notes := 'Factura existente con cambios - marcada para actualización';
        END IF;
    ELSE
        NEW.processing_status := 'processed';
        NEW.integration_notes := 'Factura idéntica a la existente - marcada como procesada';
    END IF;

    -- ✅ SIEMPRE retornar NEW (nunca rechazar)
    RETURN NEW;
    
EXCEPTION WHEN OTHERS THEN
    -- ✅ Incluso con errores, SIEMPRE insertar
    NEW.processing_status := 'error';
    NEW.integration_notes := 'Error general en trigger: ' || SQLERRM;
    RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public."classify_invoice_before_insert"() IS 'Clasifica facturas como create/update/processed basado en existencia y cambios detectados.';
