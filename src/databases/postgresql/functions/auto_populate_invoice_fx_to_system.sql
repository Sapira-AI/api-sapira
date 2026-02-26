CREATE OR REPLACE FUNCTION public.auto_populate_invoice_fx_to_system()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_system_currency TEXT;
  v_fx_policy TEXT;
  v_contract_currency TEXT;
  v_fx_result RECORD;
  v_issue_date DATE;
BEGIN
  -- Solo procesar si el invoice tiene contract_id
  IF NEW.contract_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Obtener contract_currency del contrato
  SELECT contract_currency INTO v_contract_currency
  FROM public.contracts
  WHERE id = NEW.contract_id;

  IF v_contract_currency IS NULL THEN
    RETURN NEW;
  END IF;

  -- Obtener system_currency y fx_system_policy del holding
  SELECT system_currency, fx_system_policy
  INTO v_system_currency, v_fx_policy
  FROM public.holding_settings
  WHERE holding_id = NEW.holding_id;

  -- Defaults si no hay configuración
  v_system_currency := COALESCE(v_system_currency, 'USD');
  v_fx_policy := COALESCE(v_fx_policy, 'monthly_avg');

  -- Si las monedas son iguales, fx = 1
  IF v_contract_currency = v_system_currency THEN
    NEW.fx_contract_to_system := 1.0;
    NEW.system_currency := v_system_currency;
    NEW.amount_system_currency := NEW.amount_contract_currency;
    
    -- ✅ tax_rate está en PORCENTAJE (0-100), dividir por 100
    NEW.total_system_currency := ROUND(
      NEW.amount_system_currency * (1 + COALESCE(NEW.tax_rate, 0) / 100.0),
      2
    );
    
    RETURN NEW;
  END IF;

  -- Determinar fecha para buscar FX rate
  v_issue_date := COALESCE(NEW.issue_date, NEW.scheduled_at, NEW.original_issue_date, CURRENT_DATE);

  -- Usar calculate_system_fx_rate con holding_id
  SELECT rate, source, reference_date
  INTO v_fx_result
  FROM public.calculate_system_fx_rate(
    NEW.holding_id,
    v_contract_currency,
    v_system_currency,
    v_issue_date,
    v_fx_policy
  );

  -- Asignar el FX rate encontrado
  IF v_fx_result.rate IS NOT NULL THEN
    NEW.fx_contract_to_system := v_fx_result.rate;
    NEW.system_currency := v_system_currency;
    
    -- ✅ FIX: DIVIDIR en lugar de multiplicar
    -- Los rates están configurados como inversos (1 USD = X moneda)
    -- Para convertir moneda → USD debemos DIVIDIR
    NEW.amount_system_currency := ROUND(NEW.amount_contract_currency / NULLIF(v_fx_result.rate, 0), 2);
    
    -- ✅ FIX: Calcular total_system desde amount_system y tax_rate en PORCENTAJE
    NEW.total_system_currency := ROUND(
      NEW.amount_system_currency * (1 + COALESCE(NEW.tax_rate, 0) / 100.0),
      2
    );
  ELSE
    -- Si no se encuentra FX rate, dejar NULL y loguear
    RAISE WARNING 'No FX rate found for holding % from % to % on date %', 
      NEW.holding_id, v_contract_currency, v_system_currency, v_issue_date;
    NEW.fx_contract_to_system := NULL;
    NEW.system_currency := v_system_currency;
  END IF;

  RETURN NEW;
END;
$function$
