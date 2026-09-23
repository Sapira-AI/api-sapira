CREATE OR REPLACE FUNCTION public.reconcile_legacy_with_por_emitir(p_legacy_invoice_id uuid, p_matches jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_holding_id        uuid;
  v_legacy            invoices_legacy%ROWTYPE;
  v_invoice           invoices%ROWTYPE;
  v_total_contract    numeric := 0;
  v_fx_rate           numeric := 1.0;
  v_match             jsonb;
  v_i                 integer;
  v_matches_count     integer;
  v_coverage          numeric;
  v_remaining         numeric;
  v_proportion        numeric;
  v_remainder_id      uuid;
  v_new_status        text;
BEGIN
  v_holding_id := get_current_user_holding_id();

  -- ─── Validar acceso a la factura legacy ───────────────────────────────────
  SELECT * INTO v_legacy
  FROM invoices_legacy
  WHERE id = p_legacy_invoice_id AND holding_id = v_holding_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Factura legacy no encontrada');
  END IF;

  -- ─── Validar que haya al menos un match ───────────────────────────────────
  v_matches_count := jsonb_array_length(p_matches);
  IF v_matches_count = 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'No se proporcionaron matches');
  END IF;

  -- ─── Calcular total cubierto en moneda contrato para FX ───────────────────
  FOR v_i IN 0..(v_matches_count - 1) LOOP
    v_match          := p_matches->v_i;
    v_total_contract := v_total_contract + COALESCE((v_match->>'coverage_amount_contract')::numeric, 0);
  END LOOP;

  v_fx_rate := CASE
    WHEN v_total_contract > 0
    THEN ROUND(v_legacy.amount_invoice_currency / v_total_contract, 6)
    ELSE 1.0
  END;

  -- ─── Mapear estado legacy → estado invoice normalizada ────────────────────
  v_new_status := CASE v_legacy.status
    WHEN 'Pagada'  THEN 'Pagada'
    WHEN 'Vencida' THEN 'Vencida'
    WHEN 'Enviada' THEN 'Enviada'
    ELSE 'Emitida'
  END;

  -- ─── Procesar cada match ──────────────────────────────────────────────────
  FOR v_i IN 0..(v_matches_count - 1) LOOP
    v_match    := p_matches->v_i;
    v_coverage := COALESCE((v_match->>'coverage_amount_contract')::numeric, 0);

    IF v_coverage <= 0 THEN CONTINUE; END IF;

    -- Obtener la factura Por Emitir
    SELECT * INTO v_invoice
    FROM invoices
    WHERE id  = (v_match->>'invoice_id')::uuid
      AND holding_id = v_holding_id
      AND status     = 'Por Emitir';

    IF NOT FOUND THEN CONTINUE; END IF;

    -- Validar que empresa y receptor coincidan con la legacy
    IF v_legacy.company_id        IS DISTINCT FROM v_invoice.company_id
    OR v_legacy.client_entity_id  IS DISTINCT FROM v_invoice.client_entity_id THEN
      CONTINUE;
    END IF;

    v_remaining  := ROUND(v_invoice.amount_contract_currency - v_coverage, 6);
    v_proportion := ROUND(v_coverage / NULLIF(v_invoice.amount_contract_currency, 0), 6);

    -- ── Si cobertura parcial: crear remainder Por Emitir ──────────────────
    IF v_remaining > 0.001 THEN

      INSERT INTO invoices (
        holding_id,
        company_id,
        client_id,
        client_entity_id,
        client_tax_id,
        contract_id,
        contract_currency,
        invoice_currency,
        amount_contract_currency,
        amount_invoice_currency,
        total_invoice_currency,
        scheduled_at,
        original_issue_date,
        status,
        split_from_invoice_id,
        split_reason,
        fx_contract_to_invoice
      ) VALUES (
        v_holding_id,
        v_invoice.company_id,
        v_invoice.client_id,
        v_invoice.client_entity_id,
        v_invoice.client_tax_id,
        v_invoice.contract_id,
        v_invoice.contract_currency,
        v_invoice.invoice_currency,
        v_remaining,
        ROUND(v_remaining * v_invoice.fx_contract_to_invoice, 2),
        ROUND(v_remaining * v_invoice.fx_contract_to_invoice, 2),
        v_invoice.scheduled_at,
        v_invoice.scheduled_at,
        'Por Emitir',
        v_invoice.id,
        COALESCE(v_match->>'split_reason', 'legacy_partial'),
        v_invoice.fx_contract_to_invoice
      ) RETURNING id INTO v_remainder_id;

      -- Copiar invoice_items al remainder sin contract_item_id (evita trigger BEFORE INSERT)
      INSERT INTO invoice_items (
        invoice_id,
        holding_id,
        contract_id,
        description,
        quantity,
        unit_price_contract_currency,
        subtotal_contract_currency,
        total_contract_currency,
        unit_price_invoice_currency,
        subtotal_invoice_currency,
        total_invoice_currency,
        contract_currency,
        invoice_currency,
        fx_contract_to_invoice
      )
      SELECT
        v_remainder_id,
        v_holding_id,
        ii.contract_id,
        ii.description,
        ii.quantity,
        ROUND((ii.subtotal_contract_currency * (1 - v_proportion)) / NULLIF(ii.quantity, 0), 6),
        ROUND(ii.subtotal_contract_currency  * (1 - v_proportion), 2),
        ROUND(ii.total_contract_currency     * (1 - v_proportion), 2),
        ROUND((ii.subtotal_invoice_currency  * (1 - v_proportion)) / NULLIF(ii.quantity, 0), 6),
        ROUND(ii.subtotal_invoice_currency   * (1 - v_proportion), 2),
        ROUND(ii.total_invoice_currency      * (1 - v_proportion), 2),
        ii.contract_currency,
        ii.invoice_currency,
        ii.fx_contract_to_invoice
      FROM invoice_items ii
      WHERE ii.invoice_id = v_invoice.id;

      -- UPDATE separado para asignar contract_item_id (evita trigger BEFORE INSERT)
      UPDATE invoice_items tgt
      SET contract_item_id = src.contract_item_id
      FROM invoice_items src
      WHERE src.invoice_id  = v_invoice.id
        AND tgt.invoice_id  = v_remainder_id
        AND tgt.description = src.description;

    END IF;

    -- ── Actualizar la factura Por Emitir con datos reales del ERP ─────────
    -- Nota: invoices no tiene columna updated_at (solo created_at)
    UPDATE invoices SET
      invoice_number           = v_legacy.invoice_number,
      issue_date               = v_legacy.issue_date,
      due_date                 = COALESCE(v_legacy.due_date, v_legacy.issue_date + INTERVAL '30 days'),
      invoice_currency         = v_legacy.invoice_currency,
      amount_contract_currency = v_coverage,
      amount_invoice_currency  = ROUND(v_coverage * v_fx_rate, 2),
      vat                      = ROUND(COALESCE(v_legacy.vat, 0) * (v_coverage / NULLIF(v_total_contract, 0)), 2),
      total_invoice_currency   = ROUND(
                                   (v_coverage * v_fx_rate)
                                   + COALESCE(v_legacy.vat, 0) * (v_coverage / NULLIF(v_total_contract, 0)),
                                 2),
      fx_contract_to_invoice   = v_fx_rate,
      is_legacy                = true,
      legacy_invoice_id        = p_legacy_invoice_id,
      status                   = v_new_status
    WHERE id = v_invoice.id;

    -- ── Actualizar invoice_items con FX + montos proporcionales ──────────
    UPDATE invoice_items SET
      invoice_currency             = v_legacy.invoice_currency,
      fx_contract_to_invoice       = v_fx_rate,
      unit_price_contract_currency = ROUND((subtotal_contract_currency * v_proportion) / NULLIF(quantity, 0), 6),
      subtotal_contract_currency   = ROUND(subtotal_contract_currency * v_proportion, 2),
      total_contract_currency      = ROUND(total_contract_currency    * v_proportion, 2),
      unit_price_invoice_currency  = ROUND((subtotal_contract_currency * v_proportion * v_fx_rate) / NULLIF(quantity, 0), 6),
      subtotal_invoice_currency    = ROUND(subtotal_contract_currency * v_proportion * v_fx_rate, 2),
      total_invoice_currency       = ROUND(total_contract_currency    * v_proportion * v_fx_rate, 2),
      updated_at                   = NOW()
    WHERE invoice_id = v_invoice.id;

  END LOOP;

  -- ─── Marcar factura legacy como migrada ───────────────────────────────────
  UPDATE invoices_legacy SET
    reconciliation_status = 'migrated',
    reconciled_invoice_id = (p_matches->0->>'invoice_id')::uuid,
    contract_id           = (
      SELECT contract_id FROM invoices
      WHERE id = (p_matches->0->>'invoice_id')::uuid
    ),
    reconciled_at = NOW()
  WHERE id = p_legacy_invoice_id;

  RETURN jsonb_build_object(
    'success',        true,
    'fx_rate',        v_fx_rate,
    'total_contract', v_total_contract,
    'matches_count',  v_matches_count
  );
END;
$function$;

COMMENT ON FUNCTION public."reconcile_legacy_with_por_emitir"(p_legacy_invoice_id uuid, p_matches jsonb) IS 'Reconcilia una factura legacy contra facturas "Por Emitir" del contrato (contratos activos).
   Soporta cobertura parcial (split automático con split_from_invoice_id) y muchos-a-muchos.
   Actualiza la Por Emitir con datos reales del ERP y crea remainder si hay diferencia.
   FX se calcula como implied: legacy.amount_invoice_currency / sum(coverage_contract).
   Fix v20260303040000: eliminado updated_at del UPDATE invoices (columna no existe en esa tabla).';
