CREATE OR REPLACE FUNCTION public.debug_user_access()
 RETURNS TABLE(my_id uuid, my_email text, my_role text, is_super boolean, is_admin boolean, my_holding_id uuid, my_holding_name text, users_visible bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  RETURN QUERY
  SELECT 
    u.id,
    u.email,
    r.name,
    COALESCE(u.is_super_admin, FALSE),
    public.rls_is_holding_admin(),
    uh.holding_id,
    ch.name,
    (SELECT COUNT(*) FROM public.users) as visible
  FROM public.users u
  LEFT JOIN public.roles r ON u.role_id = r.id
  LEFT JOIN public.user_holdings uh ON u.id = uh.user_id
  LEFT JOIN public.company_holdings ch ON uh.holding_id = ch.id
  WHERE u.auth_id = auth.uid();
END;
$function$

