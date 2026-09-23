CREATE OR REPLACE FUNCTION public.calculate_contract_fx_amounts()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_company_currency text;
  v_system_currency text;
  v_fx_policy text;
  v_rate_to_company numeric;
  v_rate_to_system numeric;
BEGIN
  -- Obtener moneda de la compañía desde la tabla companies
  SELECT currency INTO v_company_currency
  FROM public.companies
  WHERE id = NEW.company_id;
  
  -- Obtener moneda del sistema desde holding_settings
  SELECT system_currency INTO v_system_currency
  FROM public.holding_settings
  WHERE holding_id = NEW.holding_id;
  
  -- Si no hay configuración, usar USD como default
  v_company_currency := COALESCE(v_company_currency, 'USD');
  v_system_currency := COALESCE(v_system_currency, 'USD');
  
  -- Guardar monedas en el contrato
  NEW.company_currency := v_company_currency;
  NEW.system_currency := v_system_currency;
  
  -- Calcular tasas FX si las monedas son diferentes
  IF NEW.contract_currency = v_company_currency THEN
    NEW.fx_rate_to_company := 1.0;
    NEW.total_value_company_currency := NEW.total_value;
  ELSE
    -- Obtener política FX (si está configurada en el contrato)
    v_fx_policy := COALESCE(NEW.fx_company_policy, 'monthly_avg');
    
    -- Usar la función fx_rate_v2 para obtener la tasa
    SELECT fx_rate_v2(
      NEW.contract_currency,
      v_company_currency,
      COALESCE(NEW.booking_date, CURRENT_DATE),
      v_fx_policy,
      NEW.holding_id
    ) INTO v_rate_to_company;
    
    NEW.fx_rate_to_company := COALESCE(v_rate_to_company, 1.0);
    NEW.total_value_company_currency := NEW.total_value * NEW.fx_rate_to_company;
  END IF;
  
  -- Calcular conversión a moneda del sistema
  IF NEW.contract_currency = v_system_currency THEN
    NEW.fx_rate_to_system := 1.0;
    NEW.total_value_system_currency := NEW.total_value;
  ELSE
    -- Obtener política FX del sistema desde holding_settings
    SELECT fx_system_policy INTO v_fx_policy
    FROM public.holding_settings
    WHERE holding_id = NEW.holding_id;
    
    v_fx_policy := COALESCE(v_fx_policy, 'monthly_avg');
    
    SELECT fx_rate_v2(
      NEW.contract_currency,
      v_system_currency,
      COALESCE(NEW.booking_date, CURRENT_DATE),
      v_fx_policy,
      NEW.holding_id
    ) INTO v_rate_to_system;
    
    NEW.fx_rate_to_system := COALESCE(v_rate_to_system, 1.0);
    NEW.total_value_system_currency := NEW.total_value * NEW.fx_rate_to_system;
  END IF;
  
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.calculate_contract_fx_amounts(p_contract_id uuid)
 RETURNS TABLE(success boolean, message text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_contract RECORD;
    v_holding_id uuid;
    v_system_currency text;
    v_fx_policy text;
    v_fx_rate_system numeric;
    v_total_system numeric;
    v_fx_result RECORD;
BEGIN
    -- Get contract data
    SELECT * INTO v_contract
    FROM public.contracts
    WHERE id = p_contract_id;

    IF NOT FOUND THEN
        RETURN QUERY SELECT false, 'Contract not found';
        RETURN;
    END IF;

    v_holding_id := v_contract.holding_id;

    -- Get system currency and FX policy
    SELECT hs.system_currency, COALESCE(hs.fx_system_policy, 'monthly_avg')
    INTO v_system_currency, v_fx_policy
    FROM public.holding_settings hs
    WHERE hs.holding_id = v_holding_id;

    IF v_system_currency IS NULL THEN
        RETURN QUERY SELECT false, 'System currency not configured for holding';
        RETURN;
    END IF;

    -- =====================================================
    -- Calculate FX to system currency
    -- =====================================================
    IF v_contract.contract_currency = v_system_currency THEN
        v_fx_rate_system := 1.0;
        v_total_system := v_contract.total_value;
    ELSE
        SELECT rate, source, reference_date
        INTO v_fx_result
        FROM public.calculate_system_fx_rate(
            v_holding_id,
            v_contract.contract_currency,
            v_system_currency,
            COALESCE(v_contract.booking_date, CURRENT_DATE),
            COALESCE(v_fx_policy, 'monthly_avg')
        );

        IF v_fx_result.rate IS NULL OR v_fx_result.rate = 0 THEN
            RETURN QUERY
            SELECT
                false,
                'No FX rate found for ' || v_contract.contract_currency || ' -> ' || v_system_currency ||
                ' (holding_id=' || v_holding_id || ', booking_date=' ||
                COALESCE(v_contract.booking_date, CURRENT_DATE)::text ||
                ', policy=' || COALESCE(v_fx_policy, 'monthly_avg') ||
                ', source=' || COALESCE(v_fx_result.source, 'null') ||
                ', reference_date=' || COALESCE(v_fx_result.reference_date::text, 'null') || ')';
            RETURN;
        END IF;

        v_fx_rate_system := v_fx_result.rate;

        -- DIVIDE by fx_rate because rates are configured as inverse (1 USD = X currency)
        v_total_system := v_contract.total_value / NULLIF(v_fx_rate_system, 0);
    END IF;

    UPDATE public.contracts
    SET
        fx_rate_to_system = v_fx_rate_system,
        total_value_system_currency = ROUND(v_total_system, 2),
        system_currency = v_system_currency
    WHERE id = p_contract_id;

    RETURN QUERY SELECT true, 'FX amounts calculated successfully';

EXCEPTION WHEN OTHERS THEN
    RETURN QUERY SELECT false, 'Error calculating FX amounts: ' || SQLERRM;
END;
$function$;

COMMENT ON FUNCTION public."calculate_contract_fx_amounts"(p_contract_id uuid) IS 'Calcula montos FX para contratos en system_currency y company_currency.
CORREGIDO: Usa calculate_system_fx_rate en lugar de fx_rate_v2 (que no existe).
DIVIDE por fx_rate porque los rates están configurados como inversos (1 USD = X moneda).
Ejemplo: MXN 29,551,328 con FX 18.29 = 29,551,328 / 18.29 = 1,615,881 USD';
