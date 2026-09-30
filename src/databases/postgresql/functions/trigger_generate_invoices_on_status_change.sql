CREATE OR REPLACE FUNCTION public.trigger_generate_invoices_on_status_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
    v_result RECORD;
    v_existing_invoices_count INTEGER := 0;
BEGIN
  -- Costura sapira.writer: en una transacción de la API (v2) este trigger no hace nada; la API escribe cada campo.
  -- El front viejo nunca fija la marca: para él el trigger sigue igual. Regla: docs/reglas-desarrollo/logica-en-api-triggers.md
  IF current_setting('sapira.writer', true) = 'api' THEN
    RETURN NULL;  -- AFTER: el valor de retorno se ignora
  END IF;

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

COMMENT ON FUNCTION public."trigger_generate_invoices_on_status_change"() IS 'RETIRADA DEL USO (30-09-2026): su trigger generate_invoices_on_contract_active se elimina por migración (1790660000000) y la generación legacy queda unificada en trigger_generate_invoices_on_contract_signed. Queda sin trigger, con la costura sapira.writer, hasta su DROP FUNCTION en la baja (doble confirmación).';
