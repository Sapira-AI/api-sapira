CREATE OR REPLACE FUNCTION public.calculate_system_fx_rate(p_holding_id uuid, p_from_currency text, p_to_currency text, p_period_date date, p_policy text DEFAULT 'monthly_avg'::text)
 RETURNS TABLE(rate numeric, source text, reference_date date)
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_rate NUMERIC;
  v_source TEXT;
  v_ref_date DATE;
  v_policy TEXT := COALESCE(p_policy, 'monthly_avg');
BEGIN
  -- If same currency, return 1.0
  IF p_from_currency = p_to_currency THEN
    RETURN QUERY SELECT 1.0::NUMERIC, 'same_currency'::TEXT, p_period_date;
    RETURN;
  END IF;

  -- Handle fixed_period policy with inverse lookup
  IF v_policy = 'fixed_period' THEN
    -- 1️⃣ Try direct rate (from_currency → to_currency)
    SELECT hfpr.rate, 'holding_fixed_period', hfpr.period_start
    INTO v_rate, v_source, v_ref_date
    FROM holding_fx_period_rates hfpr
    WHERE hfpr.holding_id = p_holding_id
      AND hfpr.from_currency = p_from_currency
      AND hfpr.to_currency = p_to_currency
      AND p_period_date BETWEEN hfpr.period_start AND hfpr.period_end
    ORDER BY hfpr.created_at DESC
    LIMIT 1;
    
    -- 2️⃣ If not found, try inverse rate (to_currency → from_currency)
    IF v_rate IS NULL THEN
      SELECT 
        CASE 
          WHEN hfpr.rate > 0 THEN ROUND(1.0 / hfpr.rate, 6)
          ELSE NULL 
        END,
        'holding_fixed_period_inverse',
        hfpr.period_start
      INTO v_rate, v_source, v_ref_date
      FROM holding_fx_period_rates hfpr
      WHERE hfpr.holding_id = p_holding_id
        AND hfpr.from_currency = p_to_currency
        AND hfpr.to_currency = p_from_currency
        AND p_period_date BETWEEN hfpr.period_start AND hfpr.period_end
      ORDER BY hfpr.created_at DESC
      LIMIT 1;
    END IF;
    
    -- 3️⃣ If still not found, mark as missing
    IF v_rate IS NULL THEN
      v_source := 'missing_holding_fx_rate';
    END IF;

  -- Handle monthly_avg policy with inverse lookup
  ELSIF v_policy = 'monthly_avg' THEN
    -- 1️⃣ Try direct rate (from_currency → to_currency)
    SELECT erm.avg_rate, 'monthly_average', DATE_TRUNC('month', p_period_date)::DATE
    INTO v_rate, v_source, v_ref_date
    FROM exchange_rates_monthly_avg erm
    WHERE erm.from_currency = p_from_currency
      AND erm.to_currency = p_to_currency
      AND erm.year = EXTRACT(YEAR FROM p_period_date)::INTEGER
      AND erm.month = EXTRACT(MONTH FROM p_period_date)::INTEGER
    LIMIT 1;
    
    -- 2️⃣ If not found, try inverse rate (to_currency → from_currency)
    IF v_rate IS NULL THEN
      SELECT 
        CASE 
          WHEN erm.avg_rate > 0 THEN ROUND(1.0 / erm.avg_rate, 6)
          ELSE NULL 
        END,
        'monthly_average_inverse',
        DATE_TRUNC('month', p_period_date)::DATE
      INTO v_rate, v_source, v_ref_date
      FROM exchange_rates_monthly_avg erm
      WHERE erm.from_currency = p_to_currency
        AND erm.to_currency = p_from_currency
        AND erm.year = EXTRACT(YEAR FROM p_period_date)::INTEGER
        AND erm.month = EXTRACT(MONTH FROM p_period_date)::INTEGER
      LIMIT 1;
    END IF;
    
    -- 3️⃣ If still not found, mark as missing
    IF v_rate IS NULL THEN
      v_source := 'missing_monthly_avg_rate';
    END IF;

  ELSE
    -- Unsupported policy
    v_rate := NULL;
    v_source := 'unsupported_policy';
    v_ref_date := NULL;
  END IF;

  RETURN QUERY SELECT v_rate, v_source, v_ref_date;
END;
$function$

