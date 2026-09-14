CREATE OR REPLACE FUNCTION public.rls_can_see_user(target_user_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
AS $function$
  SELECT public.rls_can_see_user_no_rls(target_user_id);
$function$

