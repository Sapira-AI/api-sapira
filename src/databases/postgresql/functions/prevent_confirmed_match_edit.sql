CREATE OR REPLACE FUNCTION public.prevent_confirmed_match_edit()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF OLD.status = 'confirmed' AND NEW.status = 'confirmed' THEN
    IF OLD.amount_contract_currency != NEW.amount_contract_currency 
       OR OLD.amount_invoice_currency != NEW.amount_invoice_currency
       OR OLD.fx_contract_to_invoice != NEW.fx_contract_to_invoice THEN
      RAISE EXCEPTION 'Cannot modify amounts or FX of confirmed match. Delete and recreate instead.';
    END IF;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.status = 'confirmed' AND NEW.status != 'confirmed' THEN
    RAISE EXCEPTION 'Cannot change status of confirmed match. Delete and recreate instead.';
  END IF;

  RETURN NEW;
END;
$function$

