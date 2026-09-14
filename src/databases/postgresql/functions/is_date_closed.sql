CREATE OR REPLACE FUNCTION public.is_date_closed(p_holding_id uuid, p_company_id uuid, p_date date)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT p_date <= COALESCE(
    public.get_cutoff_date(p_holding_id, p_company_id),
    '0001-01-01'::date
  );
$function$

