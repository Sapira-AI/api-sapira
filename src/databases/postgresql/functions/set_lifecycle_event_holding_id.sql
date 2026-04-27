CREATE OR REPLACE FUNCTION public.set_lifecycle_event_holding_id()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_holding uuid;
BEGIN
  IF NEW.contract_id IS NULL THEN
    RAISE EXCEPTION 'contract_id es requerido';
  END IF;

  SELECT holding_id INTO v_holding
  FROM public.contracts
  WHERE id = NEW.contract_id;

  IF v_holding IS NULL THEN
    RAISE EXCEPTION 'Contrato % no encontrado o sin holding', NEW.contract_id;
  END IF;

  NEW.holding_id := v_holding;
  RETURN NEW;
END;
$function$

