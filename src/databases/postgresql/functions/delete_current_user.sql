CREATE OR REPLACE FUNCTION public.delete_current_user()
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
BEGIN
  RETURN public.delete_user_complete(auth.uid());
END;
$function$

