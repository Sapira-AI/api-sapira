CREATE OR REPLACE FUNCTION public.trigger_pending_renewal_on_item_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.contract_id IS NULL THEN
    RETURN NEW;
  END IF;

  BEGIN
    PERFORM public.apply_pending_renewal_tail(NEW.contract_id);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'trg_zzz_pending_renewal_on_item_change falló para contract %: %',
      NEW.contract_id, SQLERRM;
  END;

  RETURN NEW;
END;
$function$

