CREATE OR REPLACE FUNCTION public.trigger_update_schedule_on_override()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_contract_status TEXT;
BEGIN
  -- Solo para contratos Activo
  SELECT c.status INTO v_contract_status
  FROM contracts c
  JOIN contract_items ci ON ci.contract_id = c.id
  WHERE ci.id = NEW.contract_item_id;

  IF v_contract_status = 'Activo' THEN
    PERFORM update_revenue_schedule_period(NEW.contract_item_id, NEW.period);
    RAISE NOTICE '🔄 Trigger ejecutado para override de item % período %', 
      NEW.contract_item_id, NEW.period;
  ELSE
    RAISE NOTICE '⏭️ Skip: Contrato no está Activo (status=%)', v_contract_status;
  END IF;
  
  RETURN NEW;
END;
$function$

