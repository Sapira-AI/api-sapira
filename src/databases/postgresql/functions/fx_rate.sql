CREATE OR REPLACE FUNCTION public.fx_rate(p_date date, p_from text, p_to text DEFAULT NULL::text, p_contract_id uuid DEFAULT NULL::uuid, p_conversion_type text DEFAULT 'to_system'::text)
 RETURNS numeric
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_rate NUMERIC;
  v_holding_id UUID;
  v_to_currency TEXT;
BEGIN
  -- Si p_to es NULL, obtener moneda de sistema desde holding_settings
  IF p_to IS NULL THEN
    SELECT system_currency INTO v_to_currency
    FROM public.holding_settings
    WHERE holding_id = get_current_user_holding_id();
    
    v_to_currency := COALESCE(v_to_currency, 'USD');
  ELSE
    v_to_currency := p_to;
  END IF;

  -- Si las monedas son iguales, retornar 1
  IF p_from = v_to_currency THEN
    RETURN 1;
  END IF;

  -- Obtener holding_id si hay contract_id
  IF p_contract_id IS NOT NULL THEN
    SELECT holding_id INTO v_holding_id FROM public.contracts WHERE id = p_contract_id;
  END IF;

  -- PRIORIDAD 1: Buscar tasa fija por periodo en contract_fx_rates (si aplica)
  IF p_contract_id IS NOT NULL THEN
    SELECT rate INTO v_rate
    FROM public.contract_fx_rates
    WHERE contract_id = p_contract_id
      AND conversion_type = p_conversion_type
      AND p_date >= period_start
      AND p_date <= period_end
    ORDER BY period_start DESC
    LIMIT 1;
    
    IF v_rate IS NOT NULL THEN
      RETURN v_rate;
    END IF;
  END IF;

  -- PRIORIDAD 2: Buscar en exchange_rates con source_type='manual' (primero)
  SELECT rate INTO v_rate
  FROM public.exchange_rates
  WHERE rate_date = p_date
    AND from_currency = p_from
    AND to_currency = v_to_currency
    AND source_type = 'manual'
  LIMIT 1;

  IF v_rate IS NOT NULL THEN
    RETURN v_rate;
  END IF;

  -- PRIORIDAD 3: Buscar en exchange_rates con source_type='system'
  SELECT rate INTO v_rate
  FROM public.exchange_rates
  WHERE rate_date = p_date
    AND from_currency = p_from
    AND to_currency = v_to_currency
    AND source_type = 'system'
  LIMIT 1;

  IF v_rate IS NOT NULL THEN
    RETURN v_rate;
  END IF;

  -- FALLBACK: Buscar la tasa más reciente anterior a p_date
  SELECT rate INTO v_rate
  FROM public.exchange_rates
  WHERE rate_date <= p_date
    AND from_currency = p_from
    AND to_currency = v_to_currency
  ORDER BY rate_date DESC, 
    CASE WHEN source_type = 'manual' THEN 1 ELSE 2 END
  LIMIT 1;

  RETURN COALESCE(v_rate, 1);
END;
$function$;

CREATE OR REPLACE FUNCTION public.fx_rate(p_from_currency text, p_to_currency text, p_date date DEFAULT CURRENT_DATE)
 RETURNS numeric
 LANGUAGE plpgsql
 STABLE
AS $function$
DECLARE
  v_rate NUMERIC;
  v_holding_policy TEXT;
BEGIN
  -- Si son iguales, retornar 1
  IF p_from_currency = p_to_currency THEN
    RETURN 1.0;
  END IF;

  -- Obtener política del holding
  SELECT fx_system_policy INTO v_holding_policy
  FROM holding_settings
  LIMIT 1;

  -- Si política es fixed_period, buscar en holding_fx_period_rates
  IF v_holding_policy = 'fixed_period' THEN
    SELECT rate INTO v_rate
    FROM holding_fx_period_rates
    WHERE from_currency = p_from_currency
      AND to_currency = p_to_currency
      AND p_date BETWEEN period_start AND period_end
    ORDER BY created_at DESC
    LIMIT 1;
    
    IF v_rate IS NOT NULL THEN
      RETURN v_rate;
    END IF;
  END IF;

  -- Si política es monthly_avg, buscar en exchange_rates_monthly_avg
  IF v_holding_policy = 'monthly_avg' THEN
    SELECT avg_rate INTO v_rate
    FROM exchange_rates_monthly_avg
    WHERE from_currency = p_from_currency
      AND to_currency = p_to_currency
      AND year = EXTRACT(YEAR FROM p_date)
      AND month = EXTRACT(MONTH FROM p_date);
    
    IF v_rate IS NOT NULL THEN
      RETURN v_rate;
    END IF;
  END IF;

  -- Fallback: buscar en exchange_rates (sistema)
  SELECT rate INTO v_rate
  FROM exchange_rates
  WHERE from_currency = p_from_currency
    AND to_currency = p_to_currency
    AND rate_date <= p_date
  ORDER BY rate_date DESC
  LIMIT 1;

  RETURN COALESCE(v_rate, 1.0);
END;
$function$;

COMMENT ON FUNCTION public."fx_rate"(p_date date, p_from text, p_to text, p_contract_id uuid, p_conversion_type text) IS 'Función unificada para obtener tasas de cambio con prioridades: 1) Contract fixed rates, 2) Manual rates, 3) System rates, 4) Historical fallback';
