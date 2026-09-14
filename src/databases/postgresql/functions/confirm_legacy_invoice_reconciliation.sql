CREATE OR REPLACE FUNCTION public.confirm_legacy_invoice_reconciliation(p_invoice_legacy_id uuid, p_force_rereconcile boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_holding_id uuid;
  v_legacy_invoice RECORD;
  v_new_invoice_id uuid;
  v_existing_invoice_id uuid;
  v_items_created integer := 0;
  v_total_amount numeric := 0;
  v_contract_id uuid;
  v_contract_status text;
  v_match RECORD;
  v_unconfirmed_count integer;
BEGIN
  -- =====================================================
  -- 1. Obtener holding_id del usuario actual
  -- =====================================================
  v_holding_id := public.get_user_holding_id();
  
  IF v_holding_id IS NULL THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'User has no holding assigned'
    );
  END IF;

  -- =====================================================
  -- 2. Validar que la factura legacy existe y pertenece al holding
  -- =====================================================
  SELECT * INTO v_legacy_invoice
  FROM invoices_legacy
  WHERE id = p_invoice_legacy_id
    AND holding_id = v_holding_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Legacy invoice not found or access denied'
    );
  END IF;

  -- =====================================================
  -- 3. Obtener contract_id desde los matches
  -- =====================================================
  -- Si no hay contract_id directo, lo obtenemos desde contract_items
  IF v_legacy_invoice.contract_id IS NULL THEN
    SELECT DISTINCT ci.contract_id INTO v_contract_id
    FROM invoice_items_legacy_match m
    INNER JOIN invoice_items_legacy iil ON iil.id = m.invoice_item_legacy_id
    INNER JOIN contract_items ci ON ci.id = m.contract_item_id
    WHERE iil.invoice_legacy_id = p_invoice_legacy_id
      AND m.status = 'confirmed'
    LIMIT 1;
    
    IF v_contract_id IS NULL THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'No contract found for this legacy invoice. Ensure at least one match is confirmed.'
      );
    END IF;
  ELSE
    v_contract_id := v_legacy_invoice.contract_id;
  END IF;

  -- =====================================================
  -- 4. Validar estado del contrato
  -- =====================================================
  SELECT status INTO v_contract_status
  FROM contracts
  WHERE id = v_contract_id
    AND holding_id = v_holding_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Contract not found or access denied'
    );
  END IF;

  -- =====================================================
  -- 5. Validar re-reconciliación
  -- =====================================================
  IF v_legacy_invoice.reconciliation_status = 'confirmed' THEN
    -- Si ya está reconciliada, verificar si se puede re-reconciliar
    IF NOT p_force_rereconcile THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'Invoice already reconciled. Use force_rereconcile=true to re-reconcile.',
        'existing_invoice_id', v_legacy_invoice.reconciled_invoice_id
      );
    END IF;

    -- Si el contrato está activo, no permitir re-reconciliación
    IF v_contract_status = 'Activo' THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'Cannot re-reconcile: contract is already active. Deactivate contract first.'
      );
    END IF;

    -- Eliminar factura reconciliada anterior
    v_existing_invoice_id := v_legacy_invoice.reconciled_invoice_id;
    IF v_existing_invoice_id IS NOT NULL THEN
      DELETE FROM invoice_items WHERE invoice_id = v_existing_invoice_id;
      DELETE FROM invoices WHERE id = v_existing_invoice_id;
      RAISE NOTICE 'Deleted previous reconciled invoice %', v_existing_invoice_id;
    END IF;
  END IF;

  -- =====================================================
  -- 6. Validar que todos los matches están confirmados
  -- =====================================================
  SELECT COUNT(*) INTO v_unconfirmed_count
  FROM invoice_items_legacy_match m
  INNER JOIN invoice_items_legacy iil ON iil.id = m.invoice_item_legacy_id
  WHERE iil.invoice_legacy_id = p_invoice_legacy_id
    AND m.status != 'confirmed';

  IF v_unconfirmed_count > 0 THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', format('All invoice items must have confirmed matches. Found %s unconfirmed items.', v_unconfirmed_count)
    );
  END IF;

  -- =====================================================
  -- 7. Validar que existe al menos un match confirmado
  -- =====================================================
  IF NOT EXISTS (
    SELECT 1 FROM invoice_items_legacy_match m
    INNER JOIN invoice_items_legacy iil ON iil.id = m.invoice_item_legacy_id
    WHERE iil.invoice_legacy_id = p_invoice_legacy_id
      AND m.status = 'confirmed'
  ) THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'No confirmed matches found for this legacy invoice'
    );
  END IF;

  -- =====================================================
  -- 8. Crear registro en tabla invoices (transacción)
  -- =====================================================
  BEGIN
    INSERT INTO invoices (
      holding_id,
      company_id,
      contract_id,
      invoice_number,
      issue_date,
      due_date,
      status,
      amount_contract_currency,
      total_contract_currency,
      amount_invoice_currency,
      total_invoice_currency,
      contract_currency,
      invoice_currency,
      fx_contract_to_invoice,
      is_legacy,
      legacy_invoice_id,
      legacy_source_system,
      notes,
      created_at,
      updated_at
    )
    VALUES (
      v_holding_id,
      v_legacy_invoice.company_id,
      v_contract_id,
      v_legacy_invoice.invoice_number,
      v_legacy_invoice.issue_date,
      v_legacy_invoice.due_date,
      COALESCE(v_legacy_invoice.status, 'Pagada'), -- Asumimos pagada si no tiene status
      v_legacy_invoice.amount_invoice_currency / COALESCE(v_legacy_invoice.fx_contract_to_invoice, 1),
      v_legacy_invoice.total_invoice_currency / COALESCE(v_legacy_invoice.fx_contract_to_invoice, 1),
      v_legacy_invoice.amount_invoice_currency,
      v_legacy_invoice.total_invoice_currency,
      (SELECT contract_currency FROM contracts WHERE id = v_contract_id),
      v_legacy_invoice.invoice_currency,
      COALESCE(v_legacy_invoice.fx_contract_to_invoice, 1),
      true,
      p_invoice_legacy_id,
      v_legacy_invoice.source_system,
      COALESCE(v_legacy_invoice.notes, '') || ' [Reconciled from legacy]',
      NOW(),
      NOW()
    )
    RETURNING id INTO v_new_invoice_id;

    -- =====================================================
    -- 9. Crear invoice_items desde matches confirmados
    -- =====================================================
    FOR v_match IN
      SELECT 
        m.*,
        iil.description as legacy_item_description,
        iil.quantity as legacy_item_quantity,
        iil.unit_price as legacy_item_unit_price,
        iil.subtotal as legacy_item_subtotal,
        iil.tax_amount as legacy_item_tax_amount,
        iil.total as legacy_item_total,
        iil.currency as legacy_item_currency
      FROM invoice_items_legacy_match m
      INNER JOIN invoice_items_legacy iil ON iil.id = m.invoice_item_legacy_id
      WHERE iil.invoice_legacy_id = p_invoice_legacy_id
        AND m.status = 'confirmed'
        AND m.holding_id = v_holding_id
    LOOP
      INSERT INTO invoice_items (
        invoice_id,
        contract_item_id,
        description,
        quantity,
        discount_pct,
        unit_price_contract_currency,
        unit_price_invoice_currency,
        subtotal_contract_currency,
        subtotal_invoice_currency,
        tax_amount_contract_currency,
        tax_amount_invoice_currency,
        total_contract_currency,
        total_invoice_currency,
        contract_currency,
        invoice_currency,
        fx_contract_to_invoice,
        fx_rate_source,
        fx_rate_date,
        status,
        issue_date,
        legacy_item_id,
        legacy_match_id,
        created_at,
        updated_at
      )
      VALUES (
        v_new_invoice_id,
        v_match.contract_item_id,
        COALESCE(v_match.product_name, v_match.legacy_item_description),
        GREATEST(COALESCE(v_match.legacy_item_quantity, 1), 1),
        0, -- discount_pct
        v_match.amount_contract_currency / GREATEST(COALESCE(v_match.legacy_item_quantity, 1), 1),
        v_match.amount_invoice_currency / GREATEST(COALESCE(v_match.legacy_item_quantity, 1), 1),
        v_match.amount_contract_currency,
        v_match.amount_invoice_currency,
        0, -- tax_amount_contract_currency (legacy no tiene desglose de impuestos por item)
        0, -- tax_amount_invoice_currency
        v_match.amount_contract_currency,
        v_match.amount_invoice_currency,
        v_match.contract_currency,
        COALESCE(v_match.legacy_item_currency, v_legacy_invoice.invoice_currency),
        v_match.fx_contract_to_invoice,
        'legacy-reconciliation',
        v_legacy_invoice.issue_date,
        'Enviada', -- status
        v_legacy_invoice.issue_date,
        v_match.invoice_item_legacy_id,
        v_match.id,
        NOW(),
        NOW()
      );

      v_items_created := v_items_created + 1;
      v_total_amount := v_total_amount + v_match.amount_contract_currency;
    END LOOP;

    -- =====================================================
    -- 10. Actualizar contract_invoices relacionados (si existen)
    -- =====================================================
    UPDATE contract_invoices
    SET 
      is_satisfied = true,
      satisfied_by_legacy_id = p_invoice_legacy_id,
      updated_at = NOW()
    WHERE contract_id = v_contract_id
      AND invoice_date <= v_legacy_invoice.issue_date
      AND NOT is_satisfied
      AND id IN (
        SELECT DISTINCT ci.id
        FROM contract_invoices ci
        INNER JOIN invoice_items_legacy_match m ON m.contract_item_id = ci.contract_item_id
        INNER JOIN invoice_items_legacy iil ON iil.id = m.invoice_item_legacy_id
        WHERE iil.invoice_legacy_id = p_invoice_legacy_id
          AND m.status = 'confirmed'
      );

    -- =====================================================
    -- 11. Actualizar factura legacy
    -- =====================================================
    UPDATE invoices_legacy
    SET 
      contract_id = v_contract_id,
      reconciliation_status = 'confirmed',
      reconciled_invoice_id = v_new_invoice_id,
      reconciled_at = NOW(),
      updated_at = NOW()
    WHERE id = p_invoice_legacy_id;

    -- =====================================================
    -- 12. Recalcular legacy_reconciliation_pct del contrato
    -- =====================================================
    UPDATE contracts c
    SET legacy_reconciliation_pct = (
      SELECT 
        CASE 
          WHEN COUNT(*) = 0 THEN 0
          ELSE (COUNT(*) FILTER (WHERE reconciliation_status = 'confirmed')::numeric / COUNT(*)::numeric) * 100
        END
      FROM invoices_legacy
      WHERE contract_id = c.id
    )
    WHERE id = v_contract_id;

  EXCEPTION WHEN OTHERS THEN
    -- Rollback automático por la transacción
    RETURN jsonb_build_object(
      'success', false,
      'error', format('Reconciliation failed: %s', SQLERRM)
    );
  END;

  -- =====================================================
  -- Retornar resultado exitoso
  -- =====================================================
  RETURN jsonb_build_object(
    'success', true,
    'legacy_invoice_id', p_invoice_legacy_id,
    'new_invoice_id', v_new_invoice_id,
    'contract_id', v_contract_id,
    'items_created', v_items_created,
    'total_amount_contract_currency', v_total_amount,
    'invoice_number', v_legacy_invoice.invoice_number,
    'was_rereconciled', p_force_rereconcile AND v_existing_invoice_id IS NOT NULL,
    'message', format('Successfully reconciled legacy invoice %s with %s items', 
      v_legacy_invoice.invoice_number, v_items_created)
  );
