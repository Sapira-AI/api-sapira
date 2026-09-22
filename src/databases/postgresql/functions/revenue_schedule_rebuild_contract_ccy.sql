CREATE OR REPLACE FUNCTION public.revenue_schedule_rebuild_contract_ccy(p_contract_id uuid, p_from_month date DEFAULT NULL::date)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_contract RECORD;
  v_item RECORD;
  v_first_period date;
  v_last_period date;
  v_cur date;
  v_eom_of_cur date;
  v_monthly_revenue NUMERIC(15,2);
  v_recognized_period NUMERIC(15,2);
  v_billed_period NUMERIC(15,2);
  v_recognized_cum NUMERIC(15,2);
  v_billed_cum NUMERIC(15,2);
  v_billed_cum_initial NUMERIC(15,2);
  v_deferred_balance_period NUMERIC(15,2);
  v_unbilled_balance_period NUMERIC(15,2);
  v_deferred_balance_eom NUMERIC(15,2);
  v_unbilled_balance_eom NUMERIC(15,2) := 0;
  v_is_recurring boolean;
  v_contract_start_date date;
  v_contract_end_date date;
  v_mrr_contracted NUMERIC(15,2);
  v_cmrr NUMERIC(15,2);
  v_billing_day int;
  v_is_first_active_period boolean;
  v_days_in_month int;
  v_proration_days int;
  v_tail_period date;
  v_monthly_price NUMERIC(15,2);
  v_renewal_split_item_id uuid;
  -- F2: ajuste de revenue por NC de descuento clasificadas
  v_item_start_month date;
  v_item_active_end_month date;
  v_nc_rev_adj NUMERIC(15,2);
  v_in_active boolean;
