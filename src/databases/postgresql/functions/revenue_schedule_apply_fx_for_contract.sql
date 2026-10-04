CREATE OR REPLACE FUNCTION public.revenue_schedule_apply_fx_for_contract(p_contract_id uuid, p_from_month date DEFAULT NULL::date)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
-- S5-10 (01-10, cobertura-contratos-v2 Huecos #11): sin tasa compañía/sistema la fila NO cae a 1,0: las columnas *_ccy / *_system_ccy
-- y fx_contract_to_* quedan NULL, fx_to_*_source 'missing_fx_rate' y calc_version 'missing_fx_rate' (mismo trato que la tasa item del
-- rebuild). Las columnas directas (item_currency_direct) no se tocan. Las tasas fijas del holding conservan su convención (directa
-- 1/rate, inversa rate); la inversa ya no queda tapada por el 1,0 de la directa. Verificación tras aplicar en QA: contrato USD de una
-- compañía CLP sin promedio del mes → filas del mes con recognized_period_ccy NULL y missing_fx_rate; al cargar la tasa y volver a
-- llamar apply_fx (sin rebuild) la fila se completa y pasa a v4-fx-normalized.
-- Moneda de compañía con promedio mensual (decisión de Domi 04-10): solo se convierte un mes de calendario YA TERMINADO cuyo promedio está
-- CERRADO (exchange_rates_monthly_avg recalculado después de terminar el mes, armado con tasas diarias: data_points > 1). El mes en curso
-- y los futuros quedan sin convertir: columnas *_ccy y fx_contract_to_company NULL, fx_to_company_source 'pending_month_close' (no es un
-- hueco de datos: calc_version no pasa a missing_fx_rate). El mes recién terminado cuyo promedio aún no se cierra también queda
-- 'pending_month_close'; un mes anterior sin promedio cerrado es un hueco ('missing_fx_rate'). El mes en curso es el del "hoy" del
-- holding (holding_settings.timezone, default America/Santiago; mismo criterio que holding_fixed_fx_rate). La política fija del contrato
-- (fixed_period, contract_fx_period_rates purpose company) se llena siempre con su tasa. El cierre lo hace el proceso del día 1 de la
-- API (FxMonthCloseService): valida que el mes tenga sus tasas diarias, recalcula el promedio y vuelve a llamar esta función.
-- La moneda de sistema no cambia (tasa fija del holding, proyectada hacia adelante; o promedio mensual si el holding usa monthly_avg).
DECLARE
  v_info RECORD;
  -- Sin vueltas (spec-multimoneda §5, decisión 01-10): ítems en otra moneda que la del contrato cuya moneda ES la de la compañía (o la del
  -- sistema). Sus columnas *_ccy (o *_system_ccy) ya las escribió revenue_schedule_rebuild_contract_ccy con el monto del ítem (tasa 1);
  -- aquí no se recalculan desde la moneda de contrato (eso sería ítem → contrato → compañía, con redondeo y tasas que no aplican).
  v_company_direct_items uuid[];
  v_system_direct_items uuid[];
  v_current_month date;
BEGIN
  SELECT
    c.id, c.holding_id, c.contract_currency,
    co.currency AS company_currency,
    COALESCE(hs.system_currency, 'USD') AS system_currency,
    COALESCE(c.fx_company_policy, 'monthly_avg') AS fx_company_policy,
    COALESCE(hs.fx_system_policy, 'monthly_avg') AS fx_system_policy,
    COALESCE(NULLIF(TRIM(hs.timezone), ''), 'America/Santiago') AS timezone
  INTO v_info
  FROM contracts c
  JOIN companies co ON co.id = c.company_id
  LEFT JOIN holding_settings hs ON hs.holding_id = c.holding_id
  WHERE c.id = p_contract_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Contract % not found', p_contract_id;
  END IF;

  -- Mes en curso del holding (no CURRENT_DATE de la sesión, que en Supabase es UTC y adelanta el cambio de mes 3–4 horas).
  v_current_month := (DATE_TRUNC('month', now() AT TIME ZONE v_info.timezone))::date;

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

    -- Promedio mensual (Domi 04-10): solo meses terminados con promedio cerrado; el mes en curso y los futuros, sin convertir.
    SELECT
      rsm.period_month,
      CASE WHEN rsm.period_month < v_current_month THEN
        COALESCE(
          CASE WHEN ema_direct.avg_rate > 0 THEN ema_direct.avg_rate END,
          CASE WHEN ema_inverse.avg_rate > 0 THEN ROUND(1.0 / ema_inverse.avg_rate, 6) END
        )
      END AS rate,
      CASE
        WHEN rsm.period_month >= v_current_month THEN 'pending_month_close'
        WHEN ema_direct.avg_rate > 0 THEN 'monthly_average'
        WHEN ema_inverse.avg_rate > 0 THEN 'monthly_average_inverse'
        WHEN rsm.period_month = (v_current_month - INTERVAL '1 month')::date THEN 'pending_month_close'
        ELSE 'missing_fx_rate'
      END AS src,
      rsm.period_month::date AS dte
    FROM revenue_schedule_monthly rsm
    -- Promedio cerrado: recalculado después de terminar el mes (hora del holding) y armado con tasas diarias (más de un punto).
    LEFT JOIN exchange_rates_monthly_avg ema_direct
      ON ema_direct.from_currency = v_info.contract_currency
     AND ema_direct.to_currency = v_info.company_currency
     AND ema_direct.year = EXTRACT(YEAR FROM rsm.period_month)::integer
     AND ema_direct.month = EXTRACT(MONTH FROM rsm.period_month)::integer
     AND ema_direct.data_points > 1
     AND ema_direct.calculated_at >= ((rsm.period_month::date + INTERVAL '1 month')::timestamp AT TIME ZONE v_info.timezone)
    LEFT JOIN exchange_rates_monthly_avg ema_inverse
      ON ema_inverse.from_currency = v_info.company_currency
     AND ema_inverse.to_currency = v_info.contract_currency
     AND ema_inverse.year = EXTRACT(YEAR FROM rsm.period_month)::integer
     AND ema_inverse.month = EXTRACT(MONTH FROM rsm.period_month)::integer
     AND ema_inverse.data_points > 1
     AND ema_inverse.calculated_at >= ((rsm.period_month::date + INTERVAL '1 month')::timestamp AT TIME ZONE v_info.timezone)
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
        CASE WHEN cpr_inverse.rate > 0 THEN ROUND(1.0 / cpr_inverse.rate, 10) END
      ) AS rate,
      CASE
        WHEN cpr_direct.rate > 0 THEN 'contract_fixed_period'
        WHEN cpr_inverse.rate > 0 THEN 'contract_fixed_period_inverse'
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
        CASE WHEN ema_direct.avg_rate > 0 THEN ema_direct.avg_rate END,
        CASE WHEN ema_inverse.avg_rate > 0 THEN ROUND(1.0 / ema_inverse.avg_rate, 6) END
      ) AS rate,
      CASE
        WHEN ema_direct.avg_rate > 0 THEN 'monthly_average'
        WHEN ema_inverse.avg_rate > 0 THEN 'monthly_average_inverse'
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

    -- Tasas fijas del holding (una sola búsqueda: holding_fixed_fx_rate). Conservan su convención (directa 1/rate, inversa rate). Sin tasa
    -- que cubra el mes y mes posterior a la última tasa del par: la última, proyectada (fuente *_projected, decisión de Domi 04-10).
    SELECT
      rsm.period_month,
      CASE WHEN hpr.rate > 0 THEN CASE WHEN hpr.is_inverse THEN hpr.rate ELSE ROUND(1.0 / hpr.rate, 10) END END AS rate,
      CASE
        WHEN hpr.rate IS NULL THEN 'missing_fx_rate'
        ELSE 'holding_fixed_period' || CASE WHEN hpr.is_inverse THEN '_inverse' ELSE '' END || CASE WHEN hpr.projected THEN '_projected' ELSE '' END
      END AS src,
      rsm.period_month::date AS dte
    FROM revenue_schedule_monthly rsm
    LEFT JOIN LATERAL public.holding_fixed_fx_rate(v_info.holding_id, v_info.contract_currency, v_info.system_currency, rsm.period_month::date) hpr ON true
    WHERE rsm.contract_id = p_contract_id
      AND v_info.fx_system_policy = 'fixed_period'
      AND v_info.contract_currency <> v_info.system_currency
      AND (p_from_month IS NULL OR rsm.period_month >= p_from_month)
      AND COALESCE(rsm.is_total_row, false) = false
  )

  UPDATE revenue_schedule_monthly r
  SET
    recognized_period_ccy           = CASE WHEN r.contract_item_id = ANY(v_company_direct_items) THEN r.recognized_period_ccy ELSE ROUND(r.recognized_period_contract_ccy * fc.rate, 2) END,
    recognized_cum_ccy              = CASE WHEN r.contract_item_id = ANY(v_company_direct_items) THEN r.recognized_cum_ccy ELSE ROUND(r.recognized_cum_contract_ccy * fc.rate, 2) END,
    billed_period_ccy               = CASE WHEN r.contract_item_id = ANY(v_company_direct_items) THEN r.billed_period_ccy ELSE ROUND(r.billed_period_contract_ccy * fc.rate, 2) END,
    billed_cum_ccy                  = CASE WHEN r.contract_item_id = ANY(v_company_direct_items) THEN r.billed_cum_ccy ELSE ROUND(r.billed_cum_contract_ccy * fc.rate, 2) END,
    deferred_balance_period_ccy     = CASE WHEN r.contract_item_id = ANY(v_company_direct_items) THEN r.deferred_balance_period_ccy ELSE ROUND(r.deferred_balance_period_contract_ccy * fc.rate, 2) END,
    unbilled_balance_period_ccy     = CASE WHEN r.contract_item_id = ANY(v_company_direct_items) THEN r.unbilled_balance_period_ccy ELSE ROUND(r.unbilled_balance_period_contract_ccy * fc.rate, 2) END,
    deferred_balance_eom_ccy        = CASE WHEN r.contract_item_id = ANY(v_company_direct_items) THEN r.deferred_balance_eom_ccy ELSE ROUND(r.deferred_balance_eom_contract_ccy * fc.rate, 2) END,
    unbilled_balance_eom_ccy        = CASE WHEN r.contract_item_id = ANY(v_company_direct_items) THEN r.unbilled_balance_eom_ccy ELSE ROUND(r.unbilled_balance_eom_contract_ccy * fc.rate, 2) END,
    mrr_period_ccy                  = CASE WHEN r.contract_item_id = ANY(v_company_direct_items) THEN r.mrr_period_ccy ELSE ROUND(r.mrr_period_contract_ccy * fc.rate, 2) END,
    mrr_period_contracted_ccy       = CASE WHEN r.contract_item_id = ANY(v_company_direct_items) THEN r.mrr_period_contracted_ccy ELSE ROUND(r.mrr_period_contracted_contract_ccy * fc.rate, 2) END,
    cmrr_period_ccy                 = CASE WHEN r.contract_item_id = ANY(v_company_direct_items) THEN r.cmrr_period_ccy ELSE ROUND(r.cmrr_period_contract_ccy * fc.rate, 2) END,
    fx_contract_to_company          = CASE WHEN r.contract_item_id = ANY(v_company_direct_items) THEN r.fx_contract_to_company ELSE fc.rate END,
    fx_to_company_source            = CASE WHEN r.contract_item_id = ANY(v_company_direct_items) THEN r.fx_to_company_source ELSE CASE WHEN fc.rate IS NULL THEN CASE WHEN fc.src = 'pending_month_close' THEN fc.src ELSE 'missing_fx_rate' END ELSE COALESCE(fc.src, 'no_conversion_needed') END END,
    fx_to_company_date              = CASE WHEN r.contract_item_id = ANY(v_company_direct_items) THEN r.fx_to_company_date ELSE fc.dte END,
    recognized_period_system_ccy        = CASE WHEN r.contract_item_id = ANY(v_system_direct_items) THEN r.recognized_period_system_ccy ELSE ROUND(r.recognized_period_contract_ccy * fs.rate, 2) END,
    recognized_cum_system_ccy           = CASE WHEN r.contract_item_id = ANY(v_system_direct_items) THEN r.recognized_cum_system_ccy ELSE ROUND(r.recognized_cum_contract_ccy * fs.rate, 2) END,
    billed_period_system_ccy            = CASE WHEN r.contract_item_id = ANY(v_system_direct_items) THEN r.billed_period_system_ccy ELSE ROUND(r.billed_period_contract_ccy * fs.rate, 2) END,
    billed_cum_system_ccy               = CASE WHEN r.contract_item_id = ANY(v_system_direct_items) THEN r.billed_cum_system_ccy ELSE ROUND(r.billed_cum_contract_ccy * fs.rate, 2) END,
    deferred_balance_period_system_ccy  = CASE WHEN r.contract_item_id = ANY(v_system_direct_items) THEN r.deferred_balance_period_system_ccy ELSE ROUND(r.deferred_balance_period_contract_ccy * fs.rate, 2) END,
    unbilled_balance_period_system_ccy  = CASE WHEN r.contract_item_id = ANY(v_system_direct_items) THEN r.unbilled_balance_period_system_ccy ELSE ROUND(r.unbilled_balance_period_contract_ccy * fs.rate, 2) END,
    deferred_balance_eom_system_ccy     = CASE WHEN r.contract_item_id = ANY(v_system_direct_items) THEN r.deferred_balance_eom_system_ccy ELSE ROUND(r.deferred_balance_eom_contract_ccy * fs.rate, 2) END,
    unbilled_balance_eom_system_ccy     = CASE WHEN r.contract_item_id = ANY(v_system_direct_items) THEN r.unbilled_balance_eom_system_ccy ELSE ROUND(r.unbilled_balance_eom_contract_ccy * fs.rate, 2) END,
    mrr_period_system_ccy               = CASE WHEN r.contract_item_id = ANY(v_system_direct_items) THEN r.mrr_period_system_ccy ELSE ROUND(r.mrr_period_contract_ccy * fs.rate, 2) END,
    mrr_period_contracted_system_ccy    = CASE WHEN r.contract_item_id = ANY(v_system_direct_items) THEN r.mrr_period_contracted_system_ccy ELSE ROUND(r.mrr_period_contracted_contract_ccy * fs.rate, 2) END,
    cmrr_period_system_ccy              = CASE WHEN r.contract_item_id = ANY(v_system_direct_items) THEN r.cmrr_period_system_ccy ELSE ROUND(r.cmrr_period_contract_ccy * fs.rate, 2) END,
    fx_contract_to_system               = CASE WHEN r.contract_item_id = ANY(v_system_direct_items) THEN r.fx_contract_to_system ELSE fs.rate END,
    fx_to_system_source                 = CASE WHEN r.contract_item_id = ANY(v_system_direct_items) THEN r.fx_to_system_source ELSE CASE WHEN fs.rate IS NULL THEN 'missing_fx_rate' ELSE COALESCE(fs.src, 'no_conversion_needed') END END,
    fx_to_system_date                   = CASE WHEN r.contract_item_id = ANY(v_system_direct_items) THEN r.fx_to_system_date ELSE fs.dte END,
    -- La marca missing_fx_rate del rebuild (falta la tasa item → contrato: montos de contrato NULL) sobrevive a este paso; S5-10: falta la
    -- tasa compañía/sistema de una columna que se convierte aquí (no directa) → también missing_fx_rate (se limpia al volver a llamar con tasa).
    calc_version                        = CASE
      WHEN r.calc_version = 'missing_fx_rate' AND r.recognized_cum_contract_ccy IS NULL THEN r.calc_version
      -- Mes sin cerrar (pending_month_close) no es un hueco: no marca missing_fx_rate.
      WHEN fc.rate IS NULL AND COALESCE(fc.src, '') <> 'pending_month_close' AND NOT COALESCE(r.contract_item_id = ANY(v_company_direct_items), false) THEN 'missing_fx_rate'
      WHEN fs.rate IS NULL AND NOT COALESCE(r.contract_item_id = ANY(v_system_direct_items), false) THEN 'missing_fx_rate'
      ELSE 'v4-fx-normalized' END
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
Sin vueltas (multimoneda, 01-10): filas de ítems cuya moneda (≠ contrato) es la de la compañía o la del sistema conservan las columnas *_ccy / *_system_ccy que escribe el rebuild con el monto directo del ítem; calc_version missing_fx_rate se conserva.
S5-10 (01-10): sin tasa compañía/sistema nunca 1,0: columnas convertidas y fx_contract_to_* NULL, fx_to_*_source y calc_version missing_fx_rate; las directas no se tocan.
Tasa proyectada (04-10): la tasa fija del holding sale de holding_fixed_fx_rate; después de la última tasa registrada del par se usa esa, proyectada (fx_to_system_source holding_fixed_period[_inverse]_projected).
Moneda de compañía con promedio mensual (Domi 04-10): solo meses terminados (mes del holding, holding_settings.timezone) con promedio cerrado (recalculado después de terminar el mes y con data_points > 1); el mes en curso, los futuros y el recién terminado sin promedio cerrado quedan sin convertir (columnas NULL, fx_to_company_source pending_month_close, calc_version sin missing_fx_rate). La política fija del contrato se llena siempre. El proceso del día 1 (FxMonthCloseService de la API) cierra el promedio y completa el mes.';
