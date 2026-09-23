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
$function$;

COMMENT ON FUNCTION public."is_date_closed"(p_holding_id uuid, p_company_id uuid, p_date date) IS 'TRUE si la fecha cae en período cerrado para (holding, company). Si no hay fila/cutoff, retorna FALSE (sin cerrar).';
