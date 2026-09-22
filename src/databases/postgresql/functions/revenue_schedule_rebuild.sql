CREATE OR REPLACE FUNCTION public.revenue_schedule_rebuild(p_contract_id uuid, p_from_month date DEFAULT NULL::date)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Step 1: Calcular en moneda de contrato
  PERFORM public.revenue_schedule_rebuild_contract_ccy(p_contract_id, p_from_month);
  
  -- Step 2: Aplicar FX
  PERFORM public.revenue_schedule_apply_fx_for_contract(p_contract_id, p_from_month);
END;
$function$;

COMMENT ON FUNCTION public."revenue_schedule_rebuild"(p_contract_id uuid, p_from_month date) IS 'Wrapper: Rebuilds revenue schedule by calling contract_ccy calculation and FX application sequentially.
Compatible with existing triggers (p_from_month defaults to NULL for full rebuild).';
