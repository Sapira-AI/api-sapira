CREATE OR REPLACE FUNCTION public.trigger_revenue_schedule_on_invoice_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_contract_id uuid;
  v_contract_status text;
BEGIN
  -- Obtener contract_id
  IF TG_OP = 'DELETE' THEN
    v_contract_id := OLD.contract_id;
  ELSE
    v_contract_id := NEW.contract_id;
  END IF;
  
  -- Solo procesar si la factura está activa
  IF TG_OP = 'INSERT' OR TG_OP = 'UPDATE' THEN
    IF NEW.is_active = false THEN
      RETURN NEW;
    END IF;
  END IF;
  
  -- Verificar que el contrato existe y está ACTIVO
  IF v_contract_id IS NOT NULL THEN
    SELECT status INTO v_contract_status
    FROM contracts
    WHERE id = v_contract_id;
    
    -- Solo recalcular RSM si el contrato está Activo
    IF v_contract_status = 'Activo' THEN
      PERFORM refresh_revenue_schedule_for_contract_safe(v_contract_id);
    ELSE
      RAISE NOTICE '[RSM_TRIGGER] Ignorando contrato % con status %, solo se procesa status Activo', 
        v_contract_id, v_contract_status;
    END IF;
  END IF;
  
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  ELSE
    RETURN NEW;
  END IF;
END;
$function$