BEGIN
  SELECT c.id, c.holding_id, c.company_id, c.contract_currency,
    co.currency AS company_currency, COALESCE(hs.system_currency, 'USD') AS system_currency
  INTO v_contract
  FROM contracts c
  JOIN companies co ON co.id = c.company_id
  LEFT JOIN holding_settings hs ON hs.holding_id = c.holding_id
  WHERE c.id = p_contract_id;

  IF NOT FOUND THEN RAISE EXCEPTION 'Contract % not found', p_contract_id; END IF;

  SELECT MIN(LEAST(COALESCE(booking_date, start_date), start_date)), MAX(end_date)
  INTO v_contract_start_date, v_contract_end_date
  FROM contract_items WHERE contract_id = p_contract_id;

  IF v_contract_start_date IS NULL OR v_contract_end_date IS NULL THEN
    RAISE NOTICE 'Contract % has no items with valid dates, skipping', p_contract_id; RETURN;
  END IF;

  -- FIX 1.2 (extensión): el WHILE no se topa con el MAX(end_date) de items.
  -- Si hay facturas emitidas con issue_date posterior, el rebuild debe llegar
  -- hasta ese mes para capturar su billing. Si se quiere cerrar el período
  -- contractualmente, debe hacerse con CHURN o DOWNSELL, no truncando el WHILE.
  v_contract_end_date := GREATEST(
    v_contract_end_date,
    COALESCE(
      (SELECT MAX(DATE_TRUNC('month', i.issue_date)::date)
       FROM invoices i
       WHERE (i.contract_id = p_contract_id
            OR EXISTS (SELECT 1 FROM invoice_items ii2
                         JOIN contract_items ci2 ON ci2.id = ii2.contract_item_id
                        WHERE ii2.invoice_id = i.id AND ci2.contract_id = p_contract_id))
         AND i.is_active = true
         AND i.status IN ('Emitida', 'Enviada', 'Pagada', 'Vencida')),
      v_contract_end_date
    )
  );

  SELECT EXTRACT(DAY FROM MIN(ci.start_date))::int INTO v_billing_day
  FROM contract_items ci
  WHERE ci.contract_id = p_contract_id
    AND COALESCE(ci.categoria, '') NOT IN ('DOWNSELL', 'CHURN')
    AND COALESCE(ci.is_recurring, false) = true;

  -- FIX 1.4: removido guard COALESCE(is_total_row, false) = false del DELETE
  IF p_from_month IS NULL THEN
    DELETE FROM revenue_schedule_monthly
    WHERE contract_id = p_contract_id
      AND contract_item_id IS NOT NULL;
  ELSE
    DELETE FROM revenue_schedule_monthly
    WHERE contract_id = p_contract_id
      AND period_month >= p_from_month
      AND contract_item_id IS NOT NULL;
  END IF;

  FOR v_item IN SELECT * FROM contract_items WHERE contract_id = p_contract_id ORDER BY start_date, id
  LOOP
    v_first_period := DATE_TRUNC('month', GREATEST(COALESCE(p_from_month, v_contract_start_date), v_contract_start_date))::date;
    v_last_period := DATE_TRUNC('month', v_contract_end_date)::date;
    v_is_recurring := COALESCE(v_item.is_recurring, false);

    IF COALESCE(v_item.term_months, 0) > 0 THEN
      v_monthly_revenue := ROUND(COALESCE(v_item.final_price, 0) / v_item.term_months, 2);
    ELSE v_monthly_revenue := 0; END IF;

    -- F2: ventana activa del ítem en meses (para el devengo de NC defer_forward)
    v_item_start_month := DATE_TRUNC('month', v_item.start_date)::date;
    IF COALESCE(v_item.term_months, 0) > 0 THEN
      v_item_active_end_month := LEAST(
        DATE_TRUNC('month', v_item.end_date)::date,
        (v_item_start_month + ((v_item.term_months - 1) || ' months')::interval)::date
      );
    ELSE
      v_item_active_end_month := DATE_TRUNC('month', v_item.end_date)::date;
    END IF;

    -- FIX 1.1: agregado 'Emitida' al filtro de status
    SELECT COALESCE(SUM(ii.subtotal_contract_currency), 0) INTO v_billed_cum_initial
    FROM invoices i JOIN invoice_items ii ON ii.invoice_id = i.id
    WHERE ii.contract_item_id = v_item.id
      AND i.is_active = true AND i.status IN ('Emitida', 'Enviada', 'Pagada', 'Vencida') AND i.issue_date < v_first_period;

    v_recognized_cum := 0; v_billed_cum := v_billed_cum_initial;
    v_deferred_balance_eom := 0; v_unbilled_balance_eom := 0;

    v_cur := v_first_period;
    WHILE v_cur <= v_last_period LOOP
      v_eom_of_cur := (v_cur + INTERVAL '1 month' - INTERVAL '1 day')::date;

      -- FIX 1.2 + FIX 1.1: SELECT de billing siempre se ejecuta (esté el item
      -- activo o no en este mes). Solo se conecta por contract_item_id y se
      -- asigna al mes de issue_date — sin filtro de rango [start, end] del
      -- item. Eso captura billing pre-start y post-end-date.
      -- FIX 1.1: 'Emitida' agregado al filtro de status.
      -- Nota F2: las líneas de NC vinculadas (subtotal negativo, NC 'Emitida')
      -- entran a este SUM y netean billed automáticamente.
      SELECT COALESCE(SUM(ii.subtotal_contract_currency), 0) INTO v_billed_period
      FROM invoices i JOIN invoice_items ii ON ii.invoice_id = i.id
      WHERE ii.contract_item_id = v_item.id
        AND i.is_active = true AND i.status IN ('Emitida', 'Enviada', 'Pagada', 'Vencida') AND DATE_TRUNC('month', i.issue_date)::date = v_cur;

      v_billed_cum := v_billed_cum + v_billed_period;

      -- FIX 2.1: condición del IF activo cubre EXACTAMENTE term_months periodos
      -- desde mes(start_date). Se conserva el guard del rango calendario como
      -- salvaguarda contra term_months mal definidos.
      --
      -- Si end_date es mid-month, el mes calendario del end_date cae fuera del
      -- rango [mes(start), mes(start) + term_months meses), por lo que la
      -- iteración del WHILE para ese mes pasa al ELSE: la fila se sigue
      -- insertando (porque el INSERT está en el WHILE, no en el IF), pero
      -- con recognized_period=0 y recognized_cum heredado del mes anterior
      -- (no se infla el devengo). Comportamiento idéntico al de cualquier
      -- mes posterior al término del item.
      IF v_cur >= DATE_TRUNC('month', v_item.start_date)::date
         AND v_cur <= DATE_TRUNC('month', v_item.end_date)::date
         AND v_cur < (DATE_TRUNC('month', v_item.start_date)
                      + (COALESCE(v_item.term_months, 0) || ' months')::interval)::date THEN
        v_in_active := true;
        v_is_first_active_period := (v_cur = DATE_TRUNC('month', v_item.start_date)::date);
        -- FIX 1.3: prorrateo solo aplica a UPSELL/CROSS-SELL/DOWNSELL.
        -- Items NEW, RENEWAL, REACTIVATION, sin categoria nunca prorratean.
        IF v_is_first_active_period AND v_billing_day IS NOT NULL AND EXTRACT(DAY FROM v_item.start_date)::int <> v_billing_day
           AND COALESCE(v_item.categoria, '') IN ('UPSELL', 'CROSS-SELL', 'DOWNSELL') THEN
          v_days_in_month := EXTRACT(DAY FROM (DATE_TRUNC('month', v_item.start_date) + INTERVAL '1 month' - INTERVAL '1 day'))::int;
          v_proration_days := v_days_in_month - EXTRACT(DAY FROM v_item.start_date)::int + 1;
          v_recognized_period := ROUND(v_monthly_revenue * v_proration_days::numeric / v_days_in_month, 2);
        ELSE v_recognized_period := v_monthly_revenue; END IF;
      ELSE
        -- Item no activo en este mes. v_billed_period puede ser > 0 (capturado arriba).
        v_in_active := false;
        v_recognized_period := 0;
      END IF;

      -- F2: ajuste de revenue por NC de descuento clasificadas (impact_month /
      -- defer_forward). 0 para contratos sin NC clasificadas → cálculo idéntico
      -- al anterior. Se aplica también en meses fuera de la ventana activa
      -- (ej. NC emitida después del término del ítem con impact_month).
      v_nc_rev_adj := public.nc_discount_revenue_adjustment(
        p_contract_id, v_item.id, v_cur, v_item_start_month, v_item_active_end_month
      );
      v_recognized_period := v_recognized_period + v_nc_rev_adj;
      v_recognized_cum := v_recognized_cum + v_recognized_period;

      IF v_in_active THEN
        v_deferred_balance_period := -LEAST(v_recognized_period, GREATEST(v_deferred_balance_eom, 0));
        v_unbilled_balance_period := v_recognized_period + v_deferred_balance_period;
      ELSE
        -- recognized no se acumula (salvo ajuste NC). deferred/unbilled del período = 0.
        v_deferred_balance_period := 0; v_unbilled_balance_period := 0;
      END IF;
      -- Los _eom se recalculan con los cum actualizados.
      v_deferred_balance_eom := GREATEST(v_billed_cum - v_recognized_cum, 0);
      v_unbilled_balance_eom := GREATEST(v_recognized_cum - v_billed_cum, 0);

      IF v_item.start_date <= v_eom_of_cur
         AND v_item.end_date >= v_eom_of_cur
         AND v_is_recurring THEN
        v_mrr_contracted := COALESCE(v_item.monthly_price, v_monthly_revenue);
      ELSE v_mrr_contracted := 0; END IF;

      IF v_is_recurring
         AND COALESCE(v_item.booking_date, v_item.start_date) <= v_eom_of_cur
         AND v_item.end_date >= v_eom_of_cur
      THEN
        v_cmrr := COALESCE(v_item.monthly_price, v_monthly_revenue);
      ELSE v_cmrr := 0; END IF;

      INSERT INTO revenue_schedule_monthly(
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
        recognized_period_system_ccy, recognized_cum_system_ccy, billed_period_system_ccy, billed_cum_system_ccy,
        deferred_balance_period_system_ccy, unbilled_balance_period_system_ccy,
        deferred_balance_eom_system_ccy, unbilled_balance_eom_system_ccy,
        mrr_period_system_ccy, mrr_period_contracted_system_ccy, cmrr_period_system_ccy,
        product_name, calc_version, is_total_row,
        fx_contract_to_company, fx_contract_to_system,
        fx_to_company_source, fx_to_company_date, fx_to_system_source, fx_to_system_date
      ) VALUES (
        gen_random_uuid(), v_contract.holding_id, p_contract_id, v_item.id, v_cur,
        v_contract.company_id, v_contract.company_currency, v_contract.contract_currency, v_contract.system_currency,
        v_recognized_period, v_recognized_cum, v_billed_period, v_billed_cum,
        v_deferred_balance_period, v_unbilled_balance_period, v_deferred_balance_eom, v_unbilled_balance_eom,
        v_mrr_contracted,
        v_mrr_contracted, v_cmrr,
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        v_item.product_name, 'v3.2-nc-discount-2026-07', false,  -- F2
        1, 1, NULL, NULL, NULL, NULL
      );
      v_cur := (v_cur + INTERVAL '1 month')::date;
    END LOOP;

    IF v_item.churn_date IS NOT NULL
       AND COALESCE(v_item.categoria, '') NOT IN ('CHURN', 'DOWNSELL')
       AND v_item.end_date IS NOT NULL
       AND v_is_recurring
       AND DATE_TRUNC('month', v_item.churn_date)::date > DATE_TRUNC('month', v_item.end_date)::date
    THEN
      v_tail_period := DATE_TRUNC('month', v_item.churn_date)::date;
      v_monthly_price := COALESCE(v_item.monthly_price, v_monthly_revenue);

      IF p_from_month IS NULL OR v_tail_period >= p_from_month THEN
        INSERT INTO revenue_schedule_monthly(
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
          recognized_period_system_ccy, recognized_cum_system_ccy, billed_period_system_ccy, billed_cum_system_ccy,
          deferred_balance_period_system_ccy, unbilled_balance_period_system_ccy,
          deferred_balance_eom_system_ccy, unbilled_balance_eom_system_ccy,
          mrr_period_system_ccy, mrr_period_contracted_system_ccy, cmrr_period_system_ccy,
          product_name, calc_version, is_total_row,
          fx_contract_to_company, fx_contract_to_system,
          fx_to_company_source, fx_to_company_date, fx_to_system_source, fx_to_system_date,
          momentum
        ) VALUES (
          gen_random_uuid(), v_contract.holding_id, p_contract_id, v_item.id, v_tail_period,
          v_contract.company_id, v_contract.company_currency, v_contract.contract_currency, v_contract.system_currency,
          0, v_recognized_cum, 0, v_billed_cum,
          0, 0, 0, 0,
          v_monthly_price, v_monthly_price, v_monthly_price,
          0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
          0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
          v_item.product_name, 'v3.0-contraction-tail', false,  -- FIX 1.5
          1, 1, NULL, NULL, NULL, NULL,
          'BOP'
        )
        ON CONFLICT (contract_id, contract_item_id, period_month, momentum)
        DO UPDATE SET
          mrr_period_contract_ccy            = EXCLUDED.mrr_period_contract_ccy,
          mrr_period_contracted_contract_ccy = EXCLUDED.mrr_period_contracted_contract_ccy,
          cmrr_period_contract_ccy           = EXCLUDED.cmrr_period_contract_ccy,
          product_name                       = EXCLUDED.product_name,
          calc_version                       = EXCLUDED.calc_version;

        INSERT INTO revenue_schedule_monthly(
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
          recognized_period_system_ccy, recognized_cum_system_ccy, billed_period_system_ccy, billed_cum_system_ccy,
          deferred_balance_period_system_ccy, unbilled_balance_period_system_ccy,
          deferred_balance_eom_system_ccy, unbilled_balance_eom_system_ccy,
          mrr_period_system_ccy, mrr_period_contracted_system_ccy, cmrr_period_system_ccy,
          product_name, calc_version, is_total_row,
          fx_contract_to_company, fx_contract_to_system,
          fx_to_company_source, fx_to_company_date, fx_to_system_source, fx_to_system_date,
          momentum
        ) VALUES (
          gen_random_uuid(), v_contract.holding_id, p_contract_id, v_item.id, v_tail_period,
          v_contract.company_id, v_contract.company_currency, v_contract.contract_currency, v_contract.system_currency,
          0, v_recognized_cum, 0, v_billed_cum,
          0, 0, 0, 0,
          -v_monthly_price, -v_monthly_price, -v_monthly_price,
          0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
          0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
          v_item.product_name, 'v3.0-contraction-churn', false,  -- FIX 1.5
          1, 1, NULL, NULL, NULL, NULL,
          'CHURN'
        )
        ON CONFLICT (contract_id, contract_item_id, period_month, momentum)
        DO UPDATE SET
          mrr_period_contract_ccy            = EXCLUDED.mrr_period_contract_ccy,
          mrr_period_contracted_contract_ccy = EXCLUDED.mrr_period_contracted_contract_ccy,
          cmrr_period_contract_ccy           = EXCLUDED.cmrr_period_contract_ccy,
          product_name                       = EXCLUDED.product_name,
          calc_version                       = EXCLUDED.calc_version;
      END IF;
    END IF;
  END LOOP;

  FOR v_renewal_split_item_id IN
    SELECT ci.id
      FROM contract_items ci
     WHERE ci.contract_id = p_contract_id
       AND COALESCE(ci.categoria, '') = 'RENEWAL'
       AND ci.renewal_base_unit_price IS NOT NULL
       AND (p_from_month IS NULL OR DATE_TRUNC('month', ci.start_date)::date >= p_from_month)
  LOOP
    BEGIN
      PERFORM apply_renewal_price_split(v_renewal_split_item_id);
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'apply_renewal_price_split falló para item %: %', v_renewal_split_item_id, SQLERRM;
    END;
  END LOOP;
END;
$function$;

COMMENT ON FUNCTION public."revenue_schedule_rebuild_contract_ccy"(p_contract_id uuid, p_from_month date) IS 'Calcula revenue schedule en moneda de contrato. v2.8: CMRR gateado por booking_date del item.';
