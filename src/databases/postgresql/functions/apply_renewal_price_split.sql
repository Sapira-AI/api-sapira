CREATE OR REPLACE FUNCTION public.apply_renewal_price_split(p_contract_item_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_item            contract_items%ROWTYPE;
  v_contract        RECORD;
  v_period          date;
  v_base_quantity   numeric;
  v_base_monthly    numeric;
  v_item_monthly    numeric;
  v_delta           numeric;
  v_mom             text;
BEGIN
  SELECT * INTO v_item FROM contract_items WHERE id = p_contract_item_id;

  -- Guards: no-op silencioso para que el helper sea safe de invocar sin verificar
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'no_action', 'reason', 'item_not_found');
  END IF;
  IF COALESCE(v_item.categoria, '') <> 'RENEWAL' OR v_item.renewal_base_unit_price IS NULL THEN
    RETURN jsonb_build_object('status', 'no_action', 'reason', 'not_a_priced_renewal');
  END IF;
  IF v_item.start_date IS NULL THEN
    RETURN jsonb_build_object('status', 'no_action', 'reason', 'no_start_date');
  END IF;

  v_period := DATE_TRUNC('month', v_item.start_date)::date;

  -- Obtener info del contrato para columnas NOT NULL en el INSERT
  SELECT c.id, c.holding_id, c.company_id, c.contract_currency,
         co.currency AS company_currency,
         COALESCE(hs.system_currency, 'USD') AS system_currency
  INTO v_contract
  FROM contracts c
  JOIN companies co ON co.id = c.company_id
  LEFT JOIN holding_settings hs ON hs.holding_id = c.holding_id
  WHERE c.id = v_item.contract_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'no_action', 'reason', 'contract_not_found');
  END IF;

  -- quantity del ITEM ORIGINAL (vía renews_item_id). Importante: si la renovación
  -- cambió la quantity (ej. orig qty=1 → renewal qty=2 con mismo unit_price), el
  -- base_monthly debe usar la quantity del original para no anular el delta real.
  SELECT COALESCE(orig.quantity, 1) INTO v_base_quantity
  FROM contract_items orig
  WHERE orig.id = v_item.renews_item_id;

  IF v_base_quantity IS NULL THEN
    v_base_quantity := COALESCE(v_item.quantity, 1);
  END IF;

  -- MRR mensual BASE en moneda contrato.
  -- NO dividir por billing_frequency (ciclo de facturación, no duración).
  -- unit_price ya es monthly normalizado por auto_calculate_pricing_fields.
  v_base_monthly := ROUND(v_item.renewal_base_unit_price * v_base_quantity, 2);

  -- MRR mensual NUEVO: monthly_price si existe, fallback a final_price/term_months.
  v_item_monthly := COALESCE(
    v_item.monthly_price,
    CASE WHEN COALESCE(v_item.term_months, 0) > 0
         THEN ROUND(COALESCE(v_item.final_price, 0) / v_item.term_months, 2)
         ELSE 0 END
  );

  v_delta := ROUND(v_item_monthly - v_base_monthly, 2);

  IF ABS(v_delta) < 0.01 THEN
    RETURN jsonb_build_object(
      'status', 'no_action',
      'reason', 'zero_delta',
      'base_monthly', v_base_monthly,
      'item_monthly', v_item_monthly
    );
  END IF;

  v_mom := CASE WHEN v_delta > 0 THEN 'UPSELL' ELSE 'DOWNSELL' END;

  -- 1. UPDATE fila RENEWAL existente del mes efectivo
  UPDATE revenue_schedule_monthly
     SET mrr_period_contract_ccy           = v_base_monthly,
         mrr_period_contracted_contract_ccy = v_base_monthly,
         cmrr_period_contract_ccy          = v_base_monthly,
         calc_version                      = 'v1.0-renewal-split-base'
   WHERE contract_id      = v_item.contract_id
     AND contract_item_id = p_contract_item_id
     AND period_month     = v_period
     AND momentum         = 'RENEWAL';

  -- 2. INSERT fila UPSELL/DOWNSELL del delta (idempotente).
  --    FIX (20260420160135): product_name SIN sufijo, consistente con el
  --    patrón de contracción unificada (fix_contraction_item_fantasma §d).
  INSERT INTO revenue_schedule_monthly (
    holding_id, contract_id, contract_item_id, period_month,
    company_id, company_currency, contract_currency, system_currency,
    momentum,
    mrr_period_contract_ccy, mrr_period_contracted_contract_ccy, cmrr_period_contract_ccy,
    product_name, calc_version, is_total_row,
    fx_contract_to_company, fx_contract_to_system
  ) VALUES (
    v_contract.holding_id, v_contract.id, p_contract_item_id, v_period,
    v_contract.company_id, v_contract.company_currency, v_contract.contract_currency, v_contract.system_currency,
    v_mom,
    v_delta, v_delta, v_delta,
    v_item.product_name, 'v1.0-renewal-split', false,
    1, 1
  )
  ON CONFLICT (contract_id, contract_item_id, period_month, momentum)
  DO UPDATE SET
    mrr_period_contract_ccy            = EXCLUDED.mrr_period_contract_ccy,
    mrr_period_contracted_contract_ccy = EXCLUDED.mrr_period_contracted_contract_ccy,
    cmrr_period_contract_ccy           = EXCLUDED.cmrr_period_contract_ccy,
    product_name                       = EXCLUDED.product_name,
    calc_version                       = EXCLUDED.calc_version;

  -- 3. Completar *_system_ccy y *_ccy en las filas nuevas/actualizadas.
  PERFORM revenue_schedule_apply_fx_for_contract(v_contract.id, v_period);

  RETURN jsonb_build_object(
    'status',        'applied',
    'period_month',  v_period,
    'base_monthly',  v_base_monthly,
    'item_monthly',  v_item_monthly,
    'delta_monthly', v_delta,
    'new_momentum',  v_mom
  );
END;
$function$;

COMMENT ON FUNCTION public."apply_renewal_price_split"(p_contract_item_id uuid) IS 'Helper idempotente que aplica el split de renovación con cambio de precio en revenue_schedule_monthly: UPDATE fila RENEWAL al mrr base + INSERT fila UPSELL/DOWNSELL con el delta. Solo escribe moneda contrato, invoca apply_fx al final. Guard clauses silenciosas: retorna no_action si el item no es un RENEWAL con renewal_base_unit_price seteado. Invocado automáticamente al final de revenue_schedule_rebuild_contract_ccy.';
