CREATE OR REPLACE FUNCTION public.debug_current_user_context()
 RETURNS TABLE(auth_uid uuid, user_id uuid, user_email text, is_super_admin boolean, user_role text, user_holding uuid, holding_name text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  RETURN QUERY
  SELECT 
    auth.uid() as auth_uid,
    u.id as user_id,
    u.email as user_email,
    COALESCE(u.is_super_admin, FALSE) as is_super_admin,
    r.name as user_role,
    uh.holding_id as user_holding,
    ch.name as holding_name
  FROM public.users u
  LEFT JOIN public.roles r ON u.role_id = r.id
  LEFT JOIN public.user_holdings uh ON u.id = uh.user_id
  LEFT JOIN public.company_holdings ch ON uh.holding_id = ch.id
  WHERE u.auth_id = auth.uid();
END;
$function$;

COMMENT ON FUNCTION public."debug_current_user_context"() IS 'Retorna el contexto del usuario actual para debugging';
