CREATE OR REPLACE FUNCTION public.get_user_company_id()
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT company_id 
  FROM public.user_companies 
  WHERE user_id = auth.uid() 
  LIMIT 1;
$function$

