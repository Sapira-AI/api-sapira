CREATE OR REPLACE FUNCTION public.get_current_user_permissions()
 RETURNS TABLE(code text)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT DISTINCT p.code
  FROM public.users u
  JOIN public.roles r
    ON r.id = u.role_id
  JOIN public.role_permissions rp
    ON rp.role_id = r.id
  JOIN public.permissions p
    ON p.id = rp.permission_id
  WHERE u.auth_id = auth.uid();
$function$

