CREATE OR REPLACE FUNCTION public.test_rls_access_v2()
 RETURNS TABLE(test_name text, user_email text, user_role text, is_super_admin boolean, holding_name text, can_see_users bigint, can_see_companies bigint, can_see_clients bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  RETURN QUERY
  SELECT 
    'RLS Access Test V2'::TEXT,
    u.email,
    r.name as role_name,
    COALESCE(u.is_super_admin, FALSE) as is_super,
    ch.name as holding_name,
    (SELECT COUNT(*) FROM public.users) as can_see_users,
    (SELECT COUNT(*) FROM public.companies) as can_see_companies,
    (SELECT COUNT(*) FROM public.clients) as can_see_clients
  FROM public.users u
  LEFT JOIN public.roles r ON u.role_id = r.id
  LEFT JOIN public.user_holdings uh ON u.id = uh.user_id
  LEFT JOIN public.company_holdings ch ON uh.holding_id = ch.id
  WHERE u.auth_id = auth.uid();
END;
$function$

