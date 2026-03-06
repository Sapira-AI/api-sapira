CREATE OR REPLACE FUNCTION public.revenue_schedule_update_period_quantities(
  p_contract_item_id uuid,
  p_period date,
  p_amount numeric
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_contract_id uuid;
  v_is_recurring boolean;
  v_row RECORD;
  v_recognized_cum numeric(15,2) := 0;
  v_billed_cum numeric(15,2) := 0;
  v_deferred_period_cum_sum numeric(15,2) := 0;
  v_unbilled_balance_eom numeric(15,2) := 0;
  v_deferred_balance_period numeric(15,2);
  v_unbilled_balance_period numeric(15,2);
  v_deferred_balance_eom numeric(15,2);
BEGIN
  SELECT contract_id, COALESCE(is_recurring, false)
  INTO v_contract_id, v_is_recurring
  FROM contract_items
  WHERE id = p_contract_item_id;

  IF v_contract_id IS NULL THEN
    RAISE WARNING 'revenue_schedule_update_period_quantities: contract_item % not found', p_contract_item_id;
    RETURN;
  END IF;

  -- 1. Actualizar recognized_period del mes exacto con el override de quantities.
  --    Si el item es recurrente, mrr_period = mismo valor (el reconocido real del período).
  UPDATE revenue_schedule_monthly
  SET
    recognized_period_contract_ccy         = p_amount,
    mrr_period_contract_ccy                = CASE WHEN v_is_recurring THEN p_amount ELSE mrr_period_contract_ccy END,
    mrr_period_contracted_contract_ccy     = CASE WHEN v_is_recurring THEN p_amount ELSE mrr_period_contracted_contract_ccy END,
    cmrr_period_contract_ccy               = CASE WHEN v_is_recurring THEN p_amount ELSE cmrr_period_contract_ccy END,
    updated_at                             = now()
  WHERE contract_item_id = p_contract_item_id
    AND period_month = p_period
    AND COALESCE(is_total_row, false) = false;

  -- 2. Calcular acumulados hasta el período anterior como punto de partida.
  SELECT
    COALESCE(SUM(recognized_period_contract_ccy), 0),
    COALESCE(SUM(billed_period_contract_ccy), 0)
  INTO v_recognized_cum, v_billed_cum
  FROM revenue_schedule_monthly
  WHERE contract_item_id = p_contract_item_id
    AND period_month < p_period
    AND COALESCE(is_total_row, false) = false;

  -- 3. Recorrer desde p_period en adelante para recalcular todos los acumulados
  --    que dependen del recognized_period que acabamos de cambiar.
  FOR v_row IN
    SELECT *
    FROM revenue_schedule_monthly
    WHERE contract_item_id = p_contract_item_id
      AND period_month >= p_period
      AND COALESCE(is_total_row, false) = false
    ORDER BY period_month
  LOOP
    v_recognized_cum := v_recognized_cum + v_row.recognized_period_contract_ccy;
    v_billed_cum     := v_billed_cum     + v_row.billed_period_contract_ccy;

    IF v_billed_cum > v_recognized_cum THEN
      v_deferred_balance_period := -v_row.recognized_period_contract_ccy;
    ELSIF v_billed_cum < v_recognized_cum AND v_row.billed_period_contract_ccy = 0 THEN
      v_deferred_balance_period := 0;
    ELSE
      v_deferred_balance_period := v_row.billed_period_contract_ccy;
    END IF;

    v_deferred_period_cum_sum := v_deferred_period_cum_sum + v_deferred_balance_period;

    IF v_billed_cum > v_recognized_cum THEN
      v_deferred_balance_eom := v_billed_cum + v_deferred_period_cum_sum;
    ELSIF v_billed_cum = v_recognized_cum THEN
      v_deferred_balance_eom := 0;
    ELSE
      v_deferred_balance_eom := -v_row.billed_period_contract_ccy;
    END IF;

    IF v_billed_cum >= v_recognized_cum THEN
      v_unbilled_balance_period := 0;
    ELSE
      IF v_row.billed_period_contract_ccy = 0 THEN
        v_unbilled_balance_period := v_row.recognized_period_contract_ccy;
      ELSE
        v_unbilled_balance_period := v_row.recognized_period_contract_ccy + v_deferred_balance_period;
      END IF;
    END IF;

    v_unbilled_balance_eom := v_unbilled_balance_eom + v_unbilled_balance_period;

    UPDATE revenue_schedule_monthly
    SET
      recognized_cum_contract_ccy          = v_recognized_cum,
      billed_cum_contract_ccy              = v_billed_cum,
      deferred_balance_period_contract_ccy = v_deferred_balance_period,
      deferred_balance_eom_contract_ccy    = v_deferred_balance_eom,
      unbilled_balance_period_contract_ccy = v_unbilled_balance_period,
      unbilled_balance_eom_contract_ccy    = v_unbilled_balance_eom,
      updated_at                           = now()
    WHERE id = v_row.id;
  END LOOP;

  -- 4. Aplicar conversión FX a moneda empresa y moneda sistema desde el período afectado.
  PERFORM revenue_schedule_apply_fx_for_contract(v_contract_id, p_period);
END;
$$;
