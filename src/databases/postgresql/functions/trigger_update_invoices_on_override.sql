CREATE OR REPLACE FUNCTION public.trigger_update_invoices_on_override()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_contract_status TEXT;
BEGIN
  -- Solo para contratos Activo (porque solo esos tienen facturas en "Por Emitir")
  SELECT c.status INTO v_contract_status
  FROM contracts c
  JOIN contract_items ci ON ci.contract_id = c.id
  WHERE ci.id = NEW.contract_item_id;

  IF v_contract_status = 'Activo' THEN
    PERFORM update_pending_invoices_on_override(NEW.contract_item_id, NEW.period);
    RAISE NOTICE '🔄 Trigger de actualización de facturas ejecutado para item % período %', 
      NEW.contract_item_id, NEW.period;
  ELSE
    RAISE NOTICE '⏭️ Skip actualización facturas: Contrato no está Activo (status=%)', v_contract_status;
  END IF;

  RETURN NEW;
END;
$function$

