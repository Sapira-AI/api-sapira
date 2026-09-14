CREATE OR REPLACE FUNCTION public.get_period_guard_mode()
 RETURNS text
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
DECLARE
  v_mode text;
BEGIN
  v_mode := current_setting('sapira.period_guard_mode', true);
  IF v_mode IS NULL OR v_mode = '' THEN
    RETURN 'enforce';
  END IF;
  IF v_mode NOT IN ('off','warn','enforce') THEN
    RETURN 'enforce';
  END IF;
  RETURN v_mode;
END $function$

