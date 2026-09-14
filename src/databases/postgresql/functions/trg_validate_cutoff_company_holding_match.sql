CREATE OR REPLACE FUNCTION public.trg_validate_cutoff_company_holding_match()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_company_holding uuid;
BEGIN
  SELECT holding_id INTO v_company_holding
  FROM public.companies WHERE id = NEW.company_id;

  IF v_company_holding IS DISTINCT FROM NEW.holding_id THEN
    RAISE EXCEPTION
      'company_id % no pertenece al holding_id % (pertenece a %)',
      NEW.company_id, NEW.holding_id, v_company_holding;
  END IF;

  RETURN NEW;
END $function$

