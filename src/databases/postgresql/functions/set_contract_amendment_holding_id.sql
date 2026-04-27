CREATE OR REPLACE FUNCTION public.set_contract_amendment_holding_id()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.holding_id IS NULL THEN
    SELECT holding_id INTO NEW.holding_id
    FROM public.contracts
    WHERE id = NEW.contract_id;
  END IF;
  RETURN NEW;
END;
$function$

