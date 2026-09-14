CREATE OR REPLACE FUNCTION public.get_user_holding_id_robust()
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT holding_id 
  FROM public.user_holdings 
  WHERE user_id = auth.uid() 
  LIMIT 1;
$function$

