CREATE OR REPLACE FUNCTION public.validate_contract_currency_consistency()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
BEGIN
  IF current_setting('sapira.skip_currency_validation', true) = 'on' THEN RETURN NEW; END IF;
  IF EXISTS (SELECT 1 FROM public.contract_items ci
    WHERE ci.contract_id = NEW.id AND ci.currency IS DISTINCT FROM NEW.contract_currency) THEN
    RAISE EXCEPTION 'Contract currency (%) must match all contract items currency', NEW.contract_currency;
  END IF;
  RETURN NEW;
END; $function$

