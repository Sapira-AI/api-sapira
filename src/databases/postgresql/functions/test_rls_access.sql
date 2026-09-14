CREATE OR REPLACE FUNCTION public.test_rls_access()
 RETURNS TABLE(test_name text, user_email text, user_role text, holding_name text, can_see_users bigint, can_see_companies bigint, can_see_clients bigint, can_see_invoices bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  RETURN QUERY
  SELECT 
    'RLS Access Test'::TEXT,
    u.email,
    r.name as role_name,
    ch.name as holding_name,
    (SELECT COUNT(*) FROM public.users WHERE true) as can_see_users,
    (SELECT COUNT(*) FROM public.companies WHERE true) as can_see_companies,
    (SELECT COUNT(*) FROM public.clients WHERE true) as can_see_clients,
    (SELECT COUNT(*) FROM public.invoices WHERE true) as can_see_invoices
  FROM public.users u
  LEFT JOIN public.roles r ON u.role_id = r.id
  LEFT JOIN public.user_holdings uh ON u.id = uh.user_id
  LEFT JOIN public.company_holdings ch ON uh.holding_id = ch.id
  WHERE u.auth_id = auth.uid();
END;
$function$

