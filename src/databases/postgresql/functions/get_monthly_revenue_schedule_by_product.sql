CREATE OR REPLACE FUNCTION public.get_monthly_revenue_schedule_by_product(p_contract_id uuid)
 RETURNS TABLE(period_month date, product_name text, is_total_row boolean, contract_currency text, company_currency text, system_currency text, recognized_period_contract_ccy numeric, recognized_cum_contract_ccy numeric, billed_period_contract_ccy numeric, billed_cum_contract_ccy numeric, deferred_balance_period_contract_ccy numeric, deferred_balance_eom_contract_ccy numeric, unbilled_balance_period_contract_ccy numeric, unbilled_balance_eom_contract_ccy numeric, mrr_period_contract_ccy numeric, mrr_period_contracted_contract_ccy numeric, cmrr_period_contract_ccy numeric, recognized_period_ccy numeric, recognized_cum_ccy numeric, billed_period_ccy numeric, billed_cum_ccy numeric, deferred_balance_period_ccy numeric, deferred_balance_eom_ccy numeric, unbilled_balance_period_ccy numeric, unbilled_balance_eom_ccy numeric, mrr_period_ccy numeric, mrr_period_contracted_ccy numeric, cmrr_period_ccy numeric, recognized_period_system_ccy numeric, recognized_cum_system_ccy numeric, billed_period_system_ccy numeric, billed_cum_system_ccy numeric, deferred_balance_period_system_ccy numeric, deferred_balance_eom_system_ccy numeric, unbilled_balance_period_system_ccy numeric, unbilled_balance_eom_system_ccy numeric, mrr_period_system_ccy numeric, mrr_period_contracted_system_ccy numeric, cmrr_period_system_ccy numeric, fx_contract_to_company numeric, fx_to_company_source text, fx_to_company_date date, fx_contract_to_system numeric, fx_to_system_source text, fx_to_system_date date)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH per_product AS (
    SELECT
      rsm.period_month,
      rsm.product_name,
      MAX(rsm.contract_currency) AS contract_currency,
      MAX(rsm.company_currency) AS company_currency,
      MAX(rsm.system_currency) AS system_currency,
      -- Contract ccy sums
      SUM(COALESCE(rsm.recognized_period_contract_ccy, 0)) AS recognized_period_contract_ccy,
      SUM(COALESCE(rsm.recognized_cum_contract_ccy, 0)) AS recognized_cum_contract_ccy,
      SUM(COALESCE(rsm.billed_period_contract_ccy, 0)) AS billed_period_contract_ccy,
      SUM(COALESCE(rsm.billed_cum_contract_ccy, 0)) AS billed_cum_contract_ccy,
      SUM(COALESCE(rsm.deferred_balance_period_contract_ccy, 0)) AS deferred_balance_period_contract_ccy,
      SUM(COALESCE(rsm.unbilled_balance_period_contract_ccy, 0)) AS unbilled_balance_period_contract_ccy,
      SUM(COALESCE(rsm.mrr_period_contract_ccy, 0)) AS mrr_period_contract_ccy,
      SUM(COALESCE(rsm.mrr_period_contracted_contract_ccy, 0)) AS mrr_period_contracted_contract_ccy,
      SUM(COALESCE(rsm.cmrr_period_contract_ccy, 0)) AS cmrr_period_contract_ccy,
      -- Company ccy sums
      SUM(COALESCE(rsm.recognized_period_ccy, 0)) AS recognized_period_ccy,
      SUM(COALESCE(rsm.recognized_cum_ccy, 0)) AS recognized_cum_ccy,
      SUM(COALESCE(rsm.billed_period_ccy, 0)) AS billed_period_ccy,
      SUM(COALESCE(rsm.billed_cum_ccy, 0)) AS billed_cum_ccy,
      SUM(COALESCE(rsm.deferred_balance_period_ccy, 0)) AS deferred_balance_period_ccy,
      SUM(COALESCE(rsm.unbilled_balance_period_ccy, 0)) AS unbilled_balance_period_ccy,
      SUM(COALESCE(rsm.mrr_period_ccy, 0)) AS mrr_period_ccy,
      SUM(COALESCE(rsm.mrr_period_contracted_ccy, 0)) AS mrr_period_contracted_ccy,
      SUM(COALESCE(rsm.cmrr_period_ccy, 0)) AS cmrr_period_ccy,
      -- System ccy sums
      SUM(COALESCE(rsm.recognized_period_system_ccy, 0)) AS recognized_period_system_ccy,
      SUM(COALESCE(rsm.recognized_cum_system_ccy, 0)) AS recognized_cum_system_ccy,
      SUM(COALESCE(rsm.billed_period_system_ccy, 0)) AS billed_period_system_ccy,
      SUM(COALESCE(rsm.billed_cum_system_ccy, 0)) AS billed_cum_system_ccy,
      SUM(COALESCE(rsm.deferred_balance_period_system_ccy, 0)) AS deferred_balance_period_system_ccy,
      SUM(COALESCE(rsm.unbilled_balance_period_system_ccy, 0)) AS unbilled_balance_period_system_ccy,
      SUM(COALESCE(rsm.mrr_period_system_ccy, 0)) AS mrr_period_system_ccy,
      SUM(COALESCE(rsm.mrr_period_contracted_system_ccy, 0)) AS mrr_period_contracted_system_ccy,
      SUM(COALESCE(rsm.cmrr_period_system_ccy, 0)) AS cmrr_period_system_ccy,
      -- FX metadata (MAX es seguro: valor compartido por todas las filas del contrato en el mes)
      MAX(rsm.fx_contract_to_company) AS fx_contract_to_company,
      MAX(rsm.fx_to_company_source) AS fx_to_company_source,
      MAX(rsm.fx_to_company_date) AS fx_to_company_date,
      MAX(rsm.fx_contract_to_system) AS fx_contract_to_system,
      MAX(rsm.fx_to_system_source) AS fx_to_system_source,
      MAX(rsm.fx_to_system_date) AS fx_to_system_date
    FROM public.revenue_schedule_monthly rsm
    WHERE rsm.contract_id = p_contract_id
      AND COALESCE(rsm.is_total_row, false) = false
    GROUP BY rsm.period_month, rsm.product_name
  ),
  per_product_out AS (
    SELECT
      pp.period_month,
      pp.product_name,
      false AS is_total_row,
      pp.contract_currency,
      pp.company_currency,
      pp.system_currency,
      pp.recognized_period_contract_ccy,
      pp.recognized_cum_contract_ccy,
      pp.billed_period_contract_ccy,
      pp.billed_cum_contract_ccy,
      pp.deferred_balance_period_contract_ccy,
      GREATEST(pp.billed_cum_contract_ccy - pp.recognized_cum_contract_ccy, 0) AS deferred_balance_eom_contract_ccy,
      pp.unbilled_balance_period_contract_ccy,
      GREATEST(pp.recognized_cum_contract_ccy - pp.billed_cum_contract_ccy, 0) AS unbilled_balance_eom_contract_ccy,
      pp.mrr_period_contract_ccy,
      pp.mrr_period_contracted_contract_ccy,
      pp.cmrr_period_contract_ccy,
      pp.recognized_period_ccy,
      pp.recognized_cum_ccy,
      pp.billed_period_ccy,
      pp.billed_cum_ccy,
      pp.deferred_balance_period_ccy,
      GREATEST(pp.billed_cum_ccy - pp.recognized_cum_ccy, 0) AS deferred_balance_eom_ccy,
      pp.unbilled_balance_period_ccy,
      GREATEST(pp.recognized_cum_ccy - pp.billed_cum_ccy, 0) AS unbilled_balance_eom_ccy,
      pp.mrr_period_ccy,
      pp.mrr_period_contracted_ccy,
      pp.cmrr_period_ccy,
      pp.recognized_period_system_ccy,
      pp.recognized_cum_system_ccy,
      pp.billed_period_system_ccy,
      pp.billed_cum_system_ccy,
      pp.deferred_balance_period_system_ccy,
      GREATEST(pp.billed_cum_system_ccy - pp.recognized_cum_system_ccy, 0) AS deferred_balance_eom_system_ccy,
      pp.unbilled_balance_period_system_ccy,
      GREATEST(pp.recognized_cum_system_ccy - pp.billed_cum_system_ccy, 0) AS unbilled_balance_eom_system_ccy,
      pp.mrr_period_system_ccy,
      pp.mrr_period_contracted_system_ccy,
      pp.cmrr_period_system_ccy,
      pp.fx_contract_to_company,
      pp.fx_to_company_source,
      pp.fx_to_company_date,
      pp.fx_contract_to_system,
      pp.fx_to_system_source,
      pp.fx_to_system_date
    FROM per_product pp
  ),
  total_per_month AS (
    SELECT
      p.period_month,
      'TOTAL'::text AS product_name,
      true AS is_total_row,
      MAX(p.contract_currency) AS contract_currency,
      MAX(p.company_currency) AS company_currency,
      MAX(p.system_currency) AS system_currency,
      SUM(p.recognized_period_contract_ccy) AS recognized_period_contract_ccy,
      SUM(p.recognized_cum_contract_ccy) AS recognized_cum_contract_ccy,
      SUM(p.billed_period_contract_ccy) AS billed_period_contract_ccy,
      SUM(p.billed_cum_contract_ccy) AS billed_cum_contract_ccy,
      SUM(p.deferred_balance_period_contract_ccy) AS deferred_balance_period_contract_ccy,
      GREATEST(SUM(p.billed_cum_contract_ccy) - SUM(p.recognized_cum_contract_ccy), 0) AS deferred_balance_eom_contract_ccy,
      SUM(p.unbilled_balance_period_contract_ccy) AS unbilled_balance_period_contract_ccy,
      GREATEST(SUM(p.recognized_cum_contract_ccy) - SUM(p.billed_cum_contract_ccy), 0) AS unbilled_balance_eom_contract_ccy,
      SUM(p.mrr_period_contract_ccy) AS mrr_period_contract_ccy,
      SUM(p.mrr_period_contracted_contract_ccy) AS mrr_period_contracted_contract_ccy,
      SUM(p.cmrr_period_contract_ccy) AS cmrr_period_contract_ccy,
      SUM(p.recognized_period_ccy) AS recognized_period_ccy,
      SUM(p.recognized_cum_ccy) AS recognized_cum_ccy,
      SUM(p.billed_period_ccy) AS billed_period_ccy,
      SUM(p.billed_cum_ccy) AS billed_cum_ccy,
      SUM(p.deferred_balance_period_ccy) AS deferred_balance_period_ccy,
      GREATEST(SUM(p.billed_cum_ccy) - SUM(p.recognized_cum_ccy), 0) AS deferred_balance_eom_ccy,
      SUM(p.unbilled_balance_period_ccy) AS unbilled_balance_period_ccy,
      GREATEST(SUM(p.recognized_cum_ccy) - SUM(p.billed_cum_ccy), 0) AS unbilled_balance_eom_ccy,
      SUM(p.mrr_period_ccy) AS mrr_period_ccy,
      SUM(p.mrr_period_contracted_ccy) AS mrr_period_contracted_ccy,
      SUM(p.cmrr_period_ccy) AS cmrr_period_ccy,
      SUM(p.recognized_period_system_ccy) AS recognized_period_system_ccy,
      SUM(p.recognized_cum_system_ccy) AS recognized_cum_system_ccy,
      SUM(p.billed_period_system_ccy) AS billed_period_system_ccy,
      SUM(p.billed_cum_system_ccy) AS billed_cum_system_ccy,
      SUM(p.deferred_balance_period_system_ccy) AS deferred_balance_period_system_ccy,
      GREATEST(SUM(p.billed_cum_system_ccy) - SUM(p.recognized_cum_system_ccy), 0) AS deferred_balance_eom_system_ccy,
      SUM(p.unbilled_balance_period_system_ccy) AS unbilled_balance_period_system_ccy,
      GREATEST(SUM(p.recognized_cum_system_ccy) - SUM(p.billed_cum_system_ccy), 0) AS unbilled_balance_eom_system_ccy,
      SUM(p.mrr_period_system_ccy) AS mrr_period_system_ccy,
      SUM(p.mrr_period_contracted_system_ccy) AS mrr_period_contracted_system_ccy,
      SUM(p.cmrr_period_system_ccy) AS cmrr_period_system_ccy,
      MAX(p.fx_contract_to_company) AS fx_contract_to_company,
      MAX(p.fx_to_company_source) AS fx_to_company_source,
      MAX(p.fx_to_company_date) AS fx_to_company_date,
      MAX(p.fx_contract_to_system) AS fx_contract_to_system,
      MAX(p.fx_to_system_source) AS fx_to_system_source,
      MAX(p.fx_to_system_date) AS fx_to_system_date
    FROM per_product p
    GROUP BY p.period_month
  )
  SELECT * FROM per_product_out
  UNION ALL
  SELECT * FROM total_per_month
  ORDER BY 1, 3 DESC, 2;
$function$;

COMMENT ON FUNCTION public."get_monthly_revenue_schedule_by_product"(p_contract_id uuid) IS 'Devuelve el schedule mensual de RSM consolidado por producto + fila TOTAL por mes. Recomputa deferred/unbilled EOM con GREATEST(SUM(cum_a) - SUM(cum_b), 0) porque los EOM crudos usan max() y no son sumables cuando original + fantasma de contracción tienen signos opuestos. Usado por el tab Revenue Schedule del contrato.';
