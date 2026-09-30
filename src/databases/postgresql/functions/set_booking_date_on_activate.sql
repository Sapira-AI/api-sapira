CREATE OR REPLACE FUNCTION public.set_booking_date_on_activate()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  -- Costura sapira.writer: en una transacción de la API (v2) este trigger no hace nada; la API escribe cada campo.
  -- El front viejo nunca fija la marca: para él el trigger sigue igual. Regla: docs/reglas-desarrollo/logica-en-api-triggers.md
  IF current_setting('sapira.writer', true) = 'api' THEN
    RETURN NEW;
  END IF;

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
$function$

