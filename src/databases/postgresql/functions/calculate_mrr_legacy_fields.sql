CREATE OR REPLACE FUNCTION public.calculate_mrr_legacy_fields()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.is_recurring THEN
    -- MRR = subtotal_contract_currency / term
    NEW.mrr_legacy := NEW.subtotal_contract_currency / NEW.term;
    NEW.momentum := 'EOP';
  ELSE
    NEW.mrr_legacy := NULL;
    NEW.momentum := NULL;
  END IF;
  
  RETURN NEW;
END;
$function$

