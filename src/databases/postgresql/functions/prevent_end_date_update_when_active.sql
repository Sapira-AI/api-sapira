CREATE OR REPLACE FUNCTION public.prevent_end_date_update_when_active()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF (OLD.status = 'Activo' OR NEW.status = 'Activo')
       AND (NEW.contract_end_date IS DISTINCT FROM OLD.contract_end_date) THEN
      RAISE EXCEPTION 'No se puede modificar la fecha de término de un contrato Activo.';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;
