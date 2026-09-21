CREATE OR REPLACE FUNCTION public.revenue_schedule_apply_fx_for_contract(p_contract_id uuid, p_from_month date DEFAULT NULL::date)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_info RECORD;
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
      COALESCE(
        CASE WHEN cpr_direct.rate > 0 THEN ROUND(1.0 / cpr_direct.rate, 10) ELSE 1.0 END,
        CASE WHEN cpr_inverse.rate > 0 THEN cpr_inverse.rate ELSE 1.0 END
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
     AND cpr_direct.from_currency = v_info.contract_currency
     AND cpr_direct.to_currency = v_info.company_currency
     AND rsm.period_month >= cpr_direct.period_start
     AND rsm.period_month <= cpr_direct.period_end
    LEFT JOIN contract_fx_period_rates cpr_inverse
      ON cpr_inverse.contract_id = v_info.id
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
    recognized_period_ccy           = ROUND(r.recognized_period_contract_ccy * COALESCE(fc.rate, 1.0), 2),
    recognized_cum_ccy              = ROUND(r.recognized_cum_contract_ccy * COALESCE(fc.rate, 1.0), 2),
    billed_period_ccy               = ROUND(r.billed_period_contract_ccy * COALESCE(fc.rate, 1.0), 2),
    billed_cum_ccy                  = ROUND(r.billed_cum_contract_ccy * COALESCE(fc.rate, 1.0), 2),
    deferred_balance_period_ccy     = ROUND(r.deferred_balance_period_contract_ccy * COALESCE(fc.rate, 1.0), 2),
    unbilled_balance_period_ccy     = ROUND(r.unbilled_balance_period_contract_ccy * COALESCE(fc.rate, 1.0), 2),
    deferred_balance_eom_ccy        = ROUND(r.deferred_balance_eom_contract_ccy * COALESCE(fc.rate, 1.0), 2),
    unbilled_balance_eom_ccy        = ROUND(r.unbilled_balance_eom_contract_ccy * COALESCE(fc.rate, 1.0), 2),
    mrr_period_ccy                  = ROUND(r.mrr_period_contract_ccy * COALESCE(fc.rate, 1.0), 2),
    mrr_period_contracted_ccy       = ROUND(r.mrr_period_contracted_contract_ccy * COALESCE(fc.rate, 1.0), 2),
    cmrr_period_ccy                 = ROUND(r.cmrr_period_contract_ccy * COALESCE(fc.rate, 1.0), 2),
    fx_contract_to_company          = COALESCE(fc.rate, 1.0),
    fx_to_company_source            = COALESCE(fc.src, 'no_conversion_needed'),
    fx_to_company_date              = fc.dte,
    recognized_period_system_ccy        = ROUND(r.recognized_period_contract_ccy * COALESCE(fs.rate, 1.0), 2),
    recognized_cum_system_ccy           = ROUND(r.recognized_cum_contract_ccy * COALESCE(fs.rate, 1.0), 2),
    billed_period_system_ccy            = ROUND(r.billed_period_contract_ccy * COALESCE(fs.rate, 1.0), 2),
    billed_cum_system_ccy               = ROUND(r.billed_cum_contract_ccy * COALESCE(fs.rate, 1.0), 2),
    deferred_balance_period_system_ccy  = ROUND(r.deferred_balance_period_contract_ccy * COALESCE(fs.rate, 1.0), 2),
    unbilled_balance_period_system_ccy  = ROUND(r.unbilled_balance_period_contract_ccy * COALESCE(fs.rate, 1.0), 2),
    deferred_balance_eom_system_ccy     = ROUND(r.deferred_balance_eom_contract_ccy * COALESCE(fs.rate, 1.0), 2),
    unbilled_balance_eom_system_ccy     = ROUND(r.unbilled_balance_eom_contract_ccy * COALESCE(fs.rate, 1.0), 2),
    mrr_period_system_ccy               = ROUND(r.mrr_period_contract_ccy * COALESCE(fs.rate, 1.0), 2),
    mrr_period_contracted_system_ccy    = ROUND(r.mrr_period_contracted_contract_ccy * COALESCE(fs.rate, 1.0), 2),
    cmrr_period_system_ccy              = ROUND(r.cmrr_period_contract_ccy * COALESCE(fs.rate, 1.0), 2),
    fx_contract_to_system               = COALESCE(fs.rate, 1.0),
    fx_to_system_source                 = COALESCE(fs.src, 'no_conversion_needed'),
    fx_to_system_date                   = fs.dte,
    calc_version                        = 'v4-fx-normalized'
  FROM fx_company fc
  FULL JOIN fx_system fs ON fs.period_month = fc.period_month
  WHERE r.contract_id = p_contract_id
    AND r.period_month = COALESCE(fc.period_month, fs.period_month)
    AND (p_from_month IS NULL OR r.period_month >= p_from_month)
    AND COALESCE(r.is_total_row, false) = false;

END;
$function$

