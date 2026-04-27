CREATE OR REPLACE FUNCTION public.set_match_confirmed_metadata()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_user_id UUID;
BEGIN
  IF NEW.status = 'confirmed' AND (OLD.status IS NULL OR OLD.status != 'confirmed') THEN
    SELECT id INTO v_user_id FROM users WHERE auth_id = auth.uid();
    NEW.confirmed_at := now();
    NEW.confirmed_by := v_user_id;
  END IF;

  RETURN NEW;
END;
$function$

