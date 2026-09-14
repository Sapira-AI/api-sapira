CREATE OR REPLACE FUNCTION public.debug_invoice_trigger()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
    -- Log de entrada al trigger
    INSERT INTO invoice_trigger_debug_logs (
        trigger_name,
        operation,
        holding_id,
        odoo_id,
        raw_data_sample,
        processing_status,
        integration_notes,
        error_message
    ) VALUES (
        'debug_invoice_trigger',
        TG_OP,
        NEW.holding_id,
        NEW.odoo_id,
        jsonb_build_object(
            'name', NEW.raw_data::JSONB ->> 'name',
            'id', NEW.raw_data::JSONB ->> 'id',
            'invoice_date', NEW.raw_data::JSONB ->> 'invoice_date'
        ),
        COALESCE(NEW.processing_status, 'NULL'),
        COALESCE(NEW.integration_notes, 'NULL'),
        'Trigger ejecutado correctamente'
    );
    
    -- SIEMPRE permitir la inserción
    RETURN NEW;
    
EXCEPTION WHEN OTHERS THEN
    -- Log de error
    INSERT INTO invoice_trigger_debug_logs (
        trigger_name,
        operation,
        holding_id,
        odoo_id,
        error_message
    ) VALUES (
        'debug_invoice_trigger',
        TG_OP,
        COALESCE(NEW.holding_id, NULL),
        COALESCE(NEW.odoo_id, 'UNKNOWN'),
        'ERROR: ' || SQLERRM
    );
    
    -- Incluso con errores, permitir inserción
    RETURN NEW;
END;
$function$

