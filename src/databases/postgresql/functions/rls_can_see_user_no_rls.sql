CREATE OR REPLACE FUNCTION public.rls_can_see_user_no_rls(target_user_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  current_user_id UUID;
  is_super BOOLEAN;
  current_role_id UUID;
  current_holding UUID;
  target_holding UUID;
  current_role_name TEXT;
BEGIN
  -- Obtener ID, super admin flag y role_id del usuario actual
  SELECT id, COALESCE(is_super_admin, FALSE), role_id
  INTO current_user_id, is_super, current_role_id
  FROM public.users
  WHERE auth_id = auth.uid();
  
  -- Si no hay usuario autenticado, denegar
  IF current_user_id IS NULL THEN
    RETURN FALSE;
  END IF;
  
  -- Caso 1: Super Admin ve todos
  IF is_super THEN
    RETURN TRUE;
  END IF;
  
  -- Caso 2: Usuario ve su propio perfil
  IF current_user_id = target_user_id THEN
    RETURN TRUE;
  END IF;
  
  -- Obtener holding del usuario actual
  SELECT uh.holding_id INTO current_holding
  FROM public.user_holdings uh
  WHERE uh.user_id = current_user_id
  LIMIT 1;
  
  -- Obtener holding del usuario objetivo
  SELECT uh.holding_id INTO target_holding
  FROM public.user_holdings uh
  WHERE uh.user_id = target_user_id
  LIMIT 1;
  
  -- Si no están en el mismo holding, denegar
  IF current_holding IS NULL OR target_holding IS NULL OR current_holding != target_holding THEN
    RETURN FALSE;
  END IF;
  
  -- Caso 3: Obtener nombre del rol directamente
  SELECT name INTO current_role_name
  FROM public.roles
  WHERE id = current_role_id;
  
  -- Admin/Gerente/Contador del mismo holding puede ver
  IF current_role_name IN ('Administrador', 'Gerente Financiero', 'Contador') THEN
    RETURN TRUE;
  END IF;
  
  -- Por defecto, denegar
  RETURN FALSE;
END;
$function$

