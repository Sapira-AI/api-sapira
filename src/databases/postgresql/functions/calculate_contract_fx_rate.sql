CREATE OR REPLACE FUNCTION public.calculate_contract_fx_rate(p_contract_id uuid, p_conversion_type fx_conversion_type, p_date date)
 RETURNS TABLE(rate numeric, source text, reference_date date)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_policy RECORD;
  v_contract RECORD;
  v_from_currency TEXT;
  v_to_currency TEXT;
  v_rate NUMERIC;
  v_source TEXT;
  v_ref_date DATE;
  v_holding_settings RECORD;
  v_period_rate RECORD;
BEGIN
  -- Obtener contrato con holding_id
  SELECT 
    c.id,
    c.contract_currency,
    c.company_currency,
    c.system_currency,
    c.holding_id
  INTO v_contract
  FROM public.contracts c
  WHERE c.id = p_contract_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Contrato no encontrado: %', p_contract_id;
  END IF;

  -- Determinar monedas origen y destino
  IF p_conversion_type = 'to_company' THEN
    v_from_currency := v_contract.contract_currency;
    v_to_currency := v_contract.company_currency;
  ELSE -- to_system
    v_from_currency := v_contract.contract_currency;
    v_to_currency := v_contract.system_currency;
  END IF;

  -- Si las monedas son iguales, retornar 1
  IF v_from_currency = v_to_currency THEN
    RETURN QUERY SELECT 1.0::NUMERIC, 'same_currency'::TEXT, p_date;
    RETURN;
  END IF;

  -- Obtener política FX del contrato
  SELECT *
  INTO v_policy
  FROM public.contract_fx_policies
  WHERE contract_id = p_contract_id;

  -- Si no hay política, usar holding_default
  IF NOT FOUND THEN
    v_policy.company_fx_policy := 'holding_default'::fx_policy_type;
    v_policy.system_fx_policy := 'holding_default'::fx_policy_type;
  END IF;

  -- Obtener configuración del holding
  SELECT fx_strategy
  INTO v_holding_settings
  FROM public.holding_fx_settings
  WHERE holding_id = v_contract.holding_id;

  -- Aplicar política según tipo de conversión
  IF p_conversion_type = 'to_company' THEN
    CASE v_policy.company_fx_policy
      WHEN 'holding_default' THEN
        -- Usar estrategia del holding (spot o monthly_avg)
        IF v_holding_settings.fx_strategy = 'spot_or_invoice' THEN
          v_rate := fx_rate_with_indirect(p_date, v_from_currency, v_to_currency);
          v_source := 'spot';
        ELSIF v_holding_settings.fx_strategy = 'monthly_average' THEN
          -- Calcular promedio del mes
          SELECT AVG(rate)
          INTO v_rate
          FROM (
            SELECT fx_rate_with_indirect(d::DATE, v_from_currency, v_to_currency) AS rate
            FROM generate_series(
              date_trunc('month', p_date)::DATE,
              (date_trunc('month', p_date) + INTERVAL '1 month - 1 day')::DATE,
              '1 day'::INTERVAL
            ) d
            WHERE d::DATE <= p_date
          ) rates
          WHERE rate IS NOT NULL AND rate > 0;
          v_source := 'monthly_avg';
        END IF;

      WHEN 'spot' THEN
        v_rate := fx_rate_with_indirect(p_date, v_from_currency, v_to_currency);
        v_source := 'spot';

      WHEN 'monthly_avg' THEN
        SELECT AVG(rate)
        INTO v_rate
        FROM (
          SELECT fx_rate_with_indirect(d::DATE, v_from_currency, v_to_currency) AS rate
          FROM generate_series(
            date_trunc('month', p_date)::DATE,
            (date_trunc('month', p_date) + INTERVAL '1 month - 1 day')::DATE,
            '1 day'::INTERVAL
          ) d
          WHERE d::DATE <= p_date
        ) rates
        WHERE rate IS NOT NULL AND rate > 0;
        v_source := 'monthly_avg';

      WHEN 'fixed' THEN
        v_rate := v_policy.company_fx_fixed_rate;
        v_source := 'fixed';

      WHEN 'period_fixed', 'table' THEN
        -- Buscar tasa del período
        SELECT rate, period_start
        INTO v_period_rate
        FROM public.contract_fx_policy_rates
        WHERE fx_policy_id = v_policy.id
          AND conversion_type = 'to_company'
          AND p_date >= period_start
          AND p_date <= period_end
        ORDER BY period_start DESC
        LIMIT 1;

        IF FOUND THEN
          v_rate := v_period_rate.rate;
          v_source := 'period_table';
          v_ref_date := v_period_rate.period_start;
        ELSE
          -- Fallback a spot si no hay tasa del período
          v_rate := fx_rate_with_indirect(p_date, v_from_currency, v_to_currency);
          v_source := 'spot_fallback';
        END IF;
    END CASE;

  ELSE -- to_system
    CASE v_policy.system_fx_policy
      WHEN 'holding_default' THEN
        IF v_holding_settings.fx_strategy = 'spot_or_invoice' THEN
          v_rate := fx_rate_with_indirect(p_date, v_from_currency, v_to_currency);
          v_source := 'spot';
        ELSIF v_holding_settings.fx_strategy = 'monthly_average' THEN
          SELECT AVG(rate)
          INTO v_rate
          FROM (
            SELECT fx_rate_with_indirect(d::DATE, v_from_currency, v_to_currency) AS rate
            FROM generate_series(
              date_trunc('month', p_date)::DATE,
              (date_trunc('month', p_date) + INTERVAL '1 month - 1 day')::DATE,
              '1 day'::INTERVAL
            ) d
            WHERE d::DATE <= p_date
          ) rates
          WHERE rate IS NOT NULL AND rate > 0;
          v_source := 'monthly_avg';
        END IF;

      WHEN 'spot' THEN
        v_rate := fx_rate_with_indirect(p_date, v_from_currency, v_to_currency);
        v_source := 'spot';

      WHEN 'monthly_avg' THEN
        SELECT AVG(rate)
        INTO v_rate
        FROM (
          SELECT fx_rate_with_indirect(d::DATE, v_from_currency, v_to_currency) AS rate
          FROM generate_series(
            date_trunc('month', p_date)::DATE,
            (date_trunc('month', p_date) + INTERVAL '1 month - 1 day')::DATE,
            '1 day'::INTERVAL
          ) d
          WHERE d::DATE <= p_date
        ) rates
        WHERE rate IS NOT NULL AND rate > 0;
        v_source := 'monthly_avg';

      WHEN 'fixed' THEN
        v_rate := v_policy.system_fx_fixed_rate;
        v_source := 'fixed';

      WHEN 'period_fixed', 'table' THEN
        SELECT rate, period_start
        INTO v_period_rate
        FROM public.contract_fx_policy_rates
        WHERE fx_policy_id = v_policy.id
          AND conversion_type = 'to_system'
          AND p_date >= period_start
          AND p_date <= period_end
        ORDER BY period_start DESC
        LIMIT 1;

        IF FOUND THEN
          v_rate := v_period_rate.rate;
          v_source := 'period_table';
          v_ref_date := v_period_rate.period_start;
        ELSE
          v_rate := fx_rate_with_indirect(p_date, v_from_currency, v_to_currency);
          v_source := 'spot_fallback';
        END IF;
    END CASE;
  END IF;

  -- Retornar resultado
  RETURN QUERY SELECT 
    COALESCE(v_rate, 1.0),
    COALESCE(v_source, 'fallback'),
    COALESCE(v_ref_date, p_date);
