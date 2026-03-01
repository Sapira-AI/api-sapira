CREATE OR REPLACE FUNCTION public.trigger_generate_invoices_on_status_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
    v_result RECORD;
    v_existing_invoices_count INTEGER := 0;
BEGIN
    -- Only trigger when status changes to 'Activo'
    IF NEW.status = 'Activo' AND (OLD.status IS NULL OR OLD.status != 'Activo') THEN
        
        -- Verificar si ya existen facturas reales para este contrato
        SELECT COUNT(*) INTO v_existing_invoices_count 
        FROM invoices 
        WHERE contract_id = NEW.id;
        
        IF v_existing_invoices_count > 0 THEN
            RAISE NOTICE '[INVOICE_GEN] Skipping invoice generation for contract % - % invoices already exist', 
                NEW.id, v_existing_invoices_count;
            RETURN NEW;
        END IF;
        
        RAISE NOTICE '[INVOICE_GEN] Contract % changed to Activo, generating invoices', NEW.id;
        
        -- Call the invoice generation function
        SELECT * INTO v_result FROM public.generate_missing_invoices_for_contract(NEW.id);
        
        IF v_result.success THEN
            RAISE NOTICE '[INVOICE_GEN] Successfully generated % invoices for contract %', v_result.generated_count, NEW.id;
        ELSE
            RAISE WARNING '[INVOICE_GEN] Failed to generate invoices for contract %: %', NEW.id, v_result.message;
        END IF;
    END IF;
    
    RETURN NEW;
END;
$function$;
