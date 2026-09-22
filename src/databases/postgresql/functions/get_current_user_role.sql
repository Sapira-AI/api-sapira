CREATE OR REPLACE FUNCTION public.get_current_user_role()
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  role_name TEXT;
BEGIN
  SELECT r.name INTO role_name
  FROM public.users u
  INNER JOIN public.roles r ON u.role_id = r.id
  WHERE u.auth_id = auth.uid()
  LIMIT 1;
  
  RETURN role_name;
END;
$function$;

COMMENT ON FUNCTION public."get_current_user_role"() IS 'SOLO PARA USO EN APLICACIÓN - No usar en políticas RLS (causa recursión)';
