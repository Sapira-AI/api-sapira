CREATE OR REPLACE FUNCTION public.fx_rate_with_indirect(p_date date, p_from text, p_to text)
 RETURNS numeric
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_direct_rate NUMERIC;
  v_clf_to_clp NUMERIC;
  v_clp_to_target NUMERIC;
  v_holding_id UUID;
BEGIN
  -- Si las monedas son iguales, retornar 1
  IF p_from = p_to THEN
    RETURN 1.0;
  END IF;

  -- Obtener holding_id del usuario actual
  v_holding_id := get_current_user_holding_id();

  -- 1. Intentar conversión directa con prioridad de fuentes
  -- Prioridad: manual (holding) > mindicador > exchangerate-api > system
  
  -- Primero: Tasas manuales del holding
  SELECT rate INTO v_direct_rate
  FROM public.holding_exchange_rates
  WHERE holding_id = v_holding_id
    AND rate_date = p_date
    AND from_currency = p_from
    AND to_currency = p_to
  LIMIT 1;

  IF v_direct_rate IS NOT NULL THEN
    RETURN v_direct_rate;
  END IF;

  -- Segundo: Tasas de APIs externas con prioridad
  SELECT rate INTO v_direct_rate
  FROM public.exchange_rates
  WHERE rate_date = p_date
    AND from_currency = p_from
    AND to_currency = p_to
  ORDER BY 
    CASE 
      WHEN api_source = 'mindicador' THEN 1
      WHEN api_source = 'exchangerate-api' THEN 2
      WHEN api_source = 'system' THEN 3
      ELSE 4
    END
  LIMIT 1;

  IF v_direct_rate IS NOT NULL THEN
    RETURN v_direct_rate;
  END IF;

  -- 2. Si es CLF (UF), intentar conversión indirecta via CLP
  IF p_from = 'CLF' THEN
    -- Obtener CLF → CLP (valor de UF en pesos chilenos)
    SELECT rate INTO v_clf_to_clp
    FROM public.exchange_rates
    WHERE rate_date = p_date
      AND from_currency = 'CLF'
      AND to_currency = 'CLP'
      AND api_source = 'mindicador'
    LIMIT 1;

    -- Obtener CLP → moneda destino
    SELECT rate INTO v_clp_to_target
    FROM public.exchange_rates
    WHERE rate_date = p_date
      AND from_currency = 'CLP'
      AND to_currency = p_to
    ORDER BY
      CASE
        WHEN api_source = 'mindicador' THEN 1
        WHEN api_source = 'exchangerate-api' THEN 2
        ELSE 3
      END
    LIMIT 1;

    -- Si ambas tasas existen, calcular conversión indirecta
    IF v_clf_to_clp IS NOT NULL AND v_clp_to_target IS NOT NULL THEN
      RETURN v_clf_to_clp * v_clp_to_target;
    END IF;
  END IF;

  -- 3. Fallback: buscar tasa más reciente anterior (máximo 30 días)
  -- Primero en holding_exchange_rates
  SELECT rate INTO v_direct_rate
  FROM public.holding_exchange_rates
  WHERE holding_id = v_holding_id
    AND rate_date < p_date
    AND rate_date >= p_date - INTERVAL '30 days'
    AND from_currency = p_from
    AND to_currency = p_to
  ORDER BY rate_date DESC
  LIMIT 1;

  IF v_direct_rate IS NOT NULL THEN
    RETURN v_direct_rate;
  END IF;

  -- Luego en exchange_rates
  SELECT rate INTO v_direct_rate
  FROM public.exchange_rates
  WHERE rate_date < p_date
    AND rate_date >= p_date - INTERVAL '30 days'
    AND from_currency = p_from
    AND to_currency = p_to
  ORDER BY rate_date DESC, 
    CASE 
      WHEN api_source = 'mindicador' THEN 1
      WHEN api_source = 'exchangerate-api' THEN 2
      ELSE 3
    END
  LIMIT 1;

  -- Retornar tasa encontrada o 1.0 como último fallback
  RETURN COALESCE(v_direct_rate, 1.0);
END;
$function$;

COMMENT ON FUNCTION public."fx_rate_with_indirect"(p_date date, p_from text, p_to text) IS 'Obtiene tipo de cambio con soporte para conversiones indirectas (UF->CLP->USD) y prioridad de fuentes';