END;
$function$;

CREATE OR REPLACE FUNCTION public.calculate_contract_fx_rate(p_contract_id uuid, p_conversion_type text, p_period_date date, p_from_currency text, p_to_currency text)
 RETURNS TABLE(rate numeric, source text, reference_date date)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_policy text;
  v_rate numeric;
  v_source text;
  v_ref_date date;
BEGIN
  -- Si las monedas son iguales, rate = 1
  IF p_from_currency = p_to_currency THEN
    RETURN QUERY SELECT 1.0::numeric, 'same_currency'::text, p_period_date;
    RETURN;
  END IF;

  -- Obtener la política FX del contrato
  IF p_conversion_type = 'to_company' THEN
    SELECT fx_company_policy INTO v_policy
    FROM contracts
    WHERE id = p_contract_id;
  ELSIF p_conversion_type = 'to_system' THEN
    -- Para system usar la política del holding
    SELECT hs.fx_system_policy INTO v_policy
    FROM contracts c
    INNER JOIN holding_settings hs ON c.holding_id = hs.holding_id
    WHERE c.id = p_contract_id;
  ELSE
    v_policy := 'monthly_avg'; -- Fallback
  END IF;

  v_policy := COALESCE(v_policy, 'monthly_avg');

  -- Aplicar según política
  IF v_policy = 'spot' THEN
    -- Usar rate del día específico
    SELECT er.rate, 'exchange_rates_spot', er.rate_date
    INTO v_rate, v_source, v_ref_date
    FROM exchange_rates er
    WHERE er.from_currency = p_from_currency
      AND er.to_currency = p_to_currency
      AND er.rate_date = p_period_date
    ORDER BY er.created_at DESC
    LIMIT 1;
    
    IF v_rate IS NULL THEN
      -- Buscar rate más cercano
      SELECT er.rate, 'exchange_rates_nearest', er.rate_date
      INTO v_rate, v_source, v_ref_date
      FROM exchange_rates er
      WHERE er.from_currency = p_from_currency
        AND er.to_currency = p_to_currency
        AND er.rate_date <= p_period_date
      ORDER BY er.rate_date DESC
      LIMIT 1;
    END IF;

  ELSIF v_policy = 'monthly_avg' THEN
    -- Usar promedio mensual
    SELECT erm.avg_rate, 'exchange_rates_monthly_avg', DATE_TRUNC('month', p_period_date)::date
    INTO v_rate, v_source, v_ref_date
    FROM exchange_rates_monthly_avg erm
    WHERE erm.from_currency = p_from_currency
      AND erm.to_currency = p_to_currency
      AND erm.year = EXTRACT(YEAR FROM p_period_date)::integer
      AND erm.month = EXTRACT(MONTH FROM p_period_date)::integer
    LIMIT 1;

  ELSIF v_policy = 'period_locked' THEN
    -- Usar rate fijo del holding para el periodo
    SELECT hfpr.rate, 'holding_fx_period_rates', hfpr.period_start
    INTO v_rate, v_source, v_ref_date
    FROM holding_fx_period_rates hfpr
    INNER JOIN contracts c ON c.holding_id = hfpr.holding_id
    WHERE c.id = p_contract_id
      AND hfpr.from_currency = p_from_currency
      AND hfpr.to_currency = p_to_currency
      AND p_period_date BETWEEN hfpr.period_start AND hfpr.period_end
    ORDER BY hfpr.created_at DESC
    LIMIT 1;

  END IF;

  -- Si aún no hay rate, usar 1.0 como fallback
  IF v_rate IS NULL THEN
    v_rate := 1.0;
    v_source := 'fallback_no_rate';
    v_ref_date := p_period_date;
  END IF;

  RETURN QUERY SELECT v_rate, v_source, v_ref_date;
