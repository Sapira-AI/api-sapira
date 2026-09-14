CREATE OR REPLACE FUNCTION public.audit_resolve_user(OUT v_id uuid, OUT v_name text, OUT v_email text)
 RETURNS record
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  v_id := public.get_current_user_id();   -- FIX: antes auth.uid()
  IF v_id IS NULL THEN
    v_name := NULL;
    v_email := NULL;
    RETURN;
  END IF;
  SELECT name, email INTO v_name, v_email
    FROM public.users WHERE id = v_id;
END $function$

