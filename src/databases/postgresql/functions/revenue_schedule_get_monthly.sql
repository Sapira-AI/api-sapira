CREATE OR REPLACE FUNCTION public.revenue_schedule_get_monthly(p_contract_id uuid)
 RETURNS TABLE(contract_id uuid, holding_id uuid, product_name text, period_month date, is_total_row boolean, contract_currency text, recognized_period_contract_ccy numeric, recognized_cum_contract_ccy numeric, mrr_period_contract_ccy numeric, billed_period_contract_ccy numeric, billed_cum_contract_ccy numeric, deferred_balance_period_contract_ccy numeric, deferred_balance_eom_contract_ccy numeric, unbilled_balance_period_contract_ccy numeric, unbilled_balance_eom_contract_ccy numeric, company_currency text, recognized_period_ccy numeric, recognized_cum_ccy numeric, mrr_period_ccy numeric, billed_period_ccy numeric, billed_cum_ccy numeric, deferred_balance_period_ccy numeric, deferred_balance_eom_ccy numeric, unbilled_balance_period_ccy numeric, unbilled_balance_eom_ccy numeric, system_currency text, recognized_period_system_ccy numeric, recognized_cum_system_ccy numeric, mrr_period_system_ccy numeric, billed_period_system_ccy numeric, billed_cum_system_ccy numeric, deferred_balance_period_system_ccy numeric, deferred_balance_eom_system_ccy numeric, unbilled_balance_period_system_ccy numeric, unbilled_balance_eom_system_ccy numeric, fx_contract_to_company numeric, fx_to_company_source text, fx_to_company_date date, fx_contract_to_system numeric, fx_to_system_source text, fx_to_system_date date)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  RETURN QUERY
  SELECT
    rsm.contract_id,
    rsm.holding_id,
    rsm.product_name,
    rsm.period_month,
    rsm.is_total_row,
    
    -- Contract Currency
    rsm.contract_currency,
    rsm.recognized_period_contract_ccy,
    rsm.recognized_cum_contract_ccy,
    rsm.mrr_period_contract_ccy,
    rsm.billed_period_contract_ccy,
    rsm.billed_cum_contract_ccy,
    rsm.deferred_balance_period_contract_ccy,
    rsm.deferred_balance_eom_contract_ccy,
    rsm.unbilled_balance_period_contract_ccy,
    rsm.unbilled_balance_eom_contract_ccy,
    
    -- Company Currency
    rsm.company_currency,
    rsm.recognized_period_ccy,
    rsm.recognized_cum_ccy,
    rsm.mrr_period_ccy,
    rsm.billed_period_ccy,
    rsm.billed_cum_ccy,
    rsm.deferred_balance_period_ccy,
    rsm.deferred_balance_eom_ccy,
    rsm.unbilled_balance_period_ccy,
    rsm.unbilled_balance_eom_ccy,
    
    -- System Currency
    rsm.system_currency,
    rsm.recognized_period_system_ccy,
    rsm.recognized_cum_system_ccy,
    rsm.mrr_period_system_ccy,
    rsm.billed_period_system_ccy,
    rsm.billed_cum_system_ccy,
    rsm.deferred_balance_period_system_ccy,
    rsm.deferred_balance_eom_system_ccy,
    rsm.unbilled_balance_period_system_ccy,
    rsm.unbilled_balance_eom_system_ccy,
    
    -- FX Metadata
    rsm.fx_contract_to_company,
    rsm.fx_to_company_source,
    rsm.fx_to_company_date,
    rsm.fx_contract_to_system,
    rsm.fx_to_system_source,
    rsm.fx_to_system_date
    
  FROM revenue_schedule_monthly rsm
  WHERE rsm.contract_id = p_contract_id
  ORDER BY rsm.period_month, rsm.is_total_row DESC, rsm.product_name;
END;
$function$

