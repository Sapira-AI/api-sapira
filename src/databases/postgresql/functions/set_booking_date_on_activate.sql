CREATE OR REPLACE FUNCTION public.set_booking_date_on_activate()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status = 'Activo' AND NEW.booking_date IS NULL THEN
      NEW.booking_date := CURRENT_DATE;
    END IF;
  ELSE
    -- UPDATE
    IF NEW.status = 'Activo'
       AND (OLD.status IS DISTINCT FROM 'Activo')
       AND NEW.booking_date IS NULL THEN
      NEW.booking_date := CURRENT_DATE;
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;
