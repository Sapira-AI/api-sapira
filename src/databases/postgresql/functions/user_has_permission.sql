CREATE OR REPLACE FUNCTION public.user_has_permission(permission_code text)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  has_perm BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM public.users u
    INNER JOIN public.roles r ON u.role_id = r.id
    INNER JOIN public.role_permissions rp ON r.id = rp.role_id
    INNER JOIN public.permissions p ON rp.permission_id = p.id
    WHERE u.auth_id = auth.uid()
    AND (p.code = permission_code OR p.code = 'ALL_PERMISSIONS')
  ) INTO has_perm;
  
  RETURN has_perm;
END;
$function$;

COMMENT ON FUNCTION public."user_has_permission"(permission_code text) IS 'SOLO PARA USO EN APLICACIÓN - No usar en políticas RLS (causa recursión)';
