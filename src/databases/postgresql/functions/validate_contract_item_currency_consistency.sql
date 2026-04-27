CREATE OR REPLACE FUNCTION public.validate_contract_item_currency_consistency()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE v_contract_currency text;
BEGIN
  IF current_setting('sapira.skip_currency_validation', true) = 'on' THEN RETURN NEW; END IF;
  SELECT contract_currency INTO v_contract_currency
  FROM public.contracts WHERE id = NEW.contract_id;
  IF v_contract_currency IS NOT NULL AND NEW.currency IS DISTINCT FROM v_contract_currency THEN
    RAISE EXCEPTION 'Contract item currency (%) must match contract currency (%)', NEW.currency, v_contract_currency;
  END IF;
  RETURN NEW;
END; $function$

