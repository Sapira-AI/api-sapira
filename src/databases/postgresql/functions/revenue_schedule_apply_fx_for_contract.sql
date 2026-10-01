CREATE OR REPLACE FUNCTION public.revenue_schedule_apply_fx_for_contract(p_contract_id uuid, p_from_month date DEFAULT NULL::date)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_info RECORD;
  -- Sin vueltas (spec-multimoneda §5, decisión 01-10): ítems en otra moneda que la del contrato cuya moneda ES la de la compañía (o la del
  -- sistema). Sus columnas *_ccy (o *_system_ccy) ya las escribió revenue_schedule_rebuild_contract_ccy con el monto del ítem (tasa 1);
  -- aquí no se recalculan desde la moneda de contrato (eso sería ítem → contrato → compañía, con redondeo y tasas que no aplican).
  v_company_direct_items uuid[];
  v_system_direct_items uuid[];
BEGIN
  SELECT
    c.id, c.holding_id, c.contract_currency,
    co.currency AS company_currency,
    COALESCE(hs.system_currency, 'USD') AS system_currency,
    COALESCE(c.fx_company_policy, 'monthly_avg') AS fx_company_policy,
    COALESCE(hs.fx_system_policy, 'monthly_avg') AS fx_system_policy
  INTO v_info
  FROM contracts c
  JOIN companies co ON co.id = c.company_id
  LEFT JOIN holding_settings hs ON hs.holding_id = c.holding_id
  WHERE c.id = p_contract_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Contract % not found', p_contract_id;
  END IF;

  SELECT
    COALESCE(array_agg(ci.id) FILTER (WHERE UPPER(TRIM(ci.currency)) = UPPER(TRIM(v_info.company_currency))), '{}'::uuid[]),
    COALESCE(array_agg(ci.id) FILTER (WHERE UPPER(TRIM(ci.currency)) = UPPER(TRIM(v_info.system_currency))), '{}'::uuid[])
  INTO v_company_direct_items, v_system_direct_items
  FROM contract_items ci
  WHERE ci.contract_id = p_contract_id
    AND ci.currency IS NOT NULL
    AND UPPER(TRIM(ci.currency)) <> UPPER(TRIM(v_info.contract_currency));

  WITH fx_company AS (
    SELECT rsm.period_month, 1.0::numeric AS rate, NULL::text AS src, NULL::date AS dte
    FROM revenue_schedule_monthly rsm
    WHERE rsm.contract_id = p_contract_id
      AND v_info.contract_currency = v_info.company_currency
      AND (p_from_month IS NULL OR rsm.period_month >= p_from_month)
      AND COALESCE(rsm.is_total_row, false) = false

    UNION ALL

    SELECT
      rsm.period_month,
      COALESCE(
        ema_direct.avg_rate,
        CASE WHEN ema_inverse.avg_rate > 0 THEN ROUND(1.0 / ema_inverse.avg_rate, 6) ELSE 1.0 END
      ) AS rate,
      CASE
        WHEN ema_direct.avg_rate IS NOT NULL THEN 'monthly_average'
        WHEN ema_inverse.avg_rate IS NOT NULL THEN 'monthly_average_inverse'
        ELSE 'missing_fx_rate'
      END AS src,
      rsm.period_month::date AS dte
    FROM revenue_schedule_monthly rsm
    LEFT JOIN exchange_rates_monthly_avg ema_direct
      ON ema_direct.from_currency = v_info.contract_currency
     AND ema_direct.to_currency = v_info.company_currency
     AND ema_direct.year = EXTRACT(YEAR FROM rsm.period_month)::integer
     AND ema_direct.month = EXTRACT(MONTH FROM rsm.period_month)::integer
    LEFT JOIN exchange_rates_monthly_avg ema_inverse
      ON ema_inverse.from_currency = v_info.company_currency
     AND ema_inverse.to_currency = v_info.contract_currency
     AND ema_inverse.year = EXTRACT(YEAR FROM rsm.period_month)::integer
     AND ema_inverse.month = EXTRACT(MONTH FROM rsm.period_month)::integer
    WHERE rsm.contract_id = p_contract_id
      AND v_info.fx_company_policy = 'monthly_avg'
      AND v_info.contract_currency <> v_info.company_currency
      AND (p_from_month IS NULL OR rsm.period_month >= p_from_month)
      AND COALESCE(rsm.is_total_row, false) = false

    UNION ALL

    SELECT
      rsm.period_month,
      -- Regla única (v2): "1 [from] = rate [to]". Directa (contrato → compañía) se multiplica; inversa = 1/rate.
      COALESCE(
        CASE WHEN cpr_direct.rate > 0 THEN cpr_direct.rate END,
        CASE WHEN cpr_inverse.rate > 0 THEN ROUND(1.0 / cpr_inverse.rate, 10) ELSE 1.0 END
      ) AS rate,
      CASE
        WHEN cpr_direct.rate IS NOT NULL THEN 'contract_fixed_period'
        WHEN cpr_inverse.rate IS NOT NULL THEN 'contract_fixed_period_inverse'
        ELSE 'missing_fx_rate'
      END AS src,
      rsm.period_month::date AS dte
    FROM revenue_schedule_monthly rsm
    LEFT JOIN contract_fx_period_rates cpr_direct
      ON cpr_direct.contract_id = v_info.id
     AND cpr_direct.purpose = 'company'
     AND cpr_direct.from_currency = v_info.contract_currency
     AND cpr_direct.to_currency = v_info.company_currency
     AND rsm.period_month >= cpr_direct.period_start
     AND rsm.period_month <= cpr_direct.period_end
    LEFT JOIN contract_fx_period_rates cpr_inverse
      ON cpr_inverse.contract_id = v_info.id
     AND cpr_inverse.purpose = 'company'
     AND cpr_inverse.from_currency = v_info.company_currency
     AND cpr_inverse.to_currency = v_info.contract_currency
     AND rsm.period_month >= cpr_inverse.period_start
     AND rsm.period_month <= cpr_inverse.period_end
    WHERE rsm.contract_id = p_contract_id
      AND v_info.fx_company_policy = 'fixed_period'
      AND v_info.contract_currency <> v_info.company_currency
      AND (p_from_month IS NULL OR rsm.period_month >= p_from_month)
      AND COALESCE(rsm.is_total_row, false) = false
  ),

  fx_system AS (
    SELECT rsm.period_month, 1.0::numeric AS rate, NULL::text AS src, NULL::date AS dte
    FROM revenue_schedule_monthly rsm
    WHERE rsm.contract_id = p_contract_id
      AND v_info.contract_currency = v_info.system_currency
      AND (p_from_month IS NULL OR rsm.period_month >= p_from_month)
      AND COALESCE(rsm.is_total_row, false) = false

    UNION ALL

    SELECT
      rsm.period_month,
      COALESCE(
        ema_direct.avg_rate,
        CASE WHEN ema_inverse.avg_rate > 0 THEN ROUND(1.0 / ema_inverse.avg_rate, 6) ELSE 1.0 END
      ) AS rate,
      CASE
        WHEN ema_direct.avg_rate IS NOT NULL THEN 'monthly_average'
        WHEN ema_inverse.avg_rate IS NOT NULL THEN 'monthly_average_inverse'
        ELSE 'missing_fx_rate'
      END AS src,
      rsm.period_month::date AS dte
    FROM revenue_schedule_monthly rsm
    LEFT JOIN exchange_rates_monthly_avg ema_direct
      ON ema_direct.from_currency = v_info.contract_currency
     AND ema_direct.to_currency = v_info.system_currency
     AND ema_direct.year = EXTRACT(YEAR FROM rsm.period_month)::integer
     AND ema_direct.month = EXTRACT(MONTH FROM rsm.period_month)::integer
    LEFT JOIN exchange_rates_monthly_avg ema_inverse
      ON ema_inverse.from_currency = v_info.system_currency
     AND ema_inverse.to_currency = v_info.contract_currency
     AND ema_inverse.year = EXTRACT(YEAR FROM rsm.period_month)::integer
     AND ema_inverse.month = EXTRACT(MONTH FROM rsm.period_month)::integer
    WHERE rsm.contract_id = p_contract_id
      AND v_info.fx_system_policy = 'monthly_avg'
      AND v_info.contract_currency <> v_info.system_currency
      AND (p_from_month IS NULL OR rsm.period_month >= p_from_month)
      AND COALESCE(rsm.is_total_row, false) = false

    UNION ALL

    SELECT
      rsm.period_month,
      COALESCE(
        CASE WHEN hpr_direct.rate > 0 THEN ROUND(1.0 / hpr_direct.rate, 10) ELSE 1.0 END,
        CASE WHEN hpr_inverse.rate > 0 THEN hpr_inverse.rate ELSE 1.0 END
      ) AS rate,
      CASE
        WHEN hpr_direct.rate IS NOT NULL THEN 'holding_fixed_period'
        WHEN hpr_inverse.rate IS NOT NULL THEN 'holding_fixed_period_inverse'
        ELSE 'missing_fx_rate'
      END AS src,
      rsm.period_month::date AS dte
    FROM revenue_schedule_monthly rsm
    LEFT JOIN holding_fx_period_rates hpr_direct
      ON hpr_direct.holding_id = v_info.holding_id
     AND hpr_direct.from_currency = v_info.contract_currency
     AND hpr_direct.to_currency = v_info.system_currency
     AND rsm.period_month >= hpr_direct.period_start
     AND rsm.period_month <= hpr_direct.period_end
    LEFT JOIN holding_fx_period_rates hpr_inverse
      ON hpr_inverse.holding_id = v_info.holding_id
     AND hpr_inverse.from_currency = v_info.system_currency
     AND hpr_inverse.to_currency = v_info.contract_currency
     AND rsm.period_month >= hpr_inverse.period_start
     AND rsm.period_month <= hpr_inverse.period_end
    WHERE rsm.contract_id = p_contract_id
      AND v_info.fx_system_policy = 'fixed_period'
      AND v_info.contract_currency <> v_info.system_currency
      AND (p_from_month IS NULL OR rsm.period_month >= p_from_month)
      AND COALESCE(rsm.is_total_row, false) = false
  )

  UPDATE revenue_schedule_monthly r
  SET
    recognized_period_ccy           = CASE WHEN r.contract_item_id = ANY(v_company_direct_items) THEN r.recognized_period_ccy ELSE ROUND(r.recognized_period_contract_ccy * COALESCE(fc.rate, 1.0), 2) END,
    recognized_cum_ccy              = CASE WHEN r.contract_item_id = ANY(v_company_direct_items) THEN r.recognized_cum_ccy ELSE ROUND(r.recognized_cum_contract_ccy * COALESCE(fc.rate, 1.0), 2) END,
    billed_period_ccy               = CASE WHEN r.contract_item_id = ANY(v_company_direct_items) THEN r.billed_period_ccy ELSE ROUND(r.billed_period_contract_ccy * COALESCE(fc.rate, 1.0), 2) END,
    billed_cum_ccy                  = CASE WHEN r.contract_item_id = ANY(v_company_direct_items) THEN r.billed_cum_ccy ELSE ROUND(r.billed_cum_contract_ccy * COALESCE(fc.rate, 1.0), 2) END,
    deferred_balance_period_ccy     = CASE WHEN r.contract_item_id = ANY(v_company_direct_items) THEN r.deferred_balance_period_ccy ELSE ROUND(r.deferred_balance_period_contract_ccy * COALESCE(fc.rate, 1.0), 2) END,
    unbilled_balance_period_ccy     = CASE WHEN r.contract_item_id = ANY(v_company_direct_items) THEN r.unbilled_balance_period_ccy ELSE ROUND(r.unbilled_balance_period_contract_ccy * COALESCE(fc.rate, 1.0), 2) END,
    deferred_balance_eom_ccy        = CASE WHEN r.contract_item_id = ANY(v_company_direct_items) THEN r.deferred_balance_eom_ccy ELSE ROUND(r.deferred_balance_eom_contract_ccy * COALESCE(fc.rate, 1.0), 2) END,
    unbilled_balance_eom_ccy        = CASE WHEN r.contract_item_id = ANY(v_company_direct_items) THEN r.unbilled_balance_eom_ccy ELSE ROUND(r.unbilled_balance_eom_contract_ccy * COALESCE(fc.rate, 1.0), 2) END,
    mrr_period_ccy                  = CASE WHEN r.contract_item_id = ANY(v_company_direct_items) THEN r.mrr_period_ccy ELSE ROUND(r.mrr_period_contract_ccy * COALESCE(fc.rate, 1.0), 2) END,
    mrr_period_contracted_ccy       = CASE WHEN r.contract_item_id = ANY(v_company_direct_items) THEN r.mrr_period_contracted_ccy ELSE ROUND(r.mrr_period_contracted_contract_ccy * COALESCE(fc.rate, 1.0), 2) END,
    cmrr_period_ccy                 = CASE WHEN r.contract_item_id = ANY(v_company_direct_items) THEN r.cmrr_period_ccy ELSE ROUND(r.cmrr_period_contract_ccy * COALESCE(fc.rate, 1.0), 2) END,
    fx_contract_to_company          = CASE WHEN r.contract_item_id = ANY(v_company_direct_items) THEN r.fx_contract_to_company ELSE COALESCE(fc.rate, 1.0) END,
    fx_to_company_source            = CASE WHEN r.contract_item_id = ANY(v_company_direct_items) THEN r.fx_to_company_source ELSE COALESCE(fc.src, 'no_conversion_needed') END,
    fx_to_company_date              = CASE WHEN r.contract_item_id = ANY(v_company_direct_items) THEN r.fx_to_company_date ELSE fc.dte END,
    recognized_period_system_ccy        = CASE WHEN r.contract_item_id = ANY(v_system_direct_items) THEN r.recognized_period_system_ccy ELSE ROUND(r.recognized_period_contract_ccy * COALESCE(fs.rate, 1.0), 2) END,
    recognized_cum_system_ccy           = CASE WHEN r.contract_item_id = ANY(v_system_direct_items) THEN r.recognized_cum_system_ccy ELSE ROUND(r.recognized_cum_contract_ccy * COALESCE(fs.rate, 1.0), 2) END,
    billed_period_system_ccy            = CASE WHEN r.contract_item_id = ANY(v_system_direct_items) THEN r.billed_period_system_ccy ELSE ROUND(r.billed_period_contract_ccy * COALESCE(fs.rate, 1.0), 2) END,
    billed_cum_system_ccy               = CASE WHEN r.contract_item_id = ANY(v_system_direct_items) THEN r.billed_cum_system_ccy ELSE ROUND(r.billed_cum_contract_ccy * COALESCE(fs.rate, 1.0), 2) END,
    deferred_balance_period_system_ccy  = CASE WHEN r.contract_item_id = ANY(v_system_direct_items) THEN r.deferred_balance_period_system_ccy ELSE ROUND(r.deferred_balance_period_contract_ccy * COALESCE(fs.rate, 1.0), 2) END,
    unbilled_balance_period_system_ccy  = CASE WHEN r.contract_item_id = ANY(v_system_direct_items) THEN r.unbilled_balance_period_system_ccy ELSE ROUND(r.unbilled_balance_period_contract_ccy * COALESCE(fs.rate, 1.0), 2) END,
    deferred_balance_eom_system_ccy     = CASE WHEN r.contract_item_id = ANY(v_system_direct_items) THEN r.deferred_balance_eom_system_ccy ELSE ROUND(r.deferred_balance_eom_contract_ccy * COALESCE(fs.rate, 1.0), 2) END,
    unbilled_balance_eom_system_ccy     = CASE WHEN r.contract_item_id = ANY(v_system_direct_items) THEN r.unbilled_balance_eom_system_ccy ELSE ROUND(r.unbilled_balance_eom_contract_ccy * COALESCE(fs.rate, 1.0), 2) END,
    mrr_period_system_ccy               = CASE WHEN r.contract_item_id = ANY(v_system_direct_items) THEN r.mrr_period_system_ccy ELSE ROUND(r.mrr_period_contract_ccy * COALESCE(fs.rate, 1.0), 2) END,
    mrr_period_contracted_system_ccy    = CASE WHEN r.contract_item_id = ANY(v_system_direct_items) THEN r.mrr_period_contracted_system_ccy ELSE ROUND(r.mrr_period_contracted_contract_ccy * COALESCE(fs.rate, 1.0), 2) END,
    cmrr_period_system_ccy              = CASE WHEN r.contract_item_id = ANY(v_system_direct_items) THEN r.cmrr_period_system_ccy ELSE ROUND(r.cmrr_period_contract_ccy * COALESCE(fs.rate, 1.0), 2) END,
    fx_contract_to_system               = CASE WHEN r.contract_item_id = ANY(v_system_direct_items) THEN r.fx_contract_to_system ELSE COALESCE(fs.rate, 1.0) END,
    fx_to_system_source                 = CASE WHEN r.contract_item_id = ANY(v_system_direct_items) THEN r.fx_to_system_source ELSE COALESCE(fs.src, 'no_conversion_needed') END,
    fx_to_system_date                   = CASE WHEN r.contract_item_id = ANY(v_system_direct_items) THEN r.fx_to_system_date ELSE fs.dte END,
    -- La marca missing_fx_rate del rebuild (falta la tasa item → contrato) sobrevive a este paso.
    calc_version                        = CASE WHEN r.calc_version = 'missing_fx_rate' THEN r.calc_version ELSE 'v4-fx-normalized' END
  FROM fx_company fc
  FULL JOIN fx_system fs ON fs.period_month = fc.period_month
  WHERE r.contract_id = p_contract_id
    AND r.period_month = COALESCE(fc.period_month, fs.period_month)
    AND (p_from_month IS NULL OR r.period_month >= p_from_month)
    AND COALESCE(r.is_total_row, false) = false;

END;
$function$;

COMMENT ON FUNCTION public."revenue_schedule_apply_fx_for_contract"(p_contract_id uuid, p_from_month date) IS 'Step 2: Apply FX conversion to revenue schedule records using holding FX policies.
CORREGIDO: DIVIDE por fx_rate porque los rates están configurados como inversos (1 USD = X moneda).
Convierte campos *_contract_ccy a *_ccy (company) y *_system_ccy.
Ejemplo: MXN 2,462,610 con FX 18.29 = 2,462,610 / 18.29 = 134,618 USD.
fixed_period (contract_fx_period_rates, solo purpose = company): regla única "1 [from] = rate [to]"; la fila directa contrato → compañía se multiplica y la inversa es 1/rate (28-09-2026, igual que monthly_avg). Las tasas del holding (sistema) mantienen su convención.
Sin vueltas (multimoneda, 01-10): filas de ítems cuya moneda (≠ contrato) es la de la compañía o la del sistema conservan las columnas *_ccy / *_system_ccy que escribe el rebuild con el monto directo del ítem; calc_version missing_fx_rate se conserva.';
