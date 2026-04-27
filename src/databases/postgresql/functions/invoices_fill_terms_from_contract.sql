CREATE OR REPLACE FUNCTION public.invoices_fill_terms_from_contract()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.invoice_terms_and_conditions IS NULL AND NEW.contract_id IS NOT NULL THEN
    SELECT invoice_terms_and_conditions
      INTO NEW.invoice_terms_and_conditions
    FROM contracts
    WHERE id = NEW.contract_id;
  END IF;
  RETURN NEW;
END;
$function$

