CREATE OR REPLACE FUNCTION public.get_fx_rate(p_holding_id uuid, p_from_currency text, p_to_currency text, p_reference_date date, p_policy text DEFAULT NULL::text)
 RETURNS TABLE(rate numeric, source text, reference_date date)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_policy text := COALESCE(p_policy, 'monthly_avg');
  v_rate numeric;
  v_source text;
  v_ref_date date;
BEGIN
  IF p_holding_id IS NULL OR p_holding_id <> public.get_current_user_holding_id() THEN
    RAISE EXCEPTION 'invalid holding_id';
  END IF;

  IF p_from_currency IS NULL OR p_to_currency IS NULL THEN
    RETURN QUERY SELECT NULL::numeric, 'invalid_currency'::text, NULL::date;
    RETURN;
  END IF;

  IF p_reference_date IS NULL THEN
    p_reference_date := CURRENT_DATE;
  END IF;

  IF p_from_currency = p_to_currency THEN
    RETURN QUERY SELECT 1.0::numeric, 'same_currency'::text, p_reference_date;
    RETURN;
  END IF;

  -- 1) Holding policy (fixed_period/monthly_avg) via existing helper
  SELECT csfr.rate, csfr.source, csfr.reference_date
  INTO v_rate, v_source, v_ref_date
  FROM public.calculate_system_fx_rate(
    p_holding_id,
    p_from_currency,
    p_to_currency,
    p_reference_date,
    v_policy
  ) AS csfr;

  IF v_rate IS NOT NULL THEN
    RETURN QUERY SELECT v_rate, v_source, v_ref_date;
    RETURN;
  END IF;

  -- 2) Fallback to system daily rates (exchange_rates), try direct
  SELECT er.rate, 'exchange_rates'::text, er.rate_date
  INTO v_rate, v_source, v_ref_date
  FROM public.exchange_rates er
  WHERE er.from_currency = p_from_currency
    AND er.to_currency = p_to_currency
    AND er.rate_date <= p_reference_date
  ORDER BY er.rate_date DESC
  LIMIT 1;

  IF v_rate IS NOT NULL THEN
    RETURN QUERY SELECT v_rate, v_source, v_ref_date;
    RETURN;
  END IF;

  -- 3) Fallback inverse
  SELECT
    CASE WHEN er.rate > 0 THEN ROUND(1.0 / er.rate, 8) ELSE NULL END,
    'exchange_rates_inverse'::text,
    er.rate_date
  INTO v_rate, v_source, v_ref_date
  FROM public.exchange_rates er
  WHERE er.from_currency = p_to_currency
    AND er.to_currency = p_from_currency
    AND er.rate_date <= p_reference_date
  ORDER BY er.rate_date DESC
  LIMIT 1;

  RETURN QUERY SELECT v_rate, COALESCE(v_source, 'missing_fx_rate'), v_ref_date;
END;
$function$

