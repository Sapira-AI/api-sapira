CREATE OR REPLACE FUNCTION public.rls_is_holding_admin()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.users u
    INNER JOIN public.roles r ON u.role_id = r.id
    WHERE u.auth_id = auth.uid()
    AND r.name = 'Administrador'
    AND u.status = 'Activo'
  );
$function$

