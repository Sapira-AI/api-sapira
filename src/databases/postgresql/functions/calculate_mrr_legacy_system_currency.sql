CREATE OR REPLACE FUNCTION public.calculate_mrr_legacy_system_currency()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_system_currency text;
  v_fx_policy text;
  v_fx_rate numeric(12,6);
BEGIN
  -- Obtener system_currency y fx_system_policy del holding
  SELECT system_currency, COALESCE(fx_system_policy, 'monthly_avg')
  INTO v_system_currency, v_fx_policy
  FROM holding_settings
  WHERE holding_id = NEW.holding_id;
  
  -- Si contract_currency = system_currency, FX = 1
  IF NEW.contract_currency = v_system_currency THEN
    NEW.fx_contract_to_system := 1.0;
  ELSE
    -- Aplicar política según holding_settings
    IF v_fx_policy = 'monthly_avg' THEN
      -- Buscar en exchange_rates_monthly_avg (contract → system)
      SELECT avg_rate INTO v_fx_rate
      FROM exchange_rates_monthly_avg
      WHERE from_currency = NEW.contract_currency
        AND to_currency = v_system_currency
        AND year = EXTRACT(YEAR FROM NEW.period_month)::integer
        AND month = EXTRACT(MONTH FROM NEW.period_month)::integer;
      
      -- Si no existe, intentar inversa (system → contract)
      IF v_fx_rate IS NULL THEN
        SELECT avg_rate INTO v_fx_rate
        FROM exchange_rates_monthly_avg
        WHERE from_currency = v_system_currency
          AND to_currency = NEW.contract_currency
          AND year = EXTRACT(YEAR FROM NEW.period_month)::integer
          AND month = EXTRACT(MONTH FROM NEW.period_month)::integer;
      END IF;
      
    ELSIF v_fx_policy = 'fixed_period' THEN
      -- Buscar en holding_fx_period_rates (contract → system)
      SELECT rate INTO v_fx_rate
      FROM holding_fx_period_rates
      WHERE holding_id = NEW.holding_id
        AND from_currency = NEW.contract_currency
        AND to_currency = v_system_currency
        AND NEW.period_month >= period_start
        AND NEW.period_month <= period_end;
      
      -- Si no existe, intentar inversa (system → contract)
      IF v_fx_rate IS NULL THEN
        SELECT rate INTO v_fx_rate
        FROM holding_fx_period_rates
        WHERE holding_id = NEW.holding_id
          AND from_currency = v_system_currency
          AND to_currency = NEW.contract_currency
          AND NEW.period_month >= period_start
          AND NEW.period_month <= period_end;
      END IF;
    END IF;
    
    NEW.fx_contract_to_system := COALESCE(v_fx_rate, 1.0);
  END IF;
  
  -- ✅ FIX: Calcular MRR en system currency
  -- IMPORTANTE: Los rates en holding_fx_period_rates están configurados como INVERSOS
  -- Ejemplo: CLF→USD = 0.024 significa 1 USD = 41.67 CLF
  -- Por lo tanto, para convertir CLF a USD debemos DIVIDIR: CLF / rate
  IF NEW.mrr_legacy IS NOT NULL THEN
    NEW.mrr_legacy_system_currency := NEW.mrr_legacy / NULLIF(NEW.fx_contract_to_system, 0);
  ELSE
    NEW.mrr_legacy_system_currency := NULL;
  END IF;
  
  RETURN NEW;
END;
$function$

