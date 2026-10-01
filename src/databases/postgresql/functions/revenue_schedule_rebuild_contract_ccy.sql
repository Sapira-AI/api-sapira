CREATE OR REPLACE FUNCTION public.revenue_schedule_rebuild_contract_ccy(p_contract_id uuid, p_from_month date DEFAULT NULL::date)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
-- Fixes RSM 01-10 (cobertura-contratos-v2 U8, D7/S5-16, U5; decisiones de la dueña 01-10). Sin aplicar: entra con `postgres:assets`.
--  U8     rebuild parcial (p_from_month): el devengo acumulado y los saldos al cierre del mes previo se cargan de la última fila RSM del
--         ítem antes del mes de inicio (en moneda del ítem); antes partían en 0 e inflaban el diferido.
--  S5-16  mensual = contract_items.monthly_price (neto: unitario × cantidad con el descuento; CHURN/DOWNSELL = final ÷ plazo = ΔMRR);
--         final_price solo es TCV. final ÷ plazo queda solo de respaldo sin monthly_price (pago único / filas antiguas). Fracción del mes una vez.
--  U5     CHURN y REACTIVATION prorratean el primer mes por días vivos igual que UPSELL / CROSS-SELL / DOWNSELL.
-- Verificación tras aplicar en QA (un contrato por caso): 1) rebuild(c, NULL) y luego rebuild(c, mes) → mismas filas desde el mes
-- (recognized_cum, deferred/unbilled_eom); 2) UPSELL a mitad de ciclo (Bosch): mes 1 = monthly_price × días/días_mes (180,46, no 169,95);
-- 3) baja early a mitad de ciclo: fila CHURN del mes = −monthly_price × días restantes/días_mes; 4) contrato sin tasa compañía/sistema:
-- *_ccy / *_system_ccy NULL y calc_version missing_fx_rate (revenue_schedule_apply_fx_for_contract).
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
  -- B2-3 (spec modificaciones §9.3.9): día de ciclo del contrato; el de cada ítem = COALESCE(ítem, contrato, MIN(start_date)).
  v_contract_billing_day int;
  -- B2-5 (spec modificaciones §9.3.3): pausas del ítem (contract_item_pauses no canceladas; pause_end NULL = hasta reanudar).
  v_paused_days int;
  v_active_days int;
  v_paused_eom boolean;
  v_paused_open_eom boolean;
  v_momentum text;
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
  -- Multimoneda (spec-multimoneda-contrato §3 #5, §5): los montos del ítem están en SU moneda; la fila se escribe en moneda de contrato
  -- con la tasa fija pactada `purpose = 'item'` (1 [moneda del ítem] = rate [moneda del contrato]; directa o 1/inversa) que cubre el mes.
  -- Sin tasa la fila queda con montos NULL y calc_version 'missing_fx_rate' (nunca 1). Ítems en la moneda del contrato: tasa 1, sin cambio.
  v_item_ccy text;
  v_item_rate NUMERIC;
  v_calc_version text;
  -- Sin vueltas (spec-multimoneda §5, decisión 01-10): ítem en otra moneda que la del contrato pero IGUAL a la de la compañía (o a la del
  -- sistema) → las columnas *_ccy (o *_system_ccy) llevan el monto del ítem tal cual (tasa 1), calculado aquí con los mismos montos en
  -- moneda del ítem que alimentan las columnas de contrato (sin redondear a contrato y volver). Factor 1 = directo, 0 = lo completa
  -- revenue_schedule_apply_fx_for_contract desde la moneda de contrato (que salta las columnas directas).
  v_company_direct NUMERIC;
  v_system_direct NUMERIC;
  v_monthly_price_item NUMERIC(15,2);
  -- U8: mes de inicio normalizado al día 1 y última fila previa del ítem (rebuild parcial).
  v_from_month date := DATE_TRUNC('month', p_from_month)::date;
  v_prev RECORD;
BEGIN
  SELECT c.id, c.holding_id, c.company_id, c.contract_currency, c.billing_anchor_day,
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

  -- B2-3 (§9.3.9): el día guardado del contrato manda; sin él, el del primer recurrente de ciclo del contrato (los de ciclo propio no cuentan).
  SELECT COALESCE(v_contract.billing_anchor_day, EXTRACT(DAY FROM MIN(ci.start_date))::int) INTO v_contract_billing_day
  FROM contract_items ci
  WHERE ci.contract_id = p_contract_id
    AND COALESCE(ci.categoria, '') NOT IN ('DOWNSELL', 'CHURN')
    AND COALESCE(ci.is_recurring, false) = true
    AND ci.billing_anchor_day IS NULL;

  -- FIX 1.4: removido guard COALESCE(is_total_row, false) = false del DELETE
  IF p_from_month IS NULL THEN
    DELETE FROM revenue_schedule_monthly
    WHERE contract_id = p_contract_id
      AND contract_item_id IS NOT NULL;
  ELSE
    DELETE FROM revenue_schedule_monthly
    WHERE contract_id = p_contract_id
      AND period_month >= v_from_month
      AND contract_item_id IS NOT NULL;
  END IF;

  FOR v_item IN SELECT * FROM contract_items WHERE contract_id = p_contract_id ORDER BY start_date, id
  LOOP
    v_first_period := DATE_TRUNC('month', GREATEST(COALESCE(v_from_month, v_contract_start_date), v_contract_start_date))::date;
    v_last_period := DATE_TRUNC('month', v_contract_end_date)::date;
    v_is_recurring := COALESCE(v_item.is_recurring, false);
    -- B2-3 (§9.3.9): día de ciclo del ítem = COALESCE(item.billing_anchor_day, contract.billing_anchor_day, MIN(start_date)).
    v_billing_day := COALESCE(v_item.billing_anchor_day, v_contract_billing_day);
    v_item_ccy := UPPER(TRIM(COALESCE(v_item.currency, v_contract.contract_currency)));
    v_company_direct := CASE WHEN v_item_ccy IS DISTINCT FROM UPPER(TRIM(v_contract.contract_currency))
      AND v_item_ccy = UPPER(TRIM(v_contract.company_currency)) THEN 1 ELSE 0 END;
    v_system_direct := CASE WHEN v_item_ccy IS DISTINCT FROM UPPER(TRIM(v_contract.contract_currency))
      AND v_item_ccy = UPPER(TRIM(v_contract.system_currency)) THEN 1 ELSE 0 END;

    -- S5-16 (D7): el mensual es monthly_price (neto: unitario × cantidad con el descuento; en CHURN/DOWNSELL = ΔMRR). final_price es
    -- TCV: en un UPSELL/CROSS-SELL a mitad de ciclo ya viene por días, y final ÷ plazo × fracción del mes prorrateaba dos veces.
    -- final ÷ plazo solo como respaldo cuando no hay monthly_price (pago único: monthly_price NULL; filas antiguas).
    IF COALESCE(v_item.term_months, 0) > 0 THEN
      v_monthly_revenue := COALESCE(v_item.monthly_price, ROUND(COALESCE(v_item.final_price, 0) / v_item.term_months, 2));
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

    -- U8: rebuild parcial → el devengo acumulado sigue la serie: se carga de la última fila del ítem antes del primer mes, en moneda
    -- del ítem (columna directa si la hay; misma moneda que el contrato tal cual; si no, contrato ÷ tasa item de ese mes). Los saldos
    -- al cierre del mes previo salen de los acumulados (igual que cada _eom del loop). Rebuild completo: sin cambio (todo en 0).
    IF v_from_month IS NOT NULL THEN
      SELECT r.period_month, r.recognized_cum_contract_ccy, r.recognized_cum_ccy, r.recognized_cum_system_ccy
        INTO v_prev
        FROM revenue_schedule_monthly r
       WHERE r.contract_id = p_contract_id
         AND r.contract_item_id = v_item.id
         AND r.period_month < v_first_period
         AND COALESCE(r.is_total_row, false) = false
         AND COALESCE(r.momentum, '') <> 'PENDING_RENEWAL'  -- cola de apply_pending_renewal_tail: acumulados en 0
       -- En el mismo mes manda la fila del rebuild: con acumulado de contrato, y no la del delta de apply_renewal_price_split
       -- (UPSELL/DOWNSELL sobre un RENEWAL, sin acumulados).
       ORDER BY r.period_month DESC, (r.recognized_cum_contract_ccy IS NULL),
         (COALESCE(r.momentum, '') IN ('UPSELL', 'DOWNSELL') AND COALESCE(v_item.categoria, '') = 'RENEWAL')
       LIMIT 1;
      IF FOUND THEN
        v_recognized_cum := COALESCE(
          CASE WHEN v_company_direct = 1 THEN v_prev.recognized_cum_ccy END,
          CASE WHEN v_system_direct = 1 THEN v_prev.recognized_cum_system_ccy END,
          CASE WHEN v_item_ccy = UPPER(TRIM(v_contract.contract_currency)) THEN v_prev.recognized_cum_contract_ccy END,
          ROUND(v_prev.recognized_cum_contract_ccy / NULLIF(public.contract_item_fx_rate(p_contract_id, v_item_ccy, v_contract.contract_currency,
            v_prev.period_month, (v_prev.period_month + INTERVAL '1 month' - INTERVAL '1 day')::date), 0), 2),
          0);
      END IF;
      v_deferred_balance_eom := GREATEST(v_billed_cum - v_recognized_cum, 0);
      v_unbilled_balance_eom := GREATEST(v_recognized_cum - v_billed_cum, 0);
    END IF;

    v_cur := v_first_period;
    WHILE v_cur <= v_last_period LOOP
      v_eom_of_cur := (v_cur + INTERVAL '1 month' - INTERVAL '1 day')::date;
      v_item_rate := public.contract_item_fx_rate(p_contract_id, v_item_ccy, v_contract.contract_currency, v_cur, v_eom_of_cur);
      v_calc_version := CASE
        WHEN v_item_rate IS NULL THEN 'missing_fx_rate'
        WHEN v_item_ccy IS DISTINCT FROM UPPER(TRIM(v_contract.contract_currency)) THEN 'v3.3-multicurrency-item-fx'
        ELSE 'v3.2-nc-discount-2026-07' END;

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
        -- FIX 1.3: prorrateo solo aplica a UPSELL/CROSS-SELL/DOWNSELL; U5 (01-10): también CHURN y REACTIVATION (el espejo de una
        -- baja a mitad de ciclo devenga solo los días vivos del mes, no el mes completo).
        -- Items NEW, RENEWAL, sin categoria nunca prorratean; B2-3 (§9.3.9): un ítem de ciclo propio tampoco (como NEW).
        IF v_is_first_active_period AND v_billing_day IS NOT NULL AND EXTRACT(DAY FROM v_item.start_date)::int <> v_billing_day
           AND v_item.billing_anchor_day IS NULL
           AND COALESCE(v_item.categoria, '') IN ('UPSELL', 'CROSS-SELL', 'DOWNSELL', 'CHURN', 'REACTIVATION') THEN
          v_days_in_month := EXTRACT(DAY FROM (DATE_TRUNC('month', v_item.start_date) + INTERVAL '1 month' - INTERVAL '1 day'))::int;
          v_proration_days := v_days_in_month - EXTRACT(DAY FROM v_item.start_date)::int + 1;
          v_recognized_period := ROUND(v_monthly_revenue * v_proration_days::numeric / v_days_in_month, 2);
        ELSE v_recognized_period := v_monthly_revenue; END IF;
        -- B2-5 (§9.3.3): días pausados del mes (dentro del tramo activo del ítem) → devengo prorrateado por días; mes completo pausado → 0.
        v_active_days := (LEAST(v_eom_of_cur, v_item.end_date) - GREATEST(v_cur, v_item.start_date)) + 1;
        SELECT COALESCE(SUM(GREATEST(0, (LEAST(COALESCE(p.pause_end, v_item.end_date), v_eom_of_cur, v_item.end_date)
                 - GREATEST(p.pause_start, v_cur, v_item.start_date)) + 1)), 0)::int
          INTO v_paused_days
          FROM contract_item_pauses p
         WHERE p.contract_item_id = v_item.id AND p.status <> 'cancelled'
           AND p.pause_start <= v_eom_of_cur AND COALESCE(p.pause_end, v_item.end_date) >= v_cur;
        IF v_paused_days > 0 AND v_active_days > 0 THEN
          v_recognized_period := ROUND(v_recognized_period * GREATEST(v_active_days - v_paused_days, 0)::numeric / v_active_days, 2);
        END IF;
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

      -- B2-5 (§9.3.3): pausado al fin de mes → MRR 0; CMRR se mantiene si la pausa tiene fin (compromiso conocido), 0 si es abierta.
      -- Momentum PAUSE en el primer mes pausado (fin de mes en pausa) y RESUME en el mes del día siguiente al fin de la pausa; sin pausa,
      -- NULL (lo asigna trg_assign_momentum como hasta hoy).
      SELECT COALESCE(bool_or(true), false), COALESCE(bool_or(p.pause_end IS NULL), false)
        INTO v_paused_eom, v_paused_open_eom
        FROM contract_item_pauses p
       WHERE p.contract_item_id = v_item.id AND p.status <> 'cancelled'
         AND p.pause_start <= v_eom_of_cur AND (p.pause_end IS NULL OR p.pause_end >= v_eom_of_cur);
      IF v_paused_eom AND v_is_recurring THEN
        v_mrr_contracted := 0;
        IF v_paused_open_eom THEN v_cmrr := 0; END IF;
      END IF;
      v_momentum := NULL;
      IF v_is_recurring AND v_paused_eom AND EXISTS (
           SELECT 1 FROM contract_item_pauses p
            WHERE p.contract_item_id = v_item.id AND p.status <> 'cancelled' AND DATE_TRUNC('month', p.pause_start)::date = v_cur) THEN
        v_momentum := 'PAUSE';
      ELSIF v_is_recurring AND NOT v_paused_eom AND EXISTS (
           SELECT 1 FROM contract_item_pauses p
            WHERE p.contract_item_id = v_item.id AND p.status <> 'cancelled' AND p.pause_end IS NOT NULL
              AND DATE_TRUNC('month', p.pause_end + 1)::date = v_cur
              AND DATE_TRUNC('month', p.pause_start)::date < v_cur
              AND p.pause_end < v_item.end_date) THEN
        v_momentum := 'RESUME';
      END IF;

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
        gen_random_uuid(), v_contract.holding_id, p_contract_id, v_item.id, v_cur,
        v_contract.company_id, v_contract.company_currency, v_contract.contract_currency, v_contract.system_currency,
        ROUND(v_recognized_period * v_item_rate, 2), ROUND(v_recognized_cum * v_item_rate, 2),
        ROUND(v_billed_period * v_item_rate, 2), ROUND(v_billed_cum * v_item_rate, 2),
        ROUND(v_deferred_balance_period * v_item_rate, 2), ROUND(v_unbilled_balance_period * v_item_rate, 2),
        ROUND(v_deferred_balance_eom * v_item_rate, 2), ROUND(v_unbilled_balance_eom * v_item_rate, 2),
        ROUND(v_mrr_contracted * v_item_rate, 2),
        ROUND(v_mrr_contracted * v_item_rate, 2), ROUND(v_cmrr * v_item_rate, 2),
        -- Sin vueltas: monto del ítem directo si su moneda es la de la compañía / del sistema (si no, 0 y lo completa apply_fx).
        v_recognized_period * v_company_direct, v_recognized_cum * v_company_direct,
        v_billed_period * v_company_direct, v_billed_cum * v_company_direct,
        v_deferred_balance_period * v_company_direct, v_unbilled_balance_period * v_company_direct,
        v_deferred_balance_eom * v_company_direct, v_unbilled_balance_eom * v_company_direct,
        v_mrr_contracted * v_company_direct, v_mrr_contracted * v_company_direct, v_cmrr * v_company_direct,
        v_recognized_period * v_system_direct, v_recognized_cum * v_system_direct,
        v_billed_period * v_system_direct, v_billed_cum * v_system_direct,
        v_deferred_balance_period * v_system_direct, v_unbilled_balance_period * v_system_direct,
        v_deferred_balance_eom * v_system_direct, v_unbilled_balance_eom * v_system_direct,
        v_mrr_contracted * v_system_direct, v_mrr_contracted * v_system_direct, v_cmrr * v_system_direct,
        v_item.product_name, v_calc_version, false,  -- F2 (+ multimoneda)
        -- fx_contract_to_*: con directo, la tasa implícita contrato → compañía/sistema (1 / tasa item; NULL sin tasa item).
        CASE WHEN v_company_direct = 1 THEN ROUND(1.0 / NULLIF(v_item_rate, 0), 10) ELSE 1 END,
        CASE WHEN v_system_direct = 1 THEN ROUND(1.0 / NULLIF(v_item_rate, 0), 10) ELSE 1 END,
        CASE WHEN v_company_direct = 1 THEN 'item_currency_direct' END, NULL,
        CASE WHEN v_system_direct = 1 THEN 'item_currency_direct' END, NULL,
        v_momentum  -- B2-5: PAUSE / RESUME; NULL = trg_assign_momentum
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
      v_monthly_price_item := COALESCE(v_item.monthly_price, v_monthly_revenue);
      v_item_rate := public.contract_item_fx_rate(p_contract_id, v_item_ccy, v_contract.contract_currency, v_tail_period,
        (v_tail_period + INTERVAL '1 month' - INTERVAL '1 day')::date);
      v_monthly_price := ROUND(v_monthly_price_item * v_item_rate, 2);

      IF v_from_month IS NULL OR v_tail_period >= v_from_month THEN
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
          0, ROUND(v_recognized_cum * v_item_rate, 2), 0, ROUND(v_billed_cum * v_item_rate, 2),
          0, 0, 0, 0,
          v_monthly_price, v_monthly_price, v_monthly_price,
          0, v_recognized_cum * v_company_direct, 0, v_billed_cum * v_company_direct, 0, 0, 0, 0,
          v_monthly_price_item * v_company_direct, v_monthly_price_item * v_company_direct, v_monthly_price_item * v_company_direct,
          0, v_recognized_cum * v_system_direct, 0, v_billed_cum * v_system_direct, 0, 0, 0, 0,
          v_monthly_price_item * v_system_direct, v_monthly_price_item * v_system_direct, v_monthly_price_item * v_system_direct,
          v_item.product_name, CASE WHEN v_item_rate IS NULL THEN 'missing_fx_rate' ELSE 'v3.0-contraction-tail' END, false,  -- FIX 1.5
          CASE WHEN v_company_direct = 1 THEN ROUND(1.0 / NULLIF(v_item_rate, 0), 10) ELSE 1 END,
          CASE WHEN v_system_direct = 1 THEN ROUND(1.0 / NULLIF(v_item_rate, 0), 10) ELSE 1 END,
          CASE WHEN v_company_direct = 1 THEN 'item_currency_direct' END, NULL,
          CASE WHEN v_system_direct = 1 THEN 'item_currency_direct' END, NULL,
          'BOP'
        )
        ON CONFLICT (contract_id, contract_item_id, period_month, momentum)
        DO UPDATE SET
          mrr_period_contract_ccy            = EXCLUDED.mrr_period_contract_ccy,
          mrr_period_contracted_contract_ccy = EXCLUDED.mrr_period_contracted_contract_ccy,
          cmrr_period_contract_ccy           = EXCLUDED.cmrr_period_contract_ccy,
          mrr_period_ccy                     = EXCLUDED.mrr_period_ccy,
          mrr_period_contracted_ccy          = EXCLUDED.mrr_period_contracted_ccy,
          cmrr_period_ccy                    = EXCLUDED.cmrr_period_ccy,
          mrr_period_system_ccy              = EXCLUDED.mrr_period_system_ccy,
          mrr_period_contracted_system_ccy   = EXCLUDED.mrr_period_contracted_system_ccy,
          cmrr_period_system_ccy             = EXCLUDED.cmrr_period_system_ccy,
          fx_contract_to_company             = EXCLUDED.fx_contract_to_company,
          fx_contract_to_system              = EXCLUDED.fx_contract_to_system,
          fx_to_company_source               = EXCLUDED.fx_to_company_source,
          fx_to_system_source                = EXCLUDED.fx_to_system_source,
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
          0, ROUND(v_recognized_cum * v_item_rate, 2), 0, ROUND(v_billed_cum * v_item_rate, 2),
          0, 0, 0, 0,
          -v_monthly_price, -v_monthly_price, -v_monthly_price,
          0, v_recognized_cum * v_company_direct, 0, v_billed_cum * v_company_direct, 0, 0, 0, 0,
          -v_monthly_price_item * v_company_direct, -v_monthly_price_item * v_company_direct, -v_monthly_price_item * v_company_direct,
          0, v_recognized_cum * v_system_direct, 0, v_billed_cum * v_system_direct, 0, 0, 0, 0,
          -v_monthly_price_item * v_system_direct, -v_monthly_price_item * v_system_direct, -v_monthly_price_item * v_system_direct,
          v_item.product_name, CASE WHEN v_item_rate IS NULL THEN 'missing_fx_rate' ELSE 'v3.0-contraction-churn' END, false,  -- FIX 1.5
          CASE WHEN v_company_direct = 1 THEN ROUND(1.0 / NULLIF(v_item_rate, 0), 10) ELSE 1 END,
          CASE WHEN v_system_direct = 1 THEN ROUND(1.0 / NULLIF(v_item_rate, 0), 10) ELSE 1 END,
          CASE WHEN v_company_direct = 1 THEN 'item_currency_direct' END, NULL,
          CASE WHEN v_system_direct = 1 THEN 'item_currency_direct' END, NULL,
          'CHURN'
        )
        ON CONFLICT (contract_id, contract_item_id, period_month, momentum)
        DO UPDATE SET
          mrr_period_contract_ccy            = EXCLUDED.mrr_period_contract_ccy,
          mrr_period_contracted_contract_ccy = EXCLUDED.mrr_period_contracted_contract_ccy,
          cmrr_period_contract_ccy           = EXCLUDED.cmrr_period_contract_ccy,
          mrr_period_ccy                     = EXCLUDED.mrr_period_ccy,
          mrr_period_contracted_ccy          = EXCLUDED.mrr_period_contracted_ccy,
          cmrr_period_ccy                    = EXCLUDED.cmrr_period_ccy,
          mrr_period_system_ccy              = EXCLUDED.mrr_period_system_ccy,
          mrr_period_contracted_system_ccy   = EXCLUDED.mrr_period_contracted_system_ccy,
          cmrr_period_system_ccy             = EXCLUDED.cmrr_period_system_ccy,
          fx_contract_to_company             = EXCLUDED.fx_contract_to_company,
          fx_contract_to_system              = EXCLUDED.fx_contract_to_system,
          fx_to_company_source               = EXCLUDED.fx_to_company_source,
          fx_to_system_source                = EXCLUDED.fx_to_system_source,
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
       AND (v_from_month IS NULL OR DATE_TRUNC('month', ci.start_date)::date >= v_from_month)
  LOOP
    BEGIN
      PERFORM apply_renewal_price_split(v_renewal_split_item_id);
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'apply_renewal_price_split falló para item %: %', v_renewal_split_item_id, SQLERRM;
    END;
  END LOOP;
END;
$function$;

COMMENT ON FUNCTION public."revenue_schedule_rebuild_contract_ccy"(p_contract_id uuid, p_from_month date) IS 'Calcula revenue schedule en moneda de contrato. v2.8: CMRR gateado por booking_date del item. v3.3: ítems en otra moneda (multimoneda) convertidos con la tasa fija purpose item; sin tasa, montos NULL y calc_version missing_fx_rate. v3.4 (sin vueltas): ítem en la moneda de la compañía o del sistema escribe esas columnas con su monto directo (fx_to_*_source item_currency_direct), también sin tasa item. v3.5 (01-10): U8 rebuild parcial continúa el devengo acumulado y los saldos desde la última fila previa del ítem; S5-16 mensual = monthly_price (final/term solo de respaldo sin monthly_price); U5 CHURN y REACTIVATION prorratean el primer mes por días.';
