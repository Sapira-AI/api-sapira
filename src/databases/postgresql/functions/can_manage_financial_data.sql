CREATE OR REPLACE FUNCTION public.can_manage_financial_data()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT public.user_has_permission('MANAGE_FINANCIAL_DATA');
$function$

