CREATE OR REPLACE FUNCTION public.revenue_monthly_summary(p_company_id uuid, p_from date, p_to date)
 RETURNS TABLE(total_recognized numeric, total_deferred_released numeric, total_unbilled_created numeric, period_count bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Validate company access
  IF NOT EXISTS (
    SELECT 1 FROM companies c 
    WHERE c.id = p_company_id 
      AND c.holding_id = get_current_user_holding_id()
  ) THEN
    RAISE EXCEPTION 'Company not found or access denied';
  END IF;

  RETURN QUERY
  SELECT 
    COALESCE(SUM(rsm.recognized_period_ccy), 0) as total_recognized,
    COALESCE(SUM(rsm.deferred_balance_period_ccy), 0) as total_deferred_released,
    COALESCE(SUM(rsm.unbilled_balance_period_ccy), 0) as total_unbilled_created,
    COUNT(DISTINCT rsm.period_month) as period_count
  FROM revenue_schedule_monthly rsm
  WHERE rsm.company_id = p_company_id
    AND rsm.contract_item_id IS NULL -- Only TOTAL rows
    AND rsm.period_month BETWEEN p_from AND p_to;
END;
$function$

