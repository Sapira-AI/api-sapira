CREATE OR REPLACE FUNCTION public.adjust_issued_invoice(p_invoice_id uuid, p_items jsonb, p_remainder_target text DEFAULT NULL::text, p_new_invoice_date date DEFAULT NULL::date, p_target_invoice_id uuid DEFAULT NULL::uuid, p_notes text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_inv             RECORD;
  v_target          RECORD;
  v_user_holding    uuid;
  v_item            jsonb;
  v_line            RECORD;
  v_sum             numeric := 0;
  v_line_ids        uuid[] := '{}';
  v_existing_count  int;
  v_mode            text;
  v_emitted_sub     numeric;
  v_emitted_qty     numeric;
  v_emitted_tax     numeric;
  v_desc            text;
  v_diff_inv        numeric;
  v_diff_tax        numeric;
  v_diff_ctr        numeric;
  v_rem_qty         numeric;
  v_rem_total_inv   numeric := 0;
  v_rem_total_ctr   numeric := 0;
  v_rem_total_tax   numeric := 0;
  v_rem_lines       int := 0;
  v_updated         int := 0;
  v_deleted         int := 0;
  v_overrides       int := 0;
  v_contract_ids    uuid[] := '{}';
  v_header_fx       numeric;
  v_line_fx         numeric;
  v_tax_ratio       numeric;
  v_old_amount_ctr  numeric;
  v_new_amount_ctr  numeric;
  v_remainder_id    uuid;
  v_new_item_id     uuid;
  v_cid             uuid;
BEGIN
  -- ── Header: existencia, lock y validaciones ────────────────────────────
  SELECT * INTO v_inv FROM invoices WHERE id = p_invoice_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ADJUST_INVOICE_NOT_FOUND: la factura no existe'
      USING ERRCODE = 'P0001';
  END IF;

  IF v_inv.status = 'Por Emitir' THEN
    RAISE EXCEPTION 'ADJUST_ONLY_ISSUED: esta función es solo para facturas ya emitidas; una factura Por Emitir se edita con Reestructurar cronograma'
      USING ERRCODE = 'P0001';
  END IF;

  IF v_inv.is_active IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'ADJUST_INVOICE_INACTIVE: la factura está inactiva (consolidada o reestructurada); ajusta el documento vigente'
      USING ERRCODE = 'P0001';
  END IF;

  v_user_holding := get_current_user_holding_id();
  IF v_user_holding IS NOT NULL AND v_user_holding <> v_inv.holding_id THEN
    RAISE EXCEPTION 'ADJUST_WRONG_HOLDING: la factura no pertenece a tu organización'
      USING ERRCODE = 'P0001';
  END IF;

  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'ADJUST_EMPTY_PAYLOAD: el ajuste debe incluir todas las líneas de la factura'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT count(*) INTO v_existing_count FROM invoice_items WHERE invoice_id = p_invoice_id;
  IF jsonb_array_length(p_items) <> v_existing_count THEN
    RAISE EXCEPTION 'ADJUST_INCOMPLETE_PAYLOAD: el ajuste debe incluir TODAS las líneas de la factura (% líneas, payload trae %)',
      v_existing_count, jsonb_array_length(p_items)
      USING ERRCODE = 'P0001';
  END IF;

  IF p_remainder_target IS NOT NULL AND p_remainder_target NOT IN ('new_invoice', 'existing_invoice') THEN
    RAISE EXCEPTION 'ADJUST_BAD_TARGET: destino de reprogramación inválido (%)', p_remainder_target
      USING ERRCODE = 'P0001';
  END IF;

  v_header_fx := COALESCE(NULLIF(v_inv.fx_contract_to_invoice, 0), 1);
  v_tax_ratio := COALESCE(v_inv.vat, 0) / NULLIF(v_inv.amount_invoice_currency, 0);

  -- ── Pasada 1: validar TODAS las líneas, la suma y la diferencia ────────
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    IF v_item->>'id' IS NULL THEN
      RAISE EXCEPTION 'ADJUST_LINE_INVALID: cada línea del payload debe referir una línea existente de la factura (id)'
        USING ERRCODE = 'P0001';
    END IF;

    SELECT * INTO v_line FROM invoice_items
    WHERE id = (v_item->>'id')::uuid AND invoice_id = p_invoice_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'ADJUST_LINE_INVALID: la línea % no pertenece a esta factura', v_item->>'id'
        USING ERRCODE = 'P0001';
    END IF;

    IF (v_item->>'id')::uuid = ANY(v_line_ids) THEN
      RAISE EXCEPTION 'ADJUST_LINE_INVALID: la línea % aparece dos veces en el payload', v_item->>'id'
        USING ERRCODE = 'P0001';
    END IF;
    v_line_ids := v_line_ids || (v_item->>'id')::uuid;

    v_emitted_sub := ROUND(COALESCE((v_item->>'emitted_subtotal_invoice_currency')::numeric, -1), 2);
    IF v_emitted_sub < 0 THEN
      RAISE EXCEPTION 'ADJUST_LINE_INVALID: la línea "%" requiere el neto realmente emitido (>= 0)', v_line.description
        USING ERRCODE = 'P0001';
    END IF;

    v_emitted_qty := (v_item->>'emitted_quantity')::numeric;
    IF v_emitted_qty IS NOT NULL AND v_emitted_qty <= 0 AND v_emitted_sub > 0 THEN
      RAISE EXCEPTION 'ADJUST_LINE_INVALID: la línea "%" requiere cantidad emitida > 0', v_line.description
        USING ERRCODE = 'P0001';
    END IF;

    v_mode := COALESCE(NULLIF(btrim(v_item->>'mode'), ''), 'reschedule');
    IF v_mode NOT IN ('reschedule', 'override') THEN
      RAISE EXCEPTION 'ADJUST_LINE_INVALID: tratamiento inválido (%) en la línea "%"', v_mode, v_line.description
        USING ERRCODE = 'P0001';
    END IF;

    v_diff_inv := ROUND(COALESCE(v_line.subtotal_invoice_currency, 0) - v_emitted_sub, 2);

    IF v_mode = 'reschedule' THEN
      IF v_diff_inv < -0.005 THEN
        RAISE EXCEPTION 'ADJUST_LINE_INVALID: la línea "%" se emitió por MÁS de lo programado; eso corresponde a una modificación de contrato, no a un ajuste', v_line.description
          USING ERRCODE = 'P0001';
      END IF;
      IF v_diff_inv > 0.005 THEN
        v_rem_total_inv := v_rem_total_inv + v_diff_inv;
        v_rem_lines := v_rem_lines + 1;
      END IF;
    ELSE
      -- override: requiere ítem de contrato, período y cantidad emitida
      IF v_line.contract_item_id IS NULL OR v_line.billing_period_start IS NULL THEN
        RAISE EXCEPTION 'ADJUST_LINE_INVALID: la línea "%" no tiene ítem de contrato o período — no se puede registrar cantidad real', v_line.description
          USING ERRCODE = 'P0001';
      END IF;
      IF v_emitted_qty IS NULL THEN
        RAISE EXCEPTION 'ADJUST_LINE_INVALID: la línea "%" requiere la cantidad emitida para registrar la cantidad real del período', v_line.description
          USING ERRCODE = 'P0001';
      END IF;
    END IF;

    v_sum := v_sum + v_emitted_sub;
  END LOOP;

  -- ── Restricción dura: suma emitida = neto del header EXACTO ────────────
  IF ROUND(v_sum, 2) <> ROUND(v_inv.amount_invoice_currency, 2) THEN
    RAISE EXCEPTION 'ADJUST_SUM_MISMATCH: la suma de los netos emitidos (% %) debe ser exactamente igual al neto del header (% %)',
      to_char(ROUND(v_sum, 2), 'FM999G999G999G990D00'), v_inv.invoice_currency,
      to_char(ROUND(v_inv.amount_invoice_currency, 2), 'FM999G999G999G990D00'), v_inv.invoice_currency
      USING ERRCODE = 'P0001';
  END IF;

  -- ── Validar destino de la reprogramación ───────────────────────────────
  IF v_rem_total_inv > 0.005 THEN
    IF v_inv.invoice_type = 'Unificada' THEN
      RAISE EXCEPTION 'ADJUST_UNIFIED_REMAINDER: en documentos unificados aún no se puede reprogramar diferencia; ajusta con tratamiento de cantidad real o con suma igual al programado'
        USING ERRCODE = 'P0001';
    END IF;

    IF p_remainder_target IS NULL THEN
      RAISE EXCEPTION 'ADJUST_TARGET_REQUIRED: hay % % por reprogramar — elige destino: nueva factura Por Emitir o una Por Emitir existente',
        to_char(ROUND(v_rem_total_inv, 2), 'FM999G999G999G990D00'), v_inv.invoice_currency
        USING ERRCODE = 'P0001';
    END IF;

    IF p_remainder_target = 'new_invoice' AND p_new_invoice_date IS NULL THEN
      RAISE EXCEPTION 'ADJUST_DATE_REQUIRED: indica la fecha programada de la nueva factura Por Emitir'
        USING ERRCODE = 'P0001';
    END IF;

    IF p_remainder_target = 'existing_invoice' THEN
      IF p_target_invoice_id IS NULL THEN
        RAISE EXCEPTION 'ADJUST_TARGET_REQUIRED: indica la factura Por Emitir a la que se une la diferencia'
          USING ERRCODE = 'P0001';
      END IF;
      SELECT * INTO v_target FROM invoices WHERE id = p_target_invoice_id FOR UPDATE;
      IF NOT FOUND OR v_target.holding_id <> v_inv.holding_id THEN
        RAISE EXCEPTION 'ADJUST_TARGET_INVALID: la factura destino no existe'
          USING ERRCODE = 'P0001';
      END IF;
      IF v_target.status <> 'Por Emitir' OR v_target.is_active IS DISTINCT FROM true THEN
        RAISE EXCEPTION 'ADJUST_TARGET_INVALID: la factura destino debe estar Por Emitir y activa'
          USING ERRCODE = 'P0001';
      END IF;
      IF v_target.contract_id IS DISTINCT FROM v_inv.contract_id THEN
        RAISE EXCEPTION 'ADJUST_TARGET_INVALID: la factura destino debe ser del mismo contrato'
          USING ERRCODE = 'P0001';
      END IF;
    END IF;
  END IF;

  -- ── Contratos involucrados (para rebuild RSM) ──────────────────────────
  v_contract_ids := ARRAY(
    SELECT DISTINCT ii.contract_id
    FROM invoice_items ii
    WHERE ii.invoice_id = p_invoice_id AND ii.contract_id IS NOT NULL
  );
  IF v_inv.contract_id IS NOT NULL AND NOT (v_inv.contract_id = ANY(v_contract_ids)) THEN
    v_contract_ids := v_contract_ids || v_inv.contract_id;
  END IF;

  -- ── Crear la factura Por Emitir nueva si corresponde ───────────────────
  IF v_rem_total_inv > 0.005 AND p_remainder_target = 'new_invoice' THEN
    INSERT INTO invoices (
      contract_id, holding_id, client_id, company_id, client_entity_id,
      issue_date, scheduled_at, original_issue_date,
      status, invoice_type, document_type,
      contract_currency, invoice_currency, fx_contract_to_invoice,
      tax_rate, invoice_terms_and_conditions,
      issuer_legal_name, issuer_tax_id, issuer_address,
      split_reason, is_active, auto_invoice,
      client_tax_id, payment_method, invoice_series, fiscal_regime,
      export_type, requires_references_for_billing
    )
    SELECT v_inv.contract_id, v_inv.holding_id, v_inv.client_id, v_inv.company_id, v_inv.client_entity_id,
      p_new_invoice_date, p_new_invoice_date, p_new_invoice_date,
      'Por Emitir', v_inv.invoice_type, COALESCE(v_inv.document_type, 'FACTURA'),
      v_inv.contract_currency, v_inv.invoice_currency, v_inv.fx_contract_to_invoice,
      v_inv.tax_rate, v_inv.invoice_terms_and_conditions,
      v_inv.issuer_legal_name, v_inv.issuer_tax_id, v_inv.issuer_address,
      'post_issue_adjustment', true, COALESCE(v_inv.auto_invoice, false),
      v_inv.client_tax_id, v_inv.payment_method, v_inv.invoice_series, v_inv.fiscal_regime,
      v_inv.export_type, v_inv.requires_references_for_billing
    RETURNING id INTO v_remainder_id;
  ELSIF v_rem_total_inv > 0.005 THEN
    v_remainder_id := p_target_invoice_id;
  END IF;

  -- ── Pasada 2: aplicar por línea ────────────────────────────────────────
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    SELECT * INTO v_line FROM invoice_items
    WHERE id = (v_item->>'id')::uuid AND invoice_id = p_invoice_id;

    v_mode        := COALESCE(NULLIF(btrim(v_item->>'mode'), ''), 'reschedule');
    v_emitted_sub := ROUND((v_item->>'emitted_subtotal_invoice_currency')::numeric, 2);
    v_emitted_qty := COALESCE((v_item->>'emitted_quantity')::numeric, v_line.quantity, 1);
    v_desc        := COALESCE(NULLIF(btrim(v_item->>'description'), ''), v_line.description);
    v_emitted_tax := COALESCE(ROUND((v_item->>'tax_amount_invoice_currency')::numeric, 2),
                              ROUND(v_emitted_sub * COALESCE(v_tax_ratio, 0), 2));
    v_line_fx     := COALESCE(NULLIF(v_line.fx_contract_to_invoice, 0), v_header_fx);
    v_diff_inv    := ROUND(COALESCE(v_line.subtotal_invoice_currency, 0) - v_emitted_sub, 2);
    v_diff_tax    := GREATEST(ROUND(COALESCE(v_line.tax_amount_invoice_currency, 0) - v_emitted_tax, 2), 0);

    IF v_mode = 'reschedule' AND v_emitted_sub <= 0.005 THEN
      -- Nada de esta línea se emitió: sale de la emitida, todo va al destino
      DELETE FROM invoice_items WHERE id = v_line.id;
      v_deleted := v_deleted + 1;
    ELSE
      UPDATE invoice_items SET
        description                   = v_desc,
        quantity                      = v_emitted_qty,
        unit_price_invoice_currency   = ROUND(v_emitted_sub / NULLIF(v_emitted_qty, 0), 6),
        subtotal_invoice_currency     = v_emitted_sub,
        tax_amount_invoice_currency   = v_emitted_tax,
        total_invoice_currency        = v_emitted_sub + v_emitted_tax,
        discount_pct                  = NULL,
        unit_price_contract_currency  = ROUND(v_emitted_sub / NULLIF(v_emitted_qty, 0) / v_line_fx, 6),
        subtotal_contract_currency    = ROUND(v_emitted_sub / v_line_fx, 6),
        tax_amount_contract_currency  = ROUND(v_emitted_tax / v_line_fx, 6),
        total_contract_currency       = ROUND((v_emitted_sub + v_emitted_tax) / v_line_fx, 6)
      WHERE id = v_line.id;
      v_updated := v_updated + 1;
    END IF;

    -- Diferencia reprogramada → línea en la factura destino (patrón A)
    IF v_mode = 'reschedule' AND v_diff_inv > 0.005 AND v_remainder_id IS NOT NULL THEN
      v_rem_qty := CASE
        WHEN v_line.quantity IS NOT NULL AND (v_item->>'emitted_quantity') IS NOT NULL
             AND v_line.quantity - v_emitted_qty > 0
          THEN v_line.quantity - v_emitted_qty
        ELSE 1
      END;

      INSERT INTO invoice_items (
        invoice_id, holding_id, contract_item_id, description, quantity,
        unit_of_measure, billing_period_start, billing_period_end,
        invoice_currency, contract_currency, fx_contract_to_invoice,
        subtotal_invoice_currency, tax_amount_invoice_currency, total_invoice_currency,
        unit_price_invoice_currency
      ) VALUES (
        v_remainder_id, v_inv.holding_id, v_line.contract_item_id, v_line.description, v_rem_qty,
        v_line.unit_of_measure, v_line.billing_period_start, v_line.billing_period_end,
        v_line.invoice_currency, v_line.contract_currency, v_line_fx,
        v_diff_inv, v_diff_tax, v_diff_inv + v_diff_tax,
        ROUND(v_diff_inv / v_rem_qty, 6)
      )
      RETURNING id INTO v_new_item_id;

      UPDATE invoice_items SET
        contract_id                   = v_line.contract_id,
        product_id                    = COALESCE(product_id, v_line.product_id),
        description                   = v_line.description,
        quantity                      = v_rem_qty,
        billing_period_start          = v_line.billing_period_start,
        billing_period_end            = v_line.billing_period_end,
        discount_pct                  = NULL,
        unit_price_invoice_currency   = ROUND(v_diff_inv / v_rem_qty, 6),
        subtotal_invoice_currency     = v_diff_inv,
        tax_amount_invoice_currency   = v_diff_tax,
        total_invoice_currency        = v_diff_inv + v_diff_tax,
        unit_price_contract_currency  = ROUND(v_diff_inv / v_rem_qty / v_line_fx, 6),
        subtotal_contract_currency    = ROUND(v_diff_inv / v_line_fx, 6),
        tax_amount_contract_currency  = ROUND(v_diff_tax / v_line_fx, 6),
        total_contract_currency       = ROUND((v_diff_inv + v_diff_tax) / v_line_fx, 6)
      WHERE id = v_new_item_id;

      v_rem_total_ctr := v_rem_total_ctr + ROUND(v_diff_inv / v_line_fx, 6);
      v_rem_total_tax := v_rem_total_tax + v_diff_tax;
    END IF;

    -- Cantidad real del período (override, bypass del guard)
    IF v_mode = 'override' THEN
      PERFORM set_config('sapira.bypass_quantity_invoice_guard', 'on', true);

      INSERT INTO quantities (contract_item_id, holding_id, contract_id, period,
                              quantity, unit_price, unit_of_measure, notes)
      VALUES (v_line.contract_item_id, v_inv.holding_id, v_line.contract_id,
              date_trunc('month', v_line.billing_period_start)::date,
              v_emitted_qty,
              ROUND(v_emitted_sub / NULLIF(v_emitted_qty, 0) / v_line_fx, 6),
              v_line.unit_of_measure,
              format('Ajuste post-emisión factura %s', COALESCE(v_inv.invoice_number, p_invoice_id::text)))
      ON CONFLICT (contract_item_id, period) DO UPDATE SET
        quantity        = EXCLUDED.quantity,
        unit_price      = EXCLUDED.unit_price,
        unit_of_measure = COALESCE(EXCLUDED.unit_of_measure, quantities.unit_of_measure),
        notes           = EXCLUDED.notes,
        updated_at      = now();

      v_overrides := v_overrides + 1;
    END IF;
  END LOOP;

  -- ── Header de la factura destino: derivar desde sus líneas ─────────────
  IF v_remainder_id IS NOT NULL THEN
    UPDATE invoices i SET
      amount_invoice_currency  = s.sum_inv,
      vat                      = s.sum_tax,
      total_invoice_currency   = s.sum_inv + s.sum_tax,
      amount_contract_currency = s.sum_ctr,
      amount_system_currency   = ROUND(s.sum_ctr / COALESCE(NULLIF(i.fx_contract_to_system, 0), 1), 2),
      total_system_currency    = ROUND(ROUND(s.sum_ctr / COALESCE(NULLIF(i.fx_contract_to_system, 0), 1), 2)
                                       * (1 + COALESCE(i.tax_rate, 0) / 100.0), 2)
    FROM (
      SELECT COALESCE(SUM(subtotal_invoice_currency), 0)  AS sum_inv,
             COALESCE(SUM(tax_amount_invoice_currency), 0) AS sum_tax,
             COALESCE(SUM(subtotal_contract_currency), 0)  AS sum_ctr
      FROM invoice_items WHERE invoice_id = v_remainder_id
    ) s
    WHERE i.id = v_remainder_id;
  END IF;

  -- ── Header emitido: corregir cara en moneda de contrato/sistema ────────
  -- La cara tributaria (amount/vat/total_invoice_currency, FX, folio, fechas)
  -- NO se toca. Para facturas con contract_id el trigger BEFORE UPDATE
  -- auto_populate_invoice_fx_to_system recalcula la cara sistema en cascada;
  -- el UPDATE explícito cubre las unificadas sin contract_id.
  v_old_amount_ctr := v_inv.amount_contract_currency;
  v_new_amount_ctr := ROUND(v_inv.amount_invoice_currency / v_header_fx, 6);

  UPDATE invoices SET
    amount_contract_currency = v_new_amount_ctr,
    amount_system_currency   = ROUND(v_new_amount_ctr / COALESCE(NULLIF(fx_contract_to_system, 0), 1), 2),
    total_system_currency    = ROUND(ROUND(v_new_amount_ctr / COALESCE(NULLIF(fx_contract_to_system, 0), 1), 2)
                                     * (1 + COALESCE(tax_rate, 0) / 100.0), 2)
  WHERE id = p_invoice_id;

  -- ── RSM: rebuild explícito por contrato involucrado ────────────────────
  FOREACH v_cid IN ARRAY v_contract_ids LOOP
    PERFORM revenue_schedule_rebuild(v_cid);
  END LOOP;

  -- ── Historial (best-effort) ────────────────────────────────────────────
  FOREACH v_cid IN ARRAY v_contract_ids LOOP
    BEGIN
      PERFORM log_lifecycle_event(
        v_cid,
        'INVOICE_ADJUSTED_POST_ISSUE',
        'Ajuste de factura emitida',
        CURRENT_DATE,
        NULL,
        format('Factura %s ajustada a lo realmente emitido (neto %s %s)%s',
               COALESCE(v_inv.invoice_number, '(sin número)'),
               to_char(ROUND(v_inv.amount_invoice_currency, 2), 'FM999G999G999G990D00'),
               v_inv.invoice_currency,
               CASE WHEN v_rem_total_inv > 0.005
                 THEN format('; %s %s reprogramados a Por Emitir',
                             to_char(ROUND(v_rem_total_inv, 2), 'FM999G999G999G990D00'),
                             v_inv.invoice_currency)
                 ELSE '' END),
        p_notes,
        jsonb_build_object('invoice_id', p_invoice_id, 'invoice_number', v_inv.invoice_number,
                           'remainder_invoice_id', v_remainder_id),
        'adjustment',
        'Completed'
      );
    EXCEPTION WHEN OTHERS THEN
      NULL; -- sin usuario en contexto (ejecución por SQL): no bloquear el ajuste
    END;
  END LOOP;

  RETURN jsonb_build_object(
    'invoice_id',                   p_invoice_id,
    'invoice_number',               v_inv.invoice_number,
    'lines_updated',                v_updated,
    'lines_deleted',                v_deleted,
    'quantity_overrides',           v_overrides,
    'remainder_invoice_id',         v_remainder_id,
    'remainder_target',             CASE WHEN v_remainder_id IS NULL THEN NULL ELSE p_remainder_target END,
    'remainder_total_invoice_ccy',  ROUND(v_rem_total_inv, 2),
    'amount_invoice_currency',      v_inv.amount_invoice_currency,
    'amount_contract_currency_old', v_old_amount_ctr,
    'amount_contract_currency_new', v_new_amount_ctr,
    'contracts_rebuilt',            v_contract_ids
  );
END;
$function$;

COMMENT ON FUNCTION public."adjust_issued_invoice"(p_invoice_id uuid, p_items jsonb, p_remainder_target text, p_new_invoice_date date, p_target_invoice_id uuid, p_notes text) IS 'P1 #3 (a): ajusta una factura ya emitida al detalle realmente emitido en el
ERP conservando la continuidad del cronograma: la diferencia con lo programado
se reprograma a una factura Por Emitir (nueva o existente del mismo contrato)
o se justifica como cantidad real del período (override en quantities). Header
tributario inmovible; suma de netos emitidos = neto del header exacto. Corrige
la cara en moneda de contrato/sistema del header y dispara rebuild de RSM.';