END;
$function$;

CREATE OR REPLACE FUNCTION public.calculate_contract_fx_rate(p_contract_id uuid, p_from_currency text, p_to_currency text, p_period_date date, p_policy text DEFAULT 'monthly_avg'::text)
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
    SELECT cfpr.rate, 'contract_fixed_period', cfpr.period_start
    INTO v_rate, v_source, v_ref_date
    FROM contract_fx_period_rates cfpr
    WHERE cfpr.contract_id = p_contract_id
      AND cfpr.from_currency = p_from_currency
      AND cfpr.to_currency = p_to_currency
      AND p_period_date BETWEEN cfpr.period_start AND cfpr.period_end
    ORDER BY cfpr.created_at DESC
    LIMIT 1;
    
    -- 2️⃣ If not found, try inverse rate (to_currency → from_currency)
    IF v_rate IS NULL THEN
      SELECT 
        CASE 
          WHEN cfpr.rate > 0 THEN ROUND(1.0 / cfpr.rate, 6)
          ELSE NULL 
        END,
        'contract_fixed_period_inverse',
        cfpr.period_start
      INTO v_rate, v_source, v_ref_date
      FROM contract_fx_period_rates cfpr
      WHERE cfpr.contract_id = p_contract_id
        AND cfpr.from_currency = p_to_currency
        AND cfpr.to_currency = p_from_currency
        AND p_period_date BETWEEN cfpr.period_start AND cfpr.period_end
      ORDER BY cfpr.created_at DESC
      LIMIT 1;
    END IF;
    
    -- 3️⃣ If still not found, mark as missing
    IF v_rate IS NULL THEN
      v_source := 'missing_contract_fx_rate';
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
