CREATE OR REPLACE FUNCTION public.rls_is_super_admin()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE(u.is_super_admin, FALSE)
  FROM public.users u
  WHERE u.auth_id = auth.uid();
$function$