END;
$function$


CREATE OR REPLACE FUNCTION public.confirm_legacy_invoice_reconciliation(p_invoice_legacy_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_legacy_invoice RECORD;
  v_new_invoice_id UUID;
  v_items_created INTEGER := 0;
  v_total_amount NUMERIC := 0;
  v_contract_id UUID;
  v_match RECORD;
BEGIN
  -- 1. Validar que la factura legacy existe
  SELECT * INTO v_legacy_invoice
  FROM invoices_legacy
  WHERE id = p_invoice_legacy_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Legacy invoice not found'
    );
  END IF;

  v_contract_id := v_legacy_invoice.contract_id;

  -- 2. Validar que todos los matches están confirmados
  IF EXISTS (
    SELECT 1 FROM invoice_items_legacy_match m
    JOIN invoice_items_legacy iil ON iil.id = m.invoice_item_legacy_id
    WHERE iil.invoice_legacy_id = p_invoice_legacy_id
      AND m.status != 'confirmed'
  ) THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'All matches must be confirmed before reconciliation can be finalized'
    );
  END IF;

  -- 3. Validar que existe al menos un match
  IF NOT EXISTS (
    SELECT 1 FROM invoice_items_legacy_match m
    JOIN invoice_items_legacy iil ON iil.id = m.invoice_item_legacy_id
    WHERE iil.invoice_legacy_id = p_invoice_legacy_id
  ) THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'No matches found for this legacy invoice'
    );
  END IF;

  -- 4. Crear registro formal en tabla invoices
  INSERT INTO invoices (
    contract_id,
    invoice_number,
    issue_date,
    due_date,
    status,
    total_amount,
    currency,
    is_legacy,
    legacy_invoice_id,
    notes,
    created_at,
    updated_at
  )
  VALUES (
    v_contract_id,
    v_legacy_invoice.invoice_number,
    v_legacy_invoice.issue_date,
    v_legacy_invoice.due_date,
    'Pagada', -- Asumimos que facturas legacy ya están pagadas
    v_legacy_invoice.total_amount,
    v_legacy_invoice.currency,
    true,
    p_invoice_legacy_id,
    'Invoice created from legacy reconciliation',
    NOW(),
    NOW()
  )
  RETURNING id INTO v_new_invoice_id;

  -- 5. Crear invoice_items desde matches confirmados
  FOR v_match IN
    SELECT 
      m.*,
      iil.description as legacy_item_description,
      iil.quantity as legacy_item_quantity,
      iil.unit_price as legacy_item_unit_price
    FROM invoice_items_legacy_match m
    JOIN invoice_items_legacy iil ON iil.id = m.invoice_item_legacy_id
    WHERE iil.invoice_legacy_id = p_invoice_legacy_id
      AND m.status = 'confirmed'
  LOOP
    INSERT INTO invoice_items (
      invoice_id,
      contract_item_id,
      description,
      quantity,
      unit_price,
      total,
      currency,
      legacy_item_id,
      legacy_match_id,
      created_at,
      updated_at
    )
    VALUES (
      v_new_invoice_id,
      v_match.contract_item_id,
      COALESCE(v_match.product_name, v_match.legacy_item_description),
      COALESCE(v_match.legacy_item_quantity, 1),
      v_match.amount_contract_currency / COALESCE(v_match.legacy_item_quantity, 1),
      v_match.amount_contract_currency,
      v_match.currency,
      v_match.invoice_item_legacy_id,
      v_match.id,
      NOW(),
      NOW()
    );

    v_items_created := v_items_created + 1;
    v_total_amount := v_total_amount + v_match.amount_contract_currency;
  END LOOP;

  -- 6. Actualizar contract_invoices relacionados (si existen)
  UPDATE contract_invoices
  SET 
    is_satisfied = true,
    satisfied_by_legacy_id = p_invoice_legacy_id,
    updated_at = NOW()
  WHERE contract_id = v_contract_id
    AND invoice_date <= v_legacy_invoice.issue_date
    AND NOT is_satisfied
    AND id IN (
      SELECT DISTINCT ci.id
      FROM contract_invoices ci
      JOIN invoice_items_legacy_match m ON m.contract_item_id = ci.contract_item_id
      JOIN invoice_items_legacy iil ON iil.id = m.invoice_item_legacy_id
      WHERE iil.invoice_legacy_id = p_invoice_legacy_id
        AND m.status = 'confirmed'
    );

  -- 7. Actualizar factura legacy
  UPDATE invoices_legacy
  SET 
    reconciliation_status = 'confirmed',
    reconciled_invoice_id = v_new_invoice_id,
    reconciled_at = NOW(),
    updated_at = NOW()
  WHERE id = p_invoice_legacy_id;

  -- 8. Recalcular legacy_reconciliation_pct del contrato
  UPDATE contracts c
  SET legacy_reconciliation_pct = (
    SELECT 
      CASE 
        WHEN COUNT(*) = 0 THEN 0
        ELSE (COUNT(*) FILTER (WHERE reconciliation_status = 'confirmed')::NUMERIC / COUNT(*)::NUMERIC) * 100
      END
    FROM invoices_legacy
    WHERE contract_id = c.id
  )
  WHERE id = v_contract_id;

  -- Retornar resultado exitoso
  RETURN jsonb_build_object(
    'success', true,
    'legacy_invoice_id', p_invoice_legacy_id,
    'new_invoice_id', v_new_invoice_id,
    'items_created', v_items_created,
    'total_amount_contract_currency', v_total_amount,
    'contract_id', v_contract_id,
    'invoice_number', v_legacy_invoice.invoice_number,
    'message', format('Successfully reconciled legacy invoice %s with %s items', 
      v_legacy_invoice.invoice_number, v_items_created)
  );
END;
$function$

