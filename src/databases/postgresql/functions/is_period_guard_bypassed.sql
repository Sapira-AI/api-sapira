CREATE OR REPLACE FUNCTION public.is_period_guard_bypassed()
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
DECLARE
  v_bypass text;
BEGIN
  v_bypass := current_setting('sapira.bypass_period_guard', true);
  IF v_bypass IS NULL OR v_bypass = '' THEN
    RETURN false;
  END IF;
  IF v_bypass <> 'on' THEN
    RETURN false;
  END IF;
  RETURN public.is_super_admin();
END $function$;

COMMENT ON FUNCTION public."is_period_guard_bypassed"() IS 'TRUE si sapira.bypass_period_guard = "on" Y el usuario actual es super_admin. Usado para operaciones de onboarding masivo.';
