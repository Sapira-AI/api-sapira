CREATE OR REPLACE FUNCTION public.check_user_has_holding_direct(user_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
    SELECT EXISTS (
        SELECT 1
        FROM public.user_holdings
        WHERE user_id = check_user_has_holding_direct.user_id
    );
$function$

