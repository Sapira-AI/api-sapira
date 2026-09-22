CREATE OR REPLACE FUNCTION public.check_contract_item_continuity(p_contract_item_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_ci record; v_expected_total numeric; v_actual_total numeric := 0;
  v_gaps jsonb := '[]'::jsonb; v_overlaps jsonb := '[]'::jsonb;
  v_prev_end date; v_prev_item_start date; v_prev_item_end date;
  v_item record; v_n_items int := 0; v_tolerance numeric; v_contract_id uuid;
  v_has_unified boolean := false;
  v_theoretical_monthly numeric; v_override_adjustment numeric := 0;
BEGIN
  SELECT id, start_date, end_date, final_price, contract_id, term_months, monthly_price INTO v_ci
  FROM contract_items WHERE id = p_contract_item_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'contract_item no existe'); END IF;
  -- Esperado considerando overrides de Cantidades Variables (tabla quantities):
  -- para cada período con override dentro del rango del ítem se reemplaza la cuota
  -- teórica (final_price / term_months) por el monto del override. Sin esto, un
  -- ítem variable con consumos reales (o con emisiones ajustadas a real, que viven
  -- como overrides) queda con delta permanente contra su total teórico y bloquea
  -- guardar cualquier cambio del cronograma aunque no toque montos. Misma fórmula
  -- que la validación del header en el front (useRestructureDraft, fix Turboboy
  -- 09-09-2026); casos que destaparon este lado SQL: Farmacias Eos CTR-2026-218 y
  -- STG-Prosegur CTR-2026-38 (Fernanda, 17/18-09-2026).
  v_theoretical_monthly := CASE
    WHEN COALESCE(v_ci.term_months, 0) > 0 THEN v_ci.final_price / v_ci.term_months
    ELSE COALESCE(v_ci.monthly_price, 0) END;
  SELECT COALESCE(SUM(COALESCE(q.amount, q.quantity * q.unit_price) - v_theoretical_monthly), 0)
    INTO v_override_adjustment
  FROM quantities q
  WHERE q.contract_item_id = p_contract_item_id
    AND COALESCE(q.amount, q.quantity * q.unit_price) IS NOT NULL
    AND q.period >= date_trunc('month', v_ci.start_date)::date
    AND (v_ci.end_date IS NULL OR q.period <= v_ci.end_date);
  v_expected_total := ROUND(COALESCE(v_ci.final_price, 0) + v_override_adjustment, 2);
  v_contract_id := v_ci.contract_id;
  v_prev_end := v_ci.start_date - INTERVAL '1 day';
  v_prev_item_start := NULL; v_prev_item_end := NULL;

  FOR v_item IN
    -- Facturas que contienen líneas de ESTE ítem (por contract_item_id, no por
    -- el contract_id del header: así las líneas dentro de un documento
    -- unificado multi-contrato también cuentan para continuidad/conservación).
    WITH target_invoices AS (
      SELECT DISTINCT ii.invoice_id
      FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id
      WHERE ii.contract_item_id = p_contract_item_id
        AND COALESCE(i.is_active, true) = true AND i.status <> 'Cancelada'),
    inv_items AS (
      SELECT ii.id, ii.contract_item_id, ii.billing_period_start, ii.billing_period_end,
        COALESCE(ii.subtotal_contract_currency, ii.total_contract_currency, 0) AS raw_value,
        i.id AS invoice_id, i.amount_contract_currency, i.status, i.invoice_number,
        COALESCE(i.invoice_type, '') AS invoice_type
      FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id
      WHERE ii.invoice_id IN (SELECT invoice_id FROM target_invoices)),
    with_sum AS (SELECT *, SUM(raw_value) OVER (PARTITION BY invoice_id) AS sum_raw FROM inv_items)
    SELECT id, billing_period_start, billing_period_end,
      -- Prorrateo del header solo en facturas normales; en un documento
      -- unificado el header agrega varios contratos (y puede estar en otra
      -- moneda), así que la línea vale por sí misma.
      CASE WHEN invoice_type <> 'Unificada'
             AND amount_contract_currency IS NOT NULL AND amount_contract_currency > 0 AND sum_raw > 0
        THEN ROUND((amount_contract_currency * raw_value / sum_raw)::numeric, 2) ELSE raw_value END AS amount_net,
      status, invoice_number, invoice_type
    FROM with_sum WHERE contract_item_id = p_contract_item_id
    ORDER BY billing_period_start NULLS FIRST, id
  LOOP
    IF v_item.invoice_type IN ('Unificada', 'Consolidada') THEN v_has_unified := true; END IF;
    v_actual_total := v_actual_total + v_item.amount_net;
    v_n_items := v_n_items + 1;
    IF v_item.billing_period_start IS NULL OR v_item.billing_period_end IS NULL THEN
      v_gaps := v_gaps || jsonb_build_object('type', 'missing_period', 'item_id', v_item.id, 'invoice_number', v_item.invoice_number);
      CONTINUE;
    END IF;
    -- Cuota concurrente: mismo (start, end) que anterior → no overlap, no gap
    IF v_prev_item_start IS NOT NULL
       AND v_item.billing_period_start = v_prev_item_start
       AND v_item.billing_period_end = v_prev_item_end THEN
      v_prev_item_start := v_item.billing_period_start;
      v_prev_item_end := v_item.billing_period_end;
      IF v_item.billing_period_end > v_prev_end THEN v_prev_end := v_item.billing_period_end; END IF;
      CONTINUE;
    END IF;
    IF v_item.billing_period_start > (v_prev_end + INTERVAL '1 day')::date THEN
      v_gaps := v_gaps || jsonb_build_object('type', 'period_gap',
        'from', (v_prev_end + INTERVAL '1 day')::date, 'to', (v_item.billing_period_start - INTERVAL '1 day')::date);
    END IF;
    IF v_item.billing_period_start <= v_prev_end THEN
      v_overlaps := v_overlaps || jsonb_build_object('item_id', v_item.id,
        'overlap_start', v_item.billing_period_start, 'previous_ended_at', v_prev_end);
    END IF;
    IF v_item.billing_period_end > v_prev_end THEN v_prev_end := v_item.billing_period_end; END IF;
    v_prev_item_start := v_item.billing_period_start;
    v_prev_item_end := v_item.billing_period_end;
  END LOOP;
  IF v_prev_end < v_ci.end_date THEN
    v_gaps := v_gaps || jsonb_build_object('type', 'tail_gap',
      'from', (v_prev_end + INTERVAL '1 day')::date, 'to', v_ci.end_date);
  END IF;
  IF v_prev_end > v_ci.end_date THEN
    v_overlaps := v_overlaps || jsonb_build_object('type', 'exceeds_contract_end',
      'last_period_end', v_prev_end, 'contract_item_end', v_ci.end_date);
  END IF;
  v_tolerance := GREATEST(0.01, 0.01 * v_n_items);
  RETURN jsonb_build_object('ok', (jsonb_array_length(v_gaps) = 0 AND jsonb_array_length(v_overlaps) = 0 AND ABS(v_expected_total - v_actual_total) <= v_tolerance),
    'expected_total', v_expected_total, 'actual_total', v_actual_total,
    'delta', v_expected_total - v_actual_total, 'tolerance', v_tolerance, 'n_items', v_n_items,
    'gaps', v_gaps, 'overlaps', v_overlaps,
    'has_unified_lines', v_has_unified,
    'contract_item_start', v_ci.start_date, 'contract_item_end', v_ci.end_date);
END; $function$;

COMMENT ON FUNCTION public."check_contract_item_continuity"(p_contract_item_id uuid) IS 'Valida continuidad de períodos y conservación de monto de un contract_item contra sus facturas activas. Busca las líneas por contract_item_id (incluye documentos unificados de otro header) y expone has_unified_lines. Tolerancia GREATEST(0.01, 0.01*n).';
