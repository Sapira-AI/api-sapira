CREATE OR REPLACE FUNCTION public.test_can_see_users()
 RETURNS TABLE(target_email text, target_holding text, can_see boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  RETURN QUERY
  SELECT 
    u.email,
    ch.name as holding_name,
    public.rls_can_see_user(u.id) as can_see
  FROM public.users u
  LEFT JOIN public.user_holdings uh ON u.id = uh.user_id
  LEFT JOIN public.company_holdings ch ON uh.holding_id = ch.id
  ORDER BY u.email;
END;
$function$

