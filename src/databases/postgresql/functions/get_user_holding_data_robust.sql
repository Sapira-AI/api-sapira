CREATE OR REPLACE FUNCTION public.get_user_holding_data_robust()
 RETURNS TABLE(id uuid, name text, website text, phone text, email text, logo_url text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT h.id, h.name, h.website, h.phone, h.email, h.logo_url
  FROM public.company_holdings h
  INNER JOIN public.user_holdings uh ON h.id = uh.holding_id
  WHERE uh.user_id = auth.uid()
  LIMIT 1;
$function$

