CREATE OR REPLACE FUNCTION public.is_holding_admin()
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  is_admin BOOLEAN;
BEGIN
  -- Deshabilitar RLS temporalmente para esta consulta
  SELECT EXISTS (
    SELECT 1 
    FROM public.users u
    INNER JOIN public.roles r ON u.role_id = r.id
    WHERE u.auth_id = auth.uid()
    AND r.name = 'Administrador'
    AND u.status = 'Activo'
  ) INTO is_admin;
  
  RETURN is_admin;
END;
$function$

