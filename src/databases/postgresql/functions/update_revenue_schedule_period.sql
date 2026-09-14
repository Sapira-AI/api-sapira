CREATE OR REPLACE FUNCTION public.update_revenue_schedule_period(p_contract_item_id uuid, p_period date)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_contract_id UUID;
  v_override RECORD;
  v_monthly_amount NUMERIC;
  v_is_recurring BOOLEAN;
BEGIN
  -- Obtener contract_id y si es recurrente
  SELECT contract_id, is_recurring 
  INTO v_contract_id, v_is_recurring
  FROM contract_items 
  WHERE id = p_contract_item_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Contract item % not found', p_contract_item_id;
  END IF;

  -- Buscar override para este período
  SELECT unit_price, quantity 
  INTO v_override
  FROM quantities
  WHERE contract_item_id = p_contract_item_id
    AND period = p_period;

  -- Calcular monto mensual
  IF FOUND THEN
    v_monthly_amount := v_override.unit_price * v_override.quantity;
    RAISE NOTICE 'Override encontrado para item % período %: amount=%', 
      p_contract_item_id, p_period, v_monthly_amount;
  ELSE
    -- Fallback a valores base del item
    SELECT (final_price / NULLIF(term_months, 0)) 
    INTO v_monthly_amount
    FROM contract_items 
    WHERE id = p_contract_item_id;
    
    RAISE NOTICE 'Usando valor base para item % período %: amount=%', 
      p_contract_item_id, p_period, v_monthly_amount;
  END IF;

  -- Actualizar revenue_schedule_monthly
  UPDATE revenue_schedule_monthly
  SET
    recognized_period_contract_ccy = v_monthly_amount,
    mrr_period_contract_ccy = CASE 
      WHEN v_is_recurring THEN v_monthly_amount 
      ELSE 0 
    END,
    updated_at = NOW()
  WHERE contract_id = v_contract_id
    AND contract_item_id = p_contract_item_id
    AND period_month = p_period;

  IF FOUND THEN
    RAISE NOTICE '✅ Revenue schedule actualizado: contract=%, item=%, period=%', 
      v_contract_id, p_contract_item_id, p_period;
  ELSE
    RAISE WARNING '⚠️ No se encontró registro en revenue_schedule_monthly para actualizar';
  END IF;

END;
$function$

