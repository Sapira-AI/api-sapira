CREATE OR REPLACE FUNCTION public.get_current_user_holding_id()
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT public.rls_user_holding_id();
$function$

