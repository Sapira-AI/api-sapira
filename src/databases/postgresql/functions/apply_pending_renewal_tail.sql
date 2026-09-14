CREATE OR REPLACE FUNCTION public.apply_pending_renewal_tail(p_contract_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_contract       RECORD;
  v_item           RECORD;
  v_monthly        numeric(15,2);
  v_start_period   date;
  v_end_period     date;
  v_cur            date;
  v_items_processed int := 0;
  v_rows_upserted   int := 0;
BEGIN
  SELECT c.id, c.holding_id, c.company_id, c.contract_currency,
         co.currency AS company_currency,
         COALESCE(hs.system_currency, 'USD') AS system_currency
    INTO v_contract
    FROM public.contracts c
    JOIN public.companies co ON co.id = c.company_id
    LEFT JOIN public.holding_settings hs ON hs.holding_id = c.holding_id
   WHERE c.id = p_contract_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'no_action', 'reason', 'contract_not_found'); END IF;
  FOR v_item IN
    SELECT ci.* FROM public.contract_items ci
     WHERE ci.contract_id = p_contract_id
       AND COALESCE(ci.is_recurring, false) = TRUE
       AND ci.end_date IS NOT NULL
       AND ci.end_date < DATE_TRUNC('month', CURRENT_DATE)::date
       AND ci.renewed_by_item_id IS NULL
       AND ci.churn_date IS NULL
       AND COALESCE(ci.term_months, 0) > 0
       AND COALESCE(ci.categoria, '') NOT IN ('DOWNSELL', 'CHURN')
  LOOP
    v_items_processed := v_items_processed + 1;
    v_monthly := ROUND(COALESCE(v_item.monthly_price, v_item.final_price / NULLIF(v_item.term_months, 0), 0)::numeric, 2);
    IF v_monthly IS NULL OR v_monthly = 0 THEN CONTINUE; END IF;
    v_start_period := (DATE_TRUNC('month', v_item.end_date) + INTERVAL '1 month')::date;
    v_end_period   := (DATE_TRUNC('month', v_item.end_date) + (v_item.term_months * INTERVAL '1 month'))::date;
    v_cur := v_start_period;
    WHILE v_cur <= v_end_period LOOP
      INSERT INTO public.revenue_schedule_monthly(
        id, holding_id, contract_id, contract_item_id, period_month,
        company_id, company_currency, contract_currency, system_currency,
        recognized_period_contract_ccy, recognized_cum_contract_ccy,
        billed_period_contract_ccy, billed_cum_contract_ccy,
        deferred_balance_period_contract_ccy, unbilled_balance_period_contract_ccy,
        deferred_balance_eom_contract_ccy, unbilled_balance_eom_contract_ccy,
        mrr_period_contract_ccy, mrr_period_contracted_contract_ccy, cmrr_period_contract_ccy,
        recognized_period_ccy, recognized_cum_ccy, billed_period_ccy, billed_cum_ccy,
        deferred_balance_period_ccy, unbilled_balance_period_ccy,
        deferred_balance_eom_ccy, unbilled_balance_eom_ccy,
        mrr_period_ccy, mrr_period_contracted_ccy, cmrr_period_ccy,
        recognized_period_system_ccy, recognized_cum_system_ccy,
        billed_period_system_ccy, billed_cum_system_ccy,
        deferred_balance_period_system_ccy, unbilled_balance_period_system_ccy,
        deferred_balance_eom_system_ccy, unbilled_balance_eom_system_ccy,
        mrr_period_system_ccy, mrr_period_contracted_system_ccy, cmrr_period_system_ccy,
        product_name, calc_version, is_total_row,
        fx_contract_to_company, fx_contract_to_system,
        fx_to_company_source, fx_to_company_date, fx_to_system_source, fx_to_system_date,
        momentum
      ) VALUES (
        gen_random_uuid(), v_contract.holding_id, p_contract_id, v_item.id, v_cur,
        v_contract.company_id, v_contract.company_currency, v_contract.contract_currency, v_contract.system_currency,
        0, 0, 0, 0, 0, 0, 0, 0, v_monthly, v_monthly, v_monthly,
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        v_item.product_name, 'v1.2-pending-renewal-exclude-contraction', false,
        1, 1, NULL, NULL, NULL, NULL, 'PENDING_RENEWAL'
      ) ON CONFLICT (contract_id, contract_item_id, period_month, momentum)
      DO UPDATE SET
        mrr_period_contract_ccy            = EXCLUDED.mrr_period_contract_ccy,
        mrr_period_contracted_contract_ccy = EXCLUDED.mrr_period_contracted_contract_ccy,
        cmrr_period_contract_ccy           = EXCLUDED.cmrr_period_contract_ccy,
        product_name                       = EXCLUDED.product_name,
        calc_version                       = EXCLUDED.calc_version,
        updated_at                         = now();
      v_rows_upserted := v_rows_upserted + 1;
      v_cur := (v_cur + INTERVAL '1 month')::date;
    END LOOP;
  END LOOP;
  IF v_items_processed > 0 THEN
    BEGIN PERFORM public.revenue_schedule_apply_fx_for_contract(p_contract_id, NULL);
    EXCEPTION WHEN OTHERS THEN RAISE WARNING 'apply_pending_renewal_tail: FX apply falló para contract %: %', p_contract_id, SQLERRM; END;
  END IF;
  RETURN jsonb_build_object('status', CASE WHEN v_items_processed = 0 THEN 'no_action' ELSE 'applied' END,
    'items_processed', v_items_processed, 'rows_upserted', v_rows_upserted);
END; $function$

