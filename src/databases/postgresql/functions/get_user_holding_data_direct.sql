CREATE OR REPLACE FUNCTION public.get_user_holding_data_direct(user_id uuid)
 RETURNS company_holdings
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
    SELECT h.*
    FROM public.company_holdings h
    JOIN public.user_holdings uh ON h.id = uh.holding_id
    WHERE uh.user_id = user_id
    LIMIT 1;
$function$

