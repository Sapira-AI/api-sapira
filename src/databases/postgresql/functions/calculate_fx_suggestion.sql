CREATE OR REPLACE FUNCTION public.calculate_fx_suggestion(p_from_currency text, p_to_currency text, p_reference_date date)
 RETURNS TABLE(suggested_rate numeric, rate_source text, rate_date date, confidence text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_rate NUMERIC;
  v_source TEXT;
  v_date DATE;
BEGIN
  IF p_from_currency = p_to_currency THEN
    RETURN QUERY SELECT 1.0::NUMERIC, 'same_currency'::TEXT, p_reference_date, 'high'::TEXT;
    RETURN;
  END IF;

  SELECT avg_rate, 'monthly_avg', DATE(p_reference_date)
  INTO v_rate, v_source, v_date
  FROM exchange_rates_monthly_avg
  WHERE from_currency = p_from_currency
    AND to_currency = p_to_currency
    AND year = EXTRACT(YEAR FROM p_reference_date)
    AND month = EXTRACT(MONTH FROM p_reference_date)
  LIMIT 1;

  IF v_rate IS NOT NULL THEN
    RETURN QUERY SELECT v_rate, v_source, v_date, 'high'::TEXT;
    RETURN;
  END IF;

  SELECT rate, 'daily_rate', rate_date
  INTO v_rate, v_source, v_date
  FROM exchange_rates
  WHERE from_currency = p_from_currency
    AND to_currency = p_to_currency
    AND rate_date = p_reference_date
  ORDER BY created_at DESC
  LIMIT 1;

  IF v_rate IS NOT NULL THEN
    RETURN QUERY SELECT v_rate, v_source, v_date, 'medium'::TEXT;
    RETURN;
  END IF;

  SELECT rate, 'nearest_rate', rate_date
  INTO v_rate, v_source, v_date
  FROM exchange_rates
  WHERE from_currency = p_from_currency
    AND to_currency = p_to_currency
    AND ABS(rate_date - p_reference_date) <= 7
  ORDER BY ABS(rate_date - p_reference_date), created_at DESC
  LIMIT 1;

  IF v_rate IS NOT NULL THEN
    RETURN QUERY SELECT v_rate, v_source, v_date, 'low'::TEXT;
    RETURN;
  END IF;

  RETURN QUERY SELECT NULL::NUMERIC, 'not_found'::TEXT, NULL::DATE, 'none'::TEXT;
END;
$function$

