CREATE OR REPLACE FUNCTION public.revenue_monthly_journal(p_company_id uuid, p_from date, p_to date, p_granularity text DEFAULT 'month'::text)
 RETURNS TABLE(period_start text, account_code text, account_name text, debit numeric, credit numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_holding_id uuid;
  v_current_period date;
  v_end_period date;
  v_period_data RECORD;
BEGIN
  -- Get user's holding
  v_holding_id := get_current_user_holding_id();
  
  IF v_holding_id IS NULL THEN
    RAISE EXCEPTION 'No holding found for current user';
  END IF;
  
  -- Validate company access
  IF NOT EXISTS (
    SELECT 1 FROM companies 
    WHERE id = p_company_id AND holding_id = v_holding_id
  ) THEN
    RAISE EXCEPTION 'Company not found or access denied';
  END IF;
  
  -- Set period boundaries
  v_current_period := date_trunc('month', p_from);
  v_end_period := date_trunc('month', p_to);
  
  -- Process each month
  WHILE v_current_period <= v_end_period LOOP
    
    -- Get aggregated data for this period and company
    SELECT 
      v_current_period::text as period,
      COALESCE(SUM(rsm.recognized_period_ccy), 0) as recognized,
      COALESCE(SUM(rsm.deferred_balance_eom_ccy), 0) as deferred_eom,
      COALESCE(SUM(rsm.unbilled_balance_eom_ccy), 0) as unbilled_eom,
      COALESCE(SUM(
        CASE WHEN prev_rsm.deferred_balance_eom_ccy IS NOT NULL 
        THEN prev_rsm.deferred_balance_eom_ccy 
        ELSE 0 END
      ), 0) as deferred_bom
    INTO v_period_data
    FROM revenue_schedule_monthly rsm
    LEFT JOIN revenue_schedule_monthly prev_rsm 
      ON prev_rsm.contract_id = rsm.contract_id 
      AND prev_rsm.contract_item_id = rsm.contract_item_id
      AND prev_rsm.period_month = v_current_period - interval '1 month'
    WHERE rsm.period_month = v_current_period
      AND rsm.company_id = p_company_id
      AND rsm.holding_id = v_holding_id;
    
    -- Generate journal entries if there's activity
    IF COALESCE(v_period_data.recognized, 0) > 0 THEN
      
      DECLARE
        v_use_deferred numeric;
        v_dr_unbilled numeric;
      BEGIN
        -- Calculate accounting logic
        v_use_deferred := LEAST(v_period_data.recognized, v_period_data.deferred_bom);
        v_dr_unbilled := v_period_data.recognized - v_use_deferred;
        
        -- Debit: Deferred Revenue (release liability)
        IF v_use_deferred > 0 THEN
          RETURN QUERY SELECT 
            v_period_data.period,
            '2400'::text,
            'Deferred Revenue'::text,
            v_use_deferred,
            0::numeric;
        END IF;
        
        -- Debit: Unbilled Revenue (asset)
        IF v_dr_unbilled > 0 THEN
          RETURN QUERY SELECT 
            v_period_data.period,
            '1300'::text,
            'Unbilled Revenue'::text,
            v_dr_unbilled,
            0::numeric;
        END IF;
        
        -- Credit: Revenue Recognition
        RETURN QUERY SELECT 
          v_period_data.period,
          '4000'::text,
          'Revenue'::text,
          0::numeric,
          v_period_data.recognized;
      END;
    END IF;
    
    v_current_period := v_current_period + interval '1 month';
  END LOOP;
  
END;
$function$


CREATE OR REPLACE FUNCTION public.revenue_monthly_journal(p_company_id uuid, p_from date, p_to date)
 RETURNS TABLE(period_start text, account_code text, account_name text, debit numeric, credit numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_holding_id uuid;
BEGIN
    -- Get holding_id for the company
    SELECT holding_id INTO v_holding_id 
    FROM companies 
    WHERE id = p_company_id;
    
    IF v_holding_id IS NULL THEN
        RETURN;
    END IF;
    
    -- Validate holding access
    IF v_holding_id != get_current_user_holding_id() THEN
        RETURN;
    END IF;
    
    -- Generate journal entries for each month in the period
    RETURN QUERY
    WITH monthly_totals AS (
        SELECT 
            rm.period_month,
            rm.company_currency,
            SUM(rm.recognized_period_ccy) as total_recognized,
            SUM(rm.deferred_balance_period_ccy) as total_deferred_movement,
            SUM(rm.unbilled_balance_period_ccy) as total_unbilled_movement
        FROM revenue_schedule_monthly rm
        WHERE rm.company_id = p_company_id
          AND rm.contract_item_id IS NULL  -- Only TOTAL rows
          AND rm.period_month >= DATE_TRUNC('month', p_from)
          AND rm.period_month <= DATE_TRUNC('month', p_to)
        GROUP BY rm.period_month, rm.company_currency
        HAVING SUM(rm.recognized_period_ccy) != 0 
           OR SUM(rm.deferred_balance_period_ccy) != 0
           OR SUM(rm.unbilled_balance_period_ccy) != 0
    )
    SELECT 
        TO_CHAR(mt.period_month, 'YYYY-MM') as period_start,
        '4000' as account_code,
        'Revenue' as account_name,
        0::numeric as debit,
        mt.total_recognized as credit
    FROM monthly_totals mt
    WHERE mt.total_recognized > 0
    
    UNION ALL
    
    -- Deferred Revenue entries (always negative values converted to positive debits)
    SELECT 
        TO_CHAR(mt.period_month, 'YYYY-MM') as period_start,
        '2400' as account_code,
        'Deferred Revenue' as account_name,
        ABS(mt.total_deferred_movement) as debit,  -- Convert negative to positive debit
        0::numeric as credit
    FROM monthly_totals mt
    WHERE mt.total_deferred_movement < 0  -- Only negative (release) movements
    
    UNION ALL
    
    -- Unbilled entries (can be positive or negative)
    SELECT 
        TO_CHAR(mt.period_month, 'YYYY-MM') as period_start,
        '1300' as account_code,
        'Contract Asset (Unbilled)' as account_name,
        CASE WHEN mt.total_unbilled_movement > 0 THEN mt.total_unbilled_movement ELSE 0 END as debit,
        CASE WHEN mt.total_unbilled_movement < 0 THEN ABS(mt.total_unbilled_movement) ELSE 0 END as credit
    FROM monthly_totals mt
    WHERE mt.total_unbilled_movement != 0
    
    ORDER BY period_start, account_code;
END;
$function$

