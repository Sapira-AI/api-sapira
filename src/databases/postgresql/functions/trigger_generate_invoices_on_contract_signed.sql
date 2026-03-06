CREATE OR REPLACE FUNCTION public.trigger_generate_invoices_on_contract_signed()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_result RECORD;
  v_existing_invoices_count INTEGER := 0;
BEGIN
  -- Only trigger on status change to 'Firmado' or 'Activo'
  IF NEW.status IN ('Firmado', 'Activo') AND (OLD.status IS NULL OR OLD.status != NEW.status) THEN
    
    -- Verificar si ya existen facturas reales para este contrato
    SELECT COUNT(*) INTO v_existing_invoices_count 
    FROM invoices 
    WHERE contract_id = NEW.id;
    
    IF v_existing_invoices_count > 0 THEN
      RAISE NOTICE '[INVOICE_GEN] Skipping invoice generation for contract % - % invoices already exist', 
        NEW.contract_number, v_existing_invoices_count;
      RETURN NEW;
    END IF;
    
    RAISE NOTICE '[INVOICE_GEN] Contract % status changed to %, generating invoices...', NEW.contract_number, NEW.status;
    
    -- Call the function to generate missing invoices
    SELECT * INTO v_result FROM public.generate_missing_invoices_for_contract(NEW.id);
    
    IF v_result.success THEN
      RAISE NOTICE '[INVOICE_GEN] Successfully generated % invoices for contract %', v_result.generated_count, NEW.contract_number;
    ELSE
      RAISE WARNING '[INVOICE_GEN] Failed to generate invoices for contract %: %', NEW.contract_number, v_result.message;
    END IF;
  END IF;
  
  RETURN NEW;
END;
$function$;
