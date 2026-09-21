CREATE OR REPLACE FUNCTION public.rls_can_see_user_debug(target_user_id uuid)
 RETURNS TABLE(step text, value text, result boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  current_user_id UUID;
  is_super BOOLEAN;
  current_holding UUID;
  target_holding UUID;
  current_role TEXT;
  auth_user_id UUID;
BEGIN
  -- Paso 1: Verificar auth.uid()
  auth_user_id := auth.uid();
  RETURN QUERY SELECT 'auth.uid()', COALESCE(auth_user_id::TEXT, 'NULL'), auth_user_id IS NOT NULL;
  
  -- Paso 2: Obtener usuario actual
  SELECT id, COALESCE(is_super_admin, FALSE)
  INTO current_user_id, is_super
  FROM public.users
  WHERE auth_id = auth.uid();
  
  RETURN QUERY SELECT 'current_user_id', COALESCE(current_user_id::TEXT, 'NULL'), current_user_id IS NOT NULL;
  RETURN QUERY SELECT 'is_super', is_super::TEXT, is_super;
  
  -- Paso 3: Verificar si es el mismo usuario
  RETURN QUERY SELECT 'same_user', (current_user_id = target_user_id)::TEXT, current_user_id = target_user_id;
  
  -- Paso 4: Obtener holdings
  SELECT uh.holding_id INTO current_holding
  FROM public.user_holdings uh
  WHERE uh.user_id = current_user_id
  LIMIT 1;
  
  SELECT uh.holding_id INTO target_holding
  FROM public.user_holdings uh
  WHERE uh.user_id = target_user_id
  LIMIT 1;
  
  RETURN QUERY SELECT 'current_holding', COALESCE(current_holding::TEXT, 'NULL'), current_holding IS NOT NULL;
  RETURN QUERY SELECT 'target_holding', COALESCE(target_holding::TEXT, 'NULL'), target_holding IS NOT NULL;
  RETURN QUERY SELECT 'same_holding', (current_holding = target_holding)::TEXT, current_holding = target_holding;
  
  -- Paso 5: Obtener rol
  SELECT r.name INTO current_role
  FROM public.users u
  INNER JOIN public.roles r ON u.role_id = r.id
  WHERE u.id = current_user_id;
  
  RETURN QUERY SELECT 'current_role'::TEXT, COALESCE(current_role, 'NULL')::TEXT, (current_role IS NOT NULL)::BOOLEAN;
  RETURN QUERY SELECT 'is_admin_role'::TEXT, (current_role IN ('Administrador', 'Gerente Financiero', 'Contador'))::TEXT, 
    (current_role IN ('Administrador', 'Gerente Financiero', 'Contador'))::BOOLEAN;
END;
$function$

