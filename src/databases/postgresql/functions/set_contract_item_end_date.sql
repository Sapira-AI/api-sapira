CREATE OR REPLACE FUNCTION public.set_contract_item_end_date()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Costura sapira.writer: en una transacción de la API (v2) este trigger no hace nada; la API escribe cada campo.
  -- El front viejo nunca fija la marca: para él el trigger sigue igual. Regla: docs/reglas-desarrollo/logica-en-api-triggers.md
  IF current_setting('sapira.writer', true) = 'api' THEN
    RETURN NEW;
  END IF;

  IF NEW.start_date IS NOT NULL AND NEW.term_months IS NOT NULL THEN
    NEW.end_date := ((NEW.start_date + (NEW.term_months || ' months')::interval) - interval '1 day')::date;
  END IF;
  RETURN NEW;
END;
$function$

