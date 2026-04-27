CREATE OR REPLACE FUNCTION public.update_contract_term()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  -- Actualizar el term del contrato con el MAX de term_months de sus items
  UPDATE public.contracts
  SET term = (
    SELECT MAX(term_months)
    FROM public.contract_items
    WHERE contract_id = COALESCE(NEW.contract_id, OLD.contract_id)
  )
  WHERE id = COALESCE(NEW.contract_id, OLD.contract_id);
  
  RETURN NEW;
END;
$function$

