CREATE OR REPLACE FUNCTION public.can_access_financial_data()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT public.user_has_permission('VIEW_FINANCIAL_DATA') OR public.user_has_permission('MANAGE_FINANCIAL_DATA');
$function$

