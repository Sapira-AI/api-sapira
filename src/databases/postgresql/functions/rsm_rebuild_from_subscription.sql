CREATE OR REPLACE FUNCTION public.rsm_rebuild_from_subscription(p_subscription_id uuid, p_from_month date DEFAULT NULL::date)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_sub RECORD;
  v_company_currency TEXT;
  v_system_currency TEXT;
  v_row RECORD;
  v_prev_item_id UUID := NULL;
  v_recognized_cum NUMERIC(15,2) := 0;
  v_billed_cum NUMERIC(15,2) := 0;
  v_first_period DATE;
  v_last_period DATE;
  v_sub_canceled BOOLEAN;
  v_momentum TEXT;
BEGIN
  -- 1. Cargar datos de la suscripción
  SELECT
    s.id, s.holding_id, s.company_id, s.currency, s.status
  INTO v_sub
  FROM subscriptions s
  WHERE s.id = p_subscription_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Subscription % not found', p_subscription_id;
  END IF;

  -- 2. Cargar monedas
  SELECT co.currency INTO v_company_currency
  FROM companies co WHERE co.id = v_sub.company_id;

  SELECT COALESCE(hs.system_currency, 'USD') INTO v_system_currency
  FROM holding_settings hs WHERE hs.holding_id = v_sub.holding_id;

  v_company_currency := COALESCE(v_company_currency, 'USD');
  v_system_currency := COALESCE(v_system_currency, 'USD');

  -- 3. Determinar si la suscripción está cancelada
  v_sub_canceled := v_sub.status IN ('canceled', 'cancelled');

  -- 4. DELETE RSM rows existentes para esta suscripción
  IF p_from_month IS NULL THEN
    DELETE FROM revenue_schedule_monthly
    WHERE subscription_id = p_subscription_id
      AND is_total_row = false;
  ELSE
    DELETE FROM revenue_schedule_monthly
    WHERE subscription_id = p_subscription_id
      AND period_month >= p_from_month
      AND is_total_row = false;
  END IF;

  -- 5. Iterar invoice_items agrupados por (subscription_item_id, period_month)
  FOR v_row IN
    SELECT
      ii.subscription_item_id,
      DATE_TRUNC('month', i.issue_date)::date AS period_month,
      si.product_name,
      SUM(ii.subtotal_contract_currency) AS amount,
      -- Para calcular momentum: primer y último período por item
      MIN(DATE_TRUNC('month', i.issue_date)::date) OVER (PARTITION BY ii.subscription_item_id) AS item_first_period,
      MAX(DATE_TRUNC('month', i.issue_date)::date) OVER (PARTITION BY ii.subscription_item_id) AS item_last_period
    FROM invoice_items ii
    JOIN invoices i ON i.id = ii.invoice_id
    JOIN subscription_items si ON si.id = ii.subscription_item_id
    WHERE i.subscription_id = p_subscription_id
      AND i.is_active = true
      AND i.status IN ('Emitida', 'Pagada', 'Vencida')
      AND ii.subscription_item_id IS NOT NULL
      AND (p_from_month IS NULL OR DATE_TRUNC('month', i.issue_date)::date >= p_from_month)
    GROUP BY ii.subscription_item_id, DATE_TRUNC('month', i.issue_date)::date, si.product_name
    ORDER BY ii.subscription_item_id, period_month
  LOOP
    -- Resetear acumuladores cuando cambia el subscription_item
    IF v_prev_item_id IS NULL OR v_prev_item_id <> v_row.subscription_item_id THEN
      v_recognized_cum := 0;
      v_billed_cum := 0;
      v_prev_item_id := v_row.subscription_item_id;
    END IF;

    -- Acumulados
    v_recognized_cum := v_recognized_cum + v_row.amount;
    v_billed_cum := v_billed_cum + v_row.amount;

    -- Momentum
    IF v_row.period_month = v_row.item_first_period THEN
      v_momentum := 'NEW';
    ELSIF v_sub_canceled AND v_row.period_month = v_row.item_last_period THEN
      v_momentum := 'CHURN';
    ELSE
      v_momentum := 'BOP';
    END IF;

    -- INSERT RSM row
    INSERT INTO revenue_schedule_monthly (
      id, holding_id, contract_id, subscription_id,
      contract_item_id, subscription_item_id,
      period_month, company_id,
      company_currency, contract_currency, system_currency,

      -- Moneda contrato (base)
      recognized_period_contract_ccy,
      recognized_cum_contract_ccy,
      billed_period_contract_ccy,
      billed_cum_contract_ccy,
      deferred_balance_period_contract_ccy,
      unbilled_balance_period_contract_ccy,
      deferred_balance_eom_contract_ccy,
      unbilled_balance_eom_contract_ccy,
      mrr_period_contract_ccy,
      mrr_period_contracted_contract_ccy,
      cmrr_period_contract_ccy,

      -- Moneda company (placeholder, se llena en apply_fx)
      recognized_period_ccy, recognized_cum_ccy,
      billed_period_ccy, billed_cum_ccy,
      deferred_balance_period_ccy, unbilled_balance_period_ccy,
      deferred_balance_eom_ccy, unbilled_balance_eom_ccy,
      mrr_period_ccy, mrr_period_contracted_ccy, cmrr_period_ccy,

      -- Moneda sistema (placeholder, se llena en apply_fx)
      recognized_period_system_ccy, recognized_cum_system_ccy,
      billed_period_system_ccy, billed_cum_system_ccy,
      deferred_balance_period_system_ccy, unbilled_balance_period_system_ccy,
      deferred_balance_eom_system_ccy, unbilled_balance_eom_system_ccy,
      mrr_period_system_ccy, mrr_period_contracted_system_ccy, cmrr_period_system_ccy,

      -- Metadata
      product_name, momentum, is_total_row, calc_version,
      fx_contract_to_company, fx_contract_to_system,
      fx_to_company_source, fx_to_company_date,
      fx_to_system_source, fx_to_system_date
    ) VALUES (
      gen_random_uuid(), v_sub.holding_id, NULL, p_subscription_id,
      NULL, v_row.subscription_item_id,
      v_row.period_month, v_sub.company_id,
      v_company_currency, v_sub.currency, v_system_currency,

      -- Moneda contrato: recognized = billed = mrr = monto facturado
      v_row.amount,         -- recognized_period
      v_recognized_cum,     -- recognized_cum
      v_row.amount,         -- billed_period
      v_billed_cum,         -- billed_cum
      0, 0, 0, 0,          -- deferred y unbilled = 0
      v_row.amount,         -- mrr_period
      v_row.amount,         -- mrr_period_contracted
      v_row.amount,         -- cmrr_period

      -- Company ccy = 0 (se llena en paso FX)
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,

      -- System ccy = 0 (se llena en paso FX)
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,

      -- Metadata
      v_row.product_name, v_momentum, false, 'v1.0-subscription',
      1, 1, NULL, NULL, NULL, NULL
    );

  END LOOP;
END;
$function$

