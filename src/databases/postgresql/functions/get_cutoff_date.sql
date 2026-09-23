CREATE OR REPLACE FUNCTION public.get_cutoff_date(p_holding_id uuid, p_company_id uuid)
 RETURNS date
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT cutoff_date
    FROM public.accounting_period_cutoff
   WHERE holding_id = p_holding_id
     AND company_id = p_company_id;
$function$;

COMMENT ON FUNCTION public."get_cutoff_date"(p_holding_id uuid, p_company_id uuid) IS 'Devuelve el cutoff_date actual de la (holding, company). NULL si nada cerrado o si no hay fila.';
