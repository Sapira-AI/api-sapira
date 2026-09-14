CREATE OR REPLACE FUNCTION public.edit_pending_invoice(p_invoice_id uuid, p_items jsonb, p_issue_date date DEFAULT NULL::date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_inv            RECORD;
  v_user_holding   uuid;
  v_item           jsonb;
  v_line           RECORD;
  v_keep_ids       uuid[] := '{}';
  v_updated        int := 0;
  v_inserted       int := 0;
  v_deleted        int := 0;
  v_fx             numeric;
  v_qty            numeric;
  v_price          numeric;
  v_disc           numeric;
  v_subtotal       numeric;
  v_tax            numeric;
  v_desc           text;
  v_uom            text;
  v_bps            date;
  v_bpe            date;
  v_ci_id          uuid;
  v_line_id        uuid;
  v_new_id         uuid;
  v_old_amount     numeric;
  v_new_amount     numeric := 0;
  v_new_vat        numeric := 0;
  v_user_id        uuid;
BEGIN
  -- ── Header: existencia, lock y validaciones ────────────────────────────
  SELECT * INTO v_inv FROM invoices WHERE id = p_invoice_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'EDIT_INVOICE_NOT_FOUND: la factura no existe'
      USING ERRCODE = 'P0001';
  END IF;

  IF v_inv.status <> 'Por Emitir' THEN
    RAISE EXCEPTION 'EDIT_ONLY_PENDING: solo se pueden editar facturas Por Emitir; una factura emitida se corrige con "Ajustar a lo emitido"'
      USING ERRCODE = 'P0001';
  END IF;

  IF v_inv.is_active IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'EDIT_INVOICE_INACTIVE: la factura está inactiva (consolidada o reestructurada)'
      USING ERRCODE = 'P0001';
  END IF;

  v_user_holding := get_current_user_holding_id();
  IF v_user_holding IS NOT NULL AND v_user_holding <> v_inv.holding_id THEN
    RAISE EXCEPTION 'EDIT_WRONG_HOLDING: la factura no pertenece a tu organización'
      USING ERRCODE = 'P0001';
  END IF;

  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'EDIT_EMPTY_PAYLOAD: la factura debe quedar con al menos una línea'
      USING ERRCODE = 'P0001';
  END IF;

  v_fx := COALESCE(NULLIF(v_inv.fx_contract_to_invoice, 0), 1);
  v_old_amount := COALESCE(v_inv.amount_invoice_currency, 0);

  -- ── Pasada 1: validar TODAS las líneas antes de tocar nada ─────────────
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_desc  := btrim(COALESCE(v_item->>'description', ''));
    v_qty   := COALESCE((v_item->>'quantity')::numeric, 0);
    v_price := COALESCE((v_item->>'unit_price_invoice_currency')::numeric, -1);
    v_disc  := COALESCE((v_item->>'discount_pct')::numeric, 0);
    v_bps   := (v_item->>'billing_period_start')::date;
    v_bpe   := (v_item->>'billing_period_end')::date;
    v_ci_id := (v_item->>'contract_item_id')::uuid;

    IF v_desc = '' THEN
      RAISE EXCEPTION 'EDIT_LINE_INVALID: cada línea requiere descripción'
        USING ERRCODE = 'P0001';
    END IF;
    IF v_qty <= 0 THEN
      RAISE EXCEPTION 'EDIT_LINE_INVALID: la línea "%" requiere cantidad > 0', v_desc
        USING ERRCODE = 'P0001';
    END IF;
    IF v_price < 0 THEN
      RAISE EXCEPTION 'EDIT_LINE_INVALID: la línea "%" requiere precio unitario >= 0', v_desc
        USING ERRCODE = 'P0001';
    END IF;
    IF v_disc < 0 OR v_disc > 100 THEN
      RAISE EXCEPTION 'EDIT_LINE_INVALID: la línea "%" tiene descuento fuera de rango (0-100)', v_desc
        USING ERRCODE = 'P0001';
    END IF;
    IF v_bps IS NOT NULL AND v_bpe IS NOT NULL AND v_bpe < v_bps THEN
      RAISE EXCEPTION 'EDIT_LINE_INVALID: la línea "%" tiene período con fin anterior al inicio', v_desc
        USING ERRCODE = 'P0001';
    END IF;

    IF v_item->>'id' IS NOT NULL THEN
      IF NOT EXISTS (SELECT 1 FROM invoice_items WHERE id = (v_item->>'id')::uuid AND invoice_id = p_invoice_id) THEN
        RAISE EXCEPTION 'EDIT_LINE_INVALID: la línea % no pertenece a esta factura', v_item->>'id'
          USING ERRCODE = 'P0001';
      END IF;
    END IF;

    IF v_ci_id IS NOT NULL THEN
      IF NOT EXISTS (
        SELECT 1 FROM contract_items ci JOIN contracts c ON c.id = ci.contract_id
        WHERE ci.id = v_ci_id AND c.holding_id = v_inv.holding_id
      ) THEN
        RAISE EXCEPTION 'EDIT_LINE_INVALID: el ítem de contrato de la línea "%" no existe o pertenece a otra organización', v_desc
          USING ERRCODE = 'P0001';
      END IF;
    END IF;
  END LOOP;

  -- ── Pasada 2: aplicar el detalle (reemplazo total) ─────────────────────
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_desc     := btrim(v_item->>'description');
    v_qty      := (v_item->>'quantity')::numeric;
    v_price    := (v_item->>'unit_price_invoice_currency')::numeric;
    v_disc     := COALESCE((v_item->>'discount_pct')::numeric, 0);
    v_uom      := NULLIF(btrim(COALESCE(v_item->>'unit_of_measure', '')), '');
    v_bps      := (v_item->>'billing_period_start')::date;
    v_bpe      := (v_item->>'billing_period_end')::date;
    v_ci_id    := (v_item->>'contract_item_id')::uuid;
    v_subtotal := ROUND(v_qty * v_price * (1 - v_disc / 100.0), 2);
    v_tax      := ROUND(v_subtotal * COALESCE(v_inv.tax_rate, 0) / 100.0, 2);

    IF v_item->>'id' IS NOT NULL THEN
      -- Línea existente → UPDATE (no pasa por standardize: BEFORE INSERT only).
      -- Si el payload no trae período/ítem, se conservan los actuales.
      v_line_id := (v_item->>'id')::uuid;
      SELECT * INTO v_line FROM invoice_items WHERE id = v_line_id;

      UPDATE invoice_items SET
        contract_item_id              = COALESCE(v_ci_id, v_line.contract_item_id),
        description                   = v_desc,
        quantity                      = v_qty,
        unit_of_measure               = COALESCE(v_uom, v_line.unit_of_measure),
        discount_pct                  = NULLIF(v_disc, 0),
        billing_period_start          = COALESCE(v_bps, v_line.billing_period_start),
        billing_period_end            = COALESCE(v_bpe, v_line.billing_period_end),
        unit_price_invoice_currency   = v_price,
        subtotal_invoice_currency     = v_subtotal,
        tax_amount_invoice_currency   = v_tax,
        total_invoice_currency        = v_subtotal + v_tax,
        unit_price_contract_currency  = ROUND(v_price / v_fx, 6),
        subtotal_contract_currency    = ROUND(v_subtotal / v_fx, 6),
        tax_amount_contract_currency  = ROUND(v_tax / v_fx, 6),
        total_contract_currency       = ROUND((v_subtotal + v_tax) / v_fx, 6)
      WHERE id = v_line_id;

      v_keep_ids := v_keep_ids || v_line_id;
      v_updated  := v_updated + 1;
    ELSE
      -- Línea nueva → INSERT (standardize la pisa si trae ítem) + UPDATE (patrón A)
      INSERT INTO invoice_items (
        invoice_id, holding_id, contract_item_id, description, quantity,
        unit_of_measure, billing_period_start, billing_period_end,
        invoice_currency, contract_currency, fx_contract_to_invoice,
        subtotal_invoice_currency, tax_amount_invoice_currency, total_invoice_currency,
        unit_price_invoice_currency
      ) VALUES (
        p_invoice_id, v_inv.holding_id, v_ci_id, v_desc, v_qty,
        COALESCE(v_uom, 'UND'), v_bps, v_bpe,
        v_inv.invoice_currency, v_inv.contract_currency, v_inv.fx_contract_to_invoice,
        v_subtotal, v_tax, v_subtotal + v_tax,
        v_price
      )
      RETURNING id INTO v_new_id;

      UPDATE invoice_items SET
        description                   = v_desc,
        quantity                      = v_qty,
        unit_of_measure               = COALESCE(v_uom, 'UND'),
        discount_pct                  = NULLIF(v_disc, 0),
        billing_period_start          = v_bps,
        billing_period_end            = v_bpe,
        unit_price_invoice_currency   = v_price,
        subtotal_invoice_currency     = v_subtotal,
        tax_amount_invoice_currency   = v_tax,
        total_invoice_currency        = v_subtotal + v_tax,
        unit_price_contract_currency  = ROUND(v_price / v_fx, 6),
        subtotal_contract_currency    = ROUND(v_subtotal / v_fx, 6),
        tax_amount_contract_currency  = ROUND(v_tax / v_fx, 6),
        total_contract_currency       = ROUND((v_subtotal + v_tax) / v_fx, 6)
      WHERE id = v_new_id;

      v_keep_ids := v_keep_ids || v_new_id;
      v_inserted := v_inserted + 1;
    END IF;

    v_new_amount := v_new_amount + v_subtotal;
    v_new_vat    := v_new_vat + v_tax;
  END LOOP;

  -- ── Eliminar líneas ausentes del payload ───────────────────────────────
  DELETE FROM invoice_items
  WHERE invoice_id = p_invoice_id
    AND NOT (id = ANY(v_keep_ids));
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  -- ── Header derivado de las líneas (+ fecha opcional) ───────────────────
  -- La cara sistema la recalcula auto_populate_invoice_fx_to_system (BEFORE
  -- UPDATE) desde amount_contract_currency + tax_rate.
  UPDATE invoices SET
    amount_invoice_currency  = v_new_amount,
    vat                      = v_new_vat,
    total_invoice_currency   = v_new_amount + v_new_vat,
    amount_contract_currency = ROUND(v_new_amount / v_fx, 6),
    scheduled_at             = COALESCE(p_issue_date, scheduled_at),
    original_issue_date      = COALESCE(p_issue_date, original_issue_date),
    issue_date               = COALESCE(p_issue_date, issue_date)
  WHERE id = p_invoice_id;

  -- ── Auditoría (best-effort) + RSM ──────────────────────────────────────
  BEGIN
    SELECT u.id INTO v_user_id FROM users u WHERE u.auth_id = auth.uid();
    INSERT INTO invoice_adjustments (invoice_id, holding_id, type, amount_diff, adjusted_by)
    VALUES (p_invoice_id, v_inv.holding_id, 'edit', ROUND(v_new_amount - v_old_amount, 2), v_user_id);
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  IF v_inv.contract_id IS NOT NULL THEN
    PERFORM revenue_schedule_rebuild(v_inv.contract_id);
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'amount_diff', ROUND(v_new_amount - v_old_amount, 2),
    'message', format('Factura actualizada: %s líneas editadas, %s nuevas, %s eliminadas',
                      v_updated, v_inserted, v_deleted)
  );
END;
$function$

