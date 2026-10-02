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
  v_month_end      date;
  v_items_processed int := 0;
  v_rows_upserted   int := 0;
BEGIN
  SELECT c.id, c.holding_id, c.company_id, c.contract_currency, c.status,
         co.currency AS company_currency,
         COALESCE(hs.system_currency, 'USD') AS system_currency
    INTO v_contract
    FROM public.contracts c
    JOIN public.companies co ON co.id = c.company_id
    LEFT JOIN public.holding_settings hs ON hs.holding_id = c.holding_id
   WHERE c.id = p_contract_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'no_action', 'reason', 'contract_not_found'); END IF;
  -- v1.3 (S2-10 / D19): un contrato Cancelado o nunca activado (Borrador, En revisión) no tiene "pendiente de renovar": sin cola y se
  -- quitan las filas PENDING_RENEWAL que le hubieran quedado de antes.
  IF v_contract.status IN ('Cancelado', 'Borrador', 'En revisión') THEN
    DELETE FROM public.revenue_schedule_monthly WHERE contract_id = p_contract_id AND momentum = 'PENDING_RENEWAL';
    RETURN jsonb_build_object('status', 'no_action', 'reason', 'contract_not_eligible', 'contract_status', v_contract.status);
  END IF;
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
      v_month_end := (v_cur + INTERVAL '1 month' - INTERVAL '1 day')::date;
      -- v1.3 (§9.3.3): un mes en pausa del ítem (programada o activa, abierta o que cubre el fin del mes) no suma cola: MRR 0 en la pausa.
      IF EXISTS (
        SELECT 1 FROM public.contract_item_pauses pz
         WHERE pz.contract_item_id = v_item.id
           AND pz.status IN ('active', 'scheduled')
           AND pz.pause_start <= v_month_end
           AND (pz.pause_end IS NULL OR pz.pause_end >= v_month_end)
      ) THEN
        DELETE FROM public.revenue_schedule_monthly
         WHERE contract_id = p_contract_id AND contract_item_id = v_item.id AND period_month = v_cur AND momentum = 'PENDING_RENEWAL';
        v_cur := (v_cur + INTERVAL '1 month')::date;
        CONTINUE;
      END IF;
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
        v_item.product_name, 'v1.3-pending-renewal-eligible-unpaused', false,
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
END; $function$;

COMMENT ON FUNCTION public."apply_pending_renewal_tail"(p_contract_id uuid) IS 'Genera filas RSM con momentum=PENDING_RENEWAL para items del contrato en estado limbo (end_date vencido sin renewal ni churn). v1.2: excluye items categoria DOWNSELL/CHURN (son contracciones ya resueltas, no items en limbo). v1.3 (S2-10): sin cola en contratos Cancelado/Borrador/En revisión (borra la que hubiera) ni en los meses con pausa activa o programada del ítem (abierta o que cubre el fin del mes). Idempotente. Proyecta desde end_date+1 hasta end_date+term_months. Ver docs/contratos/mrr-pending-renewal.md.';
