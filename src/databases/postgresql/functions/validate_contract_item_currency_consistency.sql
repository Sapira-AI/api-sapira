CREATE OR REPLACE FUNCTION public.validate_contract_item_currency_consistency()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE v_contract_currency text; v_multicurrency boolean;
BEGIN
  IF current_setting('sapira.skip_currency_validation', true) = 'on' THEN RETURN NEW; END IF;
  -- Multimoneda (spec-multimoneda-contrato §3 #2): un ítem en otra moneda solo con contracts.requires_multicurrency_billing.
  SELECT contract_currency, COALESCE(requires_multicurrency_billing, false) INTO v_contract_currency, v_multicurrency
  FROM public.contracts WHERE id = NEW.contract_id;
  IF v_contract_currency IS NOT NULL AND NEW.currency IS DISTINCT FROM v_contract_currency AND NOT v_multicurrency THEN
    RAISE EXCEPTION 'Contract item currency (%) must match contract currency (%)', NEW.currency, v_contract_currency;
  END IF;
  RETURN NEW;
END; $function$
