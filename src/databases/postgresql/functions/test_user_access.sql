CREATE OR REPLACE FUNCTION public.test_user_access()
 RETURNS TABLE(my_email text, my_role text, is_super boolean, my_holding text, users_i_can_see bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  RETURN QUERY
  SELECT 
    u.email,
    r.name as role_name,
    COALESCE(u.is_super_admin, FALSE),
    ch.name as holding_name,
    (SELECT COUNT(*) FROM public.users) as visible_users
  FROM public.users u
  LEFT JOIN public.roles r ON u.role_id = r.id
  LEFT JOIN public.user_holdings uh ON u.id = uh.user_id
  LEFT JOIN public.company_holdings ch ON uh.holding_id = ch.id
  WHERE u.auth_id = auth.uid();
END;
$function$

