CREATE OR REPLACE FUNCTION public.is_super_admin()
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  is_super BOOLEAN;
BEGIN
  SELECT COALESCE(u.is_super_admin, FALSE) INTO is_super
  FROM public.users u
  WHERE u.auth_id = auth.uid();
  
  RETURN COALESCE(is_super, FALSE);
END;
$function$;

COMMENT ON FUNCTION public."is_super_admin"() IS 'Retorna TRUE si el usuario es Super Admin (puede ver todos los holdings)';
