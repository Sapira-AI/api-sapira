CREATE OR REPLACE FUNCTION public.invoice_reschedule_items(p_contract_id uuid, p_target_state jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_holding_id uuid := get_current_user_holding_id();
  v_user_id uuid := auth.uid();
  v_contract record;
  v_target_invoice jsonb;
  v_target_item jsonb;
  v_invoice_id uuid;
  v_item_id uuid;
  v_contract_items_affected uuid[] := ARRAY[]::uuid[];
  v_distinct_ci uuid[];
  v_target_invoice_ids uuid[] := ARRAY[]::uuid[];
  v_target_item_ids uuid[] := ARRAY[]::uuid[];
  v_old_state jsonb;
  v_created_invoices jsonb := '[]'::jsonb;
  v_updated_invoices jsonb := '[]'::jsonb;
  v_deleted_invoices jsonb := '[]'::jsonb;
  v_created_items jsonb := '[]'::jsonb;
  v_updated_items jsonb := '[]'::jsonb;
  v_deleted_items jsonb := '[]'::jsonb;
  v_continuity jsonb;
  v_ci_id uuid;
  v_validation_errors jsonb := '[]'::jsonb;
  v_tax_rate numeric;
  v_subtotal numeric;
  v_ci_qty numeric; v_ci_unit numeric;
  v_vat numeric;
  v_total numeric;
BEGIN
  IF NOT user_has_permission('EDIT_FACTURACION') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Sin permiso EDIT_FACTURACION');
  END IF;
  IF p_contract_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'p_contract_id es requerido');
  END IF;
  IF p_target_state IS NULL OR NOT p_target_state ? 'invoices' THEN
    RETURN jsonb_build_object('success', false, 'error', 'p_target_state debe contener invoices[]');
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_contract_id::text, 0));
  SELECT id, client_id, company_id, client_entity_id, holding_id,
         contract_currency, invoice_currency, status
    INTO v_contract
  FROM contracts WHERE id = p_contract_id AND holding_id = v_holding_id;
  IF v_contract.id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Contrato no encontrado');
  END IF;
  PERFORM id FROM invoices
  WHERE contract_id = p_contract_id AND holding_id = v_holding_id
    AND status = 'Por Emitir' AND COALESCE(is_active, true) = true FOR UPDATE;
  SELECT COALESCE(jsonb_agg(inv_data), '[]'::jsonb) INTO v_old_state
  FROM (
    SELECT jsonb_build_object(
      'invoice_id', i.id, 'invoice_number', i.invoice_number,
      'issue_date', i.issue_date, 'total_contract_currency', i.amount_contract_currency,
      'items', (SELECT jsonb_agg(jsonb_build_object(
        'id', ii.id, 'contract_item_id', ii.contract_item_id,
        'description', ii.description,
        'billing_period_start', ii.billing_period_start,
        'billing_period_end', ii.billing_period_end,
        'total_contract_currency', ii.total_contract_currency
      ) ORDER BY ii.billing_period_start NULLS LAST)
      FROM invoice_items ii WHERE ii.invoice_id = i.id)
    ) AS inv_data
    FROM invoices i
    WHERE i.contract_id = p_contract_id AND i.holding_id = v_holding_id
      AND i.status = 'Por Emitir' AND COALESCE(i.is_active, true) = true
  ) sub;

  FOR v_target_invoice IN SELECT * FROM jsonb_array_elements(p_target_state->'invoices') LOOP
    v_invoice_id := NULLIF(v_target_invoice->>'id', '')::uuid;
    IF v_invoice_id IS NOT NULL THEN
      -- Documentos unificados/consolidados no se reestructuran directo: hay
      -- que revertir la unificación/consolidación primero (el documento
      -- agrupa otras facturas — y en las unificadas, otros contratos).
      IF EXISTS (SELECT 1 FROM invoices
        WHERE id = v_invoice_id
          AND COALESCE(invoice_type, '') IN ('Unificada', 'Consolidada')) THEN
        RAISE EXCEPTION 'La factura es un documento % y no puede reestructurarse directamente. Primero revierte la unificación/consolidación (acción "Desconsolidar"), reestructura las facturas originales y vuelve a unificar/consolidar al final.',
          (SELECT invoice_type FROM invoices WHERE id = v_invoice_id)
          USING ERRCODE = 'check_violation';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM invoices
        WHERE id = v_invoice_id AND contract_id = p_contract_id AND holding_id = v_holding_id
          AND status = 'Por Emitir' AND COALESCE(is_active, true) = true) THEN
        RAISE EXCEPTION 'Invoice % no es Por Emitir del contrato o ya fue modificada', v_invoice_id
          USING ERRCODE = 'check_violation';
      END IF;
      UPDATE invoices SET
        issue_date = COALESCE(NULLIF(v_target_invoice->>'issue_date', '')::date, issue_date),
        scheduled_at = COALESCE(NULLIF(v_target_invoice->>'scheduled_at', '')::date,
          NULLIF(v_target_invoice->>'issue_date', '')::date, scheduled_at)
      WHERE id = v_invoice_id;
      v_updated_invoices := v_updated_invoices || jsonb_build_object('id', v_invoice_id);
    ELSE
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
      SELECT p_contract_id, v_holding_id, v_contract.client_id,
        COALESCE(ref_inv.company_id, v_contract.company_id),
        COALESCE(ref_inv.client_entity_id, v_contract.client_entity_id),
        NULLIF(v_target_invoice->>'issue_date', '')::date,
        COALESCE(NULLIF(v_target_invoice->>'scheduled_at', '')::date,
                 NULLIF(v_target_invoice->>'issue_date', '')::date),
        NULLIF(v_target_invoice->>'issue_date', '')::date,
        'Por Emitir', ref_inv.invoice_type,
        COALESCE(ref_inv.document_type, 'FACTURA'),
        COALESCE(ref_inv.contract_currency, v_contract.contract_currency),
        COALESCE(ref_inv.invoice_currency, v_contract.invoice_currency),
        ref_inv.fx_contract_to_invoice, ref_inv.tax_rate, ref_inv.invoice_terms_and_conditions,
        ref_inv.issuer_legal_name, ref_inv.issuer_tax_id, ref_inv.issuer_address,
        'manual_restructure', true, COALESCE(ref_inv.auto_invoice, false),
        ref_inv.client_tax_id, ref_inv.payment_method, ref_inv.invoice_series, ref_inv.fiscal_regime,
        ref_inv.export_type, ref_inv.requires_references_for_billing
      FROM (SELECT * FROM invoices
            WHERE contract_id = p_contract_id AND holding_id = v_holding_id
              -- La factura de referencia para clonar el header debe ser una
              -- factura normal del contrato (no un documento agrupador ni una
              -- nota de crédito/débito).
              AND COALESCE(invoice_type, '') NOT IN ('Unificada', 'Consolidada')
              AND COALESCE(document_type, 'FACTURA') NOT IN ('NC', 'ND')
            ORDER BY created_at DESC LIMIT 1) ref_inv
      RETURNING id INTO v_invoice_id;
      v_created_invoices := v_created_invoices || jsonb_build_object(
        'id', v_invoice_id, 'client_key', v_target_invoice->>'client_key');
    END IF;
    v_target_invoice_ids := v_target_invoice_ids || v_invoice_id;

    FOR v_target_item IN SELECT * FROM jsonb_array_elements(COALESCE(v_target_invoice->'items', '[]'::jsonb)) LOOP
      v_item_id := NULLIF(v_target_item->>'id', '')::uuid;
      IF NOT EXISTS (SELECT 1 FROM contract_items
        WHERE id = (v_target_item->>'contract_item_id')::uuid AND contract_id = p_contract_id) THEN
        RAISE EXCEPTION 'contract_item_id % no pertenece al contrato %',
          v_target_item->>'contract_item_id', p_contract_id USING ERRCODE = 'check_violation';
      END IF;
      v_contract_items_affected := v_contract_items_affected
        || ARRAY[(v_target_item->>'contract_item_id')::uuid];
      v_total := (v_target_item->>'total_contract_currency')::numeric;
      SELECT COALESCE(tax_rate, 0) INTO v_tax_rate FROM invoices WHERE id = v_invoice_id;
      IF v_tax_rate IS NULL OR v_tax_rate = 0 THEN
        v_subtotal := v_total; v_vat := 0;
      ELSE
        v_subtotal := ROUND(v_total / (1 + v_tax_rate / 100), 2);
        v_vat := v_total - v_subtotal;
      END IF;
      -- Detalle real del ítem: cantidad del contract_item y unitario derivado
      -- (subtotal / cantidad) en vez de aplanar a 1 × total. Mantiene p×q =
      -- subtotal y conserva el detalle que viaja a Odoo. Antes esta función
      -- colapsaba toda línea tocada a quantity=1 (origen del 1×1.000 de CEFA
      -- S08540 y del riesgo 1×2.240 en STG CTR-2026-38; Fernanda 17/18-09-2026).
      SELECT COALESCE(NULLIF(quantity, 0), 1) INTO v_ci_qty
      FROM contract_items WHERE id = (v_target_item->>'contract_item_id')::uuid;
      v_ci_unit := ROUND(v_subtotal / v_ci_qty, 6);

      IF v_item_id IS NOT NULL THEN
        UPDATE invoice_items SET
          invoice_id = v_invoice_id,
          contract_item_id = (v_target_item->>'contract_item_id')::uuid,
          description = v_target_item->>'description',
          billing_period_start = NULLIF(v_target_item->>'billing_period_start', '')::date,
          billing_period_end = NULLIF(v_target_item->>'billing_period_end', '')::date,
          quantity = v_ci_qty,
          unit_price_contract_currency = v_ci_unit,
          subtotal_contract_currency = v_subtotal,
          tax_amount_contract_currency = v_vat,
          total_contract_currency = v_total,
          updated_at = now()
        WHERE id = v_item_id;
        v_updated_items := v_updated_items || jsonb_build_object('id', v_item_id);
      ELSE
        INSERT INTO invoice_items (
          invoice_id, holding_id, contract_id, contract_item_id, product_id,
          description, billing_period_start, billing_period_end,
          quantity, unit_of_measure,
          unit_price_contract_currency, subtotal_contract_currency,
          tax_amount_contract_currency, total_contract_currency,
          contract_currency, invoice_currency, tax_code
        )
        SELECT v_invoice_id, v_holding_id, p_contract_id, ci.id, ci.product_id,
          v_target_item->>'description',
          NULLIF(v_target_item->>'billing_period_start', '')::date,
          NULLIF(v_target_item->>'billing_period_end', '')::date,
          v_ci_qty, COALESCE(ci.unit_of_measure, 'UND'),
          v_ci_unit, v_subtotal, v_vat, v_total,
          v_contract.contract_currency, v_contract.invoice_currency,
          COALESCE(v_tax_rate::text, '0')
        FROM contract_items ci
        WHERE ci.id = (v_target_item->>'contract_item_id')::uuid
        RETURNING id INTO v_item_id;

        -- El trigger BEFORE INSERT `standardize_invoice_items` pisa los montos
        -- del item recién insertado (los recalcula desde el contract_item).
        -- Como NO se dispara en UPDATE, restauramos aquí los montos del restructure.
        UPDATE invoice_items SET
          quantity = v_ci_qty,
          unit_price_contract_currency = v_ci_unit,
          subtotal_contract_currency = v_subtotal,
          tax_amount_contract_currency = v_vat,
          total_contract_currency = v_total,
          unit_price_invoice_currency = v_ci_unit,
          subtotal_invoice_currency = v_subtotal,
          tax_amount_invoice_currency = v_vat,
          total_invoice_currency = v_total
        WHERE id = v_item_id;

        v_created_items := v_created_items || jsonb_build_object('id', v_item_id);
      END IF;
      v_target_item_ids := v_target_item_ids || v_item_id;
    END LOOP;
  END LOOP;

  -- Barrido de líneas fuera del target: NUNCA sobre documentos unificados o
  -- consolidados (el unificado cuelga del contrato principal con líneas de
  -- otros contratos; tocarlo aquí las destruiría).
  WITH deleted AS (
    DELETE FROM invoice_items ii USING invoices i
    WHERE ii.invoice_id = i.id AND i.contract_id = p_contract_id AND i.holding_id = v_holding_id
      AND i.status = 'Por Emitir' AND COALESCE(i.is_active, true) = true
      AND COALESCE(i.invoice_type, '') NOT IN ('Unificada', 'Consolidada')
      AND NOT (ii.id = ANY(v_target_item_ids))
    RETURNING ii.id, ii.contract_item_id
  )
  SELECT
    COALESCE(jsonb_agg(jsonb_build_object('id', id)), '[]'::jsonb),
    COALESCE(array_agg(DISTINCT contract_item_id) FILTER (WHERE contract_item_id IS NOT NULL), ARRAY[]::uuid[])
  INTO v_deleted_items, v_distinct_ci FROM deleted;
  v_contract_items_affected := v_contract_items_affected || v_distinct_ci;

  WITH empty_invoices AS (
    SELECT i.id FROM invoices i
    WHERE i.contract_id = p_contract_id AND i.holding_id = v_holding_id
      AND i.status = 'Por Emitir' AND COALESCE(i.is_active, true) = true
      AND COALESCE(i.invoice_type, '') NOT IN ('Unificada', 'Consolidada')
      AND NOT (i.id = ANY(v_target_invoice_ids))
      AND NOT EXISTS (SELECT 1 FROM invoice_items ii WHERE ii.invoice_id = i.id)
  ),
  marked AS (
    UPDATE invoices SET is_active = false, status = 'Cancelada'
    WHERE id IN (SELECT id FROM empty_invoices) RETURNING id
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', id)), '[]'::jsonb)
    INTO v_deleted_invoices FROM marked;

  UPDATE invoices i SET
    amount_contract_currency = COALESCE(sums.subtotal, 0),
    vat = CASE WHEN i.fx_contract_to_invoice IS NULL THEN NULL ELSE COALESCE(sums.vat, 0) END,
    total_invoice_currency = CASE WHEN i.fx_contract_to_invoice IS NULL THEN NULL ELSE COALESCE(sums.total, 0) * i.fx_contract_to_invoice END,
    amount_invoice_currency = CASE WHEN i.fx_contract_to_invoice IS NULL THEN NULL ELSE COALESCE(sums.subtotal, 0) * i.fx_contract_to_invoice END
  FROM (
    SELECT invoice_id, SUM(subtotal_contract_currency) AS subtotal,
      SUM(tax_amount_contract_currency) AS vat, SUM(total_contract_currency) AS total
    FROM invoice_items WHERE invoice_id = ANY(v_target_invoice_ids) GROUP BY invoice_id
  ) sums WHERE i.id = sums.invoice_id;

  -- Recalcular montos en moneda factura de los items segun el fx de su factura:
  -- NULL en spot (se calculan al emitir), *_contract * fx en multimoneda fija.
  UPDATE invoice_items ii SET
    fx_contract_to_invoice      = inv.fx_contract_to_invoice,
    unit_price_invoice_currency = CASE WHEN inv.fx_contract_to_invoice IS NULL THEN NULL ELSE ii.unit_price_contract_currency * inv.fx_contract_to_invoice END,
    subtotal_invoice_currency   = CASE WHEN inv.fx_contract_to_invoice IS NULL THEN NULL ELSE ii.subtotal_contract_currency * inv.fx_contract_to_invoice END,
    tax_amount_invoice_currency = CASE WHEN inv.fx_contract_to_invoice IS NULL THEN NULL ELSE ii.tax_amount_contract_currency * inv.fx_contract_to_invoice END,
    total_invoice_currency      = CASE WHEN inv.fx_contract_to_invoice IS NULL THEN NULL ELSE ii.total_contract_currency * inv.fx_contract_to_invoice END
  FROM invoices inv
  WHERE ii.invoice_id = inv.id AND inv.id = ANY(v_target_invoice_ids);

  SELECT COALESCE(array_agg(DISTINCT cid), ARRAY[]::uuid[]) INTO v_distinct_ci
  FROM unnest(v_contract_items_affected) cid WHERE cid IS NOT NULL;
  FOREACH v_ci_id IN ARRAY v_distinct_ci LOOP
    v_continuity := check_contract_item_continuity(v_ci_id);
    IF NOT (v_continuity->>'ok')::boolean THEN
      v_validation_errors := v_validation_errors || jsonb_build_object(
        'contract_item_id', v_ci_id, 'validation', v_continuity);
    END IF;
  END LOOP;
  IF jsonb_array_length(v_validation_errors) > 0 THEN
    RAISE EXCEPTION 'Validación de continuidad/conservación falló: %', v_validation_errors::text
      USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO invoice_restructure_log(holding_id, contract_id, actor_user_id, action, payload)
  VALUES (v_holding_id, p_contract_id, v_user_id, 'restructure',
    jsonb_build_object('old_state', v_old_state, 'target_state', p_target_state,
      'created_invoices', v_created_invoices, 'updated_invoices', v_updated_invoices,
      'deleted_invoices', v_deleted_invoices, 'created_items', v_created_items,
      'updated_items', v_updated_items, 'deleted_items', v_deleted_items)
  );
  RETURN jsonb_build_object('success', true,
    'created_invoices', v_created_invoices, 'updated_invoices', v_updated_invoices,
    'deleted_invoices', v_deleted_invoices, 'created_items', v_created_items,
    'updated_items', v_updated_items, 'deleted_items', v_deleted_items);
END;
$function$

