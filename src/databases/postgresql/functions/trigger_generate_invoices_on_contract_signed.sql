CREATE OR REPLACE FUNCTION public.trigger_generate_invoices_on_contract_signed()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
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

COMMENT ON FUNCTION public."trigger_generate_invoices_on_contract_signed"() IS 'Generador legacy UNIFICADO (30-09-2026, decisión #9): único trigger de generación de facturas del front viejo (unified_generate_invoices_on_contract_signed, AFTER INSERT OR UPDATE OF status). Genera con generate_missing_invoices_for_contract al insertar o pasar a Firmado/Activo si el contrato no tiene facturas. Absorbe a trigger_generate_invoices_on_status_change (su trigger generate_invoices_on_contract_active se elimina por migración): de ahí el SECURITY DEFINER, para seguir llamando a generate_missing_invoices_for_contract cuando se le quite el EXECUTE a authenticated. Con sapira.writer = api (activación v2) no hace nada: la API ya creó las facturas.';
