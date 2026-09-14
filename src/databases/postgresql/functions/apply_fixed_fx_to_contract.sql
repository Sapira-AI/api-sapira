CREATE OR REPLACE FUNCTION public.apply_fixed_fx_to_contract(p_contract_id uuid, p_fx_rate numeric, p_policy text DEFAULT 'fixed'::text, p_invoice_ids uuid[] DEFAULT NULL::uuid[], p_target_amount numeric DEFAULT NULL::numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_holding_id       uuid;
  v_updated_invoices integer := 0;
  v_updated_items    integer := 0;
  v_invoice          RECORD;
  v_base             numeric;
  v_fx               numeric;
  v_tax_rate         numeric;
  v_diff             numeric;
  v_max_item_id      uuid;
BEGIN
  -- Validar política
  IF p_policy NOT IN ('fixed', 'spot') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Política FX inválida (use fixed|spot)');
  END IF;

  -- Holding del usuario actual (scoping equivalente a RLS bajo SECURITY DEFINER)
  v_holding_id := get_current_user_holding_id();
  IF v_holding_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'No se pudo resolver el holding del usuario');
  END IF;

  -- El contrato debe existir y pertenecer al holding del usuario
  IF NOT EXISTS (
    SELECT 1 FROM contracts
    WHERE id = p_contract_id AND holding_id = v_holding_id
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Contrato no encontrado o sin acceso');
  END IF;

  -- 1) Política FX de facturación del contrato
  UPDATE contracts
  SET fx_invoice_policy      = p_policy,
      fx_invoice_confirmed_at = CASE WHEN p_policy = 'fixed' THEN now() ELSE fx_invoice_confirmed_at END
  WHERE id = p_contract_id
    AND holding_id = v_holding_id;

  -- 1b) Modo "subtotal (neto) exacto en moneda de facturación" (caso OC):
  --     FX inverso calculado desde el precio unitario; el neto de la factura
  --     queda EXACTAMENTE en el monto ingresado, también a nivel de líneas.
  IF p_target_amount IS NOT NULL THEN
    IF p_policy <> 'fixed' THEN
      RETURN jsonb_build_object('success', false, 'error', 'El subtotal exacto solo aplica con política de tipo de cambio fijo');
    END IF;
    IF p_invoice_ids IS NULL OR array_length(p_invoice_ids, 1) <> 1 THEN
      RETURN jsonb_build_object('success', false, 'error', 'El subtotal exacto se aplica a una factura a la vez');
    END IF;
    IF p_target_amount <= 0 THEN
      RETURN jsonb_build_object('success', false, 'error', 'El subtotal (neto) debe ser mayor a 0');
    END IF;

    SELECT * INTO v_invoice
    FROM invoices
    WHERE id = p_invoice_ids[1]
      AND contract_id = p_contract_id
      AND holding_id = v_holding_id
      AND status = 'Por Emitir'
      AND COALESCE(is_active, true) = true
      AND invoice_currency IS NOT NULL
      AND invoice_currency <> contract_currency;

    IF v_invoice.id IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'Factura no encontrada, no está Por Emitir o no es multimoneda');
    END IF;

    -- Base en moneda de contrato desde el PRECIO UNITARIO (cantidad × precio),
    -- sin usar subtotales almacenados/redondeados
    SELECT COALESCE(SUM(ii.quantity * ii.unit_price_contract_currency), 0)
    INTO v_base
    FROM invoice_items ii
    WHERE ii.invoice_id = v_invoice.id;

    IF v_base <= 0 THEN
      RETURN jsonb_build_object('success', false, 'error', 'La factura no tiene líneas con cantidad y precio unitario en moneda de contrato');
    END IF;

    v_fx := p_target_amount / v_base;
    v_tax_rate := COALESCE(v_invoice.tax_rate, 0);

    -- Header: el neto queda EXACTO al monto ingresado
    UPDATE invoices
    SET fx_contract_to_invoice  = ROUND(v_fx, 6),
        amount_invoice_currency = p_target_amount,
        vat                     = ROUND(p_target_amount * v_tax_rate / 100.0, 2),
        total_invoice_currency  = ROUND(p_target_amount * (1 + v_tax_rate / 100.0), 2)
    WHERE id = v_invoice.id;

    -- Líneas: subtotal = cantidad × precio contrato × fx (2 decimales)
    UPDATE invoice_items ii
    SET fx_contract_to_invoice      = ROUND(v_fx, 6),
        subtotal_invoice_currency   = ROUND(ii.quantity * ii.unit_price_contract_currency * v_fx, 2),
        tax_amount_invoice_currency = ROUND(ii.quantity * ii.unit_price_contract_currency * v_fx * v_tax_rate / 100.0, 2),
        total_invoice_currency      = ROUND(ii.quantity * ii.unit_price_contract_currency * v_fx * (1 + v_tax_rate / 100.0), 2)
    WHERE ii.invoice_id = v_invoice.id;
    GET DIAGNOSTICS v_updated_items = ROW_COUNT;

    -- Ajuste de redondeo: la suma de las líneas debe dar el neto exacto
    -- (el ERP suma líneas). La diferencia va a la línea de mayor subtotal.
    SELECT p_target_amount - COALESCE(SUM(ii.subtotal_invoice_currency), 0)
    INTO v_diff
    FROM invoice_items ii
    WHERE ii.invoice_id = v_invoice.id;

    IF v_diff <> 0 THEN
      SELECT ii.id INTO v_max_item_id
      FROM invoice_items ii
      WHERE ii.invoice_id = v_invoice.id
      ORDER BY ii.subtotal_invoice_currency DESC NULLS LAST, ii.created_at
      LIMIT 1;

      UPDATE invoice_items ii
      SET subtotal_invoice_currency   = ii.subtotal_invoice_currency + v_diff,
          tax_amount_invoice_currency = ROUND((ii.subtotal_invoice_currency + v_diff) * v_tax_rate / 100.0, 2),
          total_invoice_currency      = ROUND((ii.subtotal_invoice_currency + v_diff) * (1 + v_tax_rate / 100.0), 2)
      WHERE ii.id = v_max_item_id;
    END IF;

    -- Precio unitario por línea = subtotal final / cantidad, SIN forzar redondeo
    -- (conserva los decimales reales, que es como se calcula el FX inverso bien)
    UPDATE invoice_items ii
    SET unit_price_invoice_currency = CASE WHEN COALESCE(ii.quantity, 0) <> 0
                                           THEN ii.subtotal_invoice_currency / ii.quantity
                                           ELSE ii.subtotal_invoice_currency END
    WHERE ii.invoice_id = v_invoice.id;

    RETURN jsonb_build_object(
      'success', true,
      'policy', 'fixed',
      'mode', 'target_net_amount',
      'fx_rate', ROUND(v_fx, 6),
      'target_amount', p_target_amount,
      'updated_invoices', 1,
      'updated_items', v_updated_items
    );
  END IF;

  -- 2) Spot: el FX se calcula al emitir. Limpiar los montos en moneda de factura
  --    (fx + amount/vat/total del header e items) de las facturas Por Emitir
  --    multimoneda para dejarlas como spot nativo (se recalculan al emitir).
  IF p_policy = 'spot' THEN
    UPDATE invoices
    SET fx_contract_to_invoice = NULL,
        amount_invoice_currency = NULL,
        vat                     = NULL,
        total_invoice_currency  = NULL
    WHERE contract_id = p_contract_id
      AND holding_id = v_holding_id
      AND status = 'Por Emitir'
      AND COALESCE(is_active, true) = true
      AND invoice_currency IS NOT NULL
      AND invoice_currency <> contract_currency
      AND (p_invoice_ids IS NULL OR id = ANY(p_invoice_ids));
    GET DIAGNOSTICS v_updated_invoices = ROW_COUNT;

    UPDATE invoice_items ii
    SET fx_contract_to_invoice    = NULL,
        unit_price_invoice_currency = NULL,
        subtotal_invoice_currency   = NULL,
        tax_amount_invoice_currency = NULL,
        total_invoice_currency      = NULL
    FROM invoices inv
    WHERE ii.invoice_id = inv.id
      AND inv.contract_id = p_contract_id
      AND inv.holding_id = v_holding_id
      AND inv.status = 'Por Emitir'
      AND COALESCE(inv.is_active, true) = true
      AND inv.invoice_currency IS NOT NULL
      AND inv.invoice_currency <> inv.contract_currency
      AND (p_invoice_ids IS NULL OR inv.id = ANY(p_invoice_ids));
    GET DIAGNOSTICS v_updated_items = ROW_COUNT;

    RETURN jsonb_build_object('success', true, 'policy', 'spot', 'updated_invoices', v_updated_invoices, 'updated_items', v_updated_items);
  END IF;

  -- 3) Fixed: validar tasa
  IF p_fx_rate IS NULL OR p_fx_rate <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'El tipo de cambio fijo debe ser mayor a 0');
  END IF;

  -- 4) Header de facturas: fx + amount_invoice_currency + vat + total_invoice_currency
  UPDATE invoices
  SET fx_contract_to_invoice = p_fx_rate,
      amount_invoice_currency = amount_contract_currency * p_fx_rate,
      vat                     = ROUND(amount_contract_currency * p_fx_rate * COALESCE(tax_rate, 0) / 100.0, 2),
      total_invoice_currency  = ROUND(amount_contract_currency * p_fx_rate * (1 + COALESCE(tax_rate, 0) / 100.0), 2)
  WHERE contract_id = p_contract_id
    AND holding_id = v_holding_id
    AND status = 'Por Emitir'
    AND COALESCE(is_active, true) = true
    AND invoice_currency IS NOT NULL
    AND invoice_currency <> contract_currency
    AND (p_invoice_ids IS NULL OR id = ANY(p_invoice_ids));
  GET DIAGNOSTICS v_updated_invoices = ROW_COUNT;

  -- 5) Items de esas facturas: los 4 montos *_invoice_currency = *_contract_currency * fx
  UPDATE invoice_items ii
  SET fx_contract_to_invoice    = p_fx_rate,
      unit_price_invoice_currency = ii.unit_price_contract_currency * p_fx_rate,
      subtotal_invoice_currency   = ii.subtotal_contract_currency   * p_fx_rate,
      tax_amount_invoice_currency = ii.tax_amount_contract_currency * p_fx_rate,
      total_invoice_currency      = ii.total_contract_currency      * p_fx_rate
  FROM invoices inv
  WHERE ii.invoice_id = inv.id
    AND inv.contract_id = p_contract_id
    AND inv.holding_id = v_holding_id
    AND inv.status = 'Por Emitir'
    AND COALESCE(inv.is_active, true) = true
    AND inv.invoice_currency IS NOT NULL
    AND inv.invoice_currency <> inv.contract_currency
    AND (p_invoice_ids IS NULL OR inv.id = ANY(p_invoice_ids));
  GET DIAGNOSTICS v_updated_items = ROW_COUNT;

  RETURN jsonb_build_object(
    'success', true,
    'policy', 'fixed',
    'fx_rate', p_fx_rate,
    'updated_invoices', v_updated_invoices,
    'updated_items', v_updated_items
  );
END;
$function$

