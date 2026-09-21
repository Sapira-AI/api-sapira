CREATE OR REPLACE FUNCTION public.reconcile_legacy_invoice(p_legacy_invoice_id uuid, p_contract_id uuid, p_matches jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_holding_id           uuid;
  v_legacy_invoice       invoices_legacy%ROWTYPE;
  v_contract             contracts%ROWTYPE;
  v_ci                   contract_invoices%ROWTYPE;
  v_new_invoice_id       uuid;
  v_total_contract       numeric := 0;
  v_total_invoice        numeric := 0;
  v_fx_rate              numeric := 1.0;
  v_vat_amount           numeric := 0;
  v_total_with_vat       numeric;
  v_tax_rate_pct         numeric;
  v_matches_count        integer;
  v_items_count          integer;
  v_i                    integer;
  v_j                    integer;
  v_match                jsonb;
  v_item_detail          jsonb;
  v_coverage_contract    numeric;
  v_coverage_invoice     numeric;
  v_remaining            numeric;
  v_item_proportion      numeric;
  v_item_amount_contract numeric;
  v_item_amount_invoice  numeric;
  v_item_name            text;
  v_contract_item_id     uuid;
  -- Variables para inserción sin trigger override
  v_item_id              uuid;
  v_item_quantity        numeric := 1;
  v_unit_price_contract  numeric;
  v_unit_price_invoice   numeric;
BEGIN
  v_holding_id := get_current_user_holding_id();

  -- ─── Validar acceso a la factura legacy ───────────────────────────────────
  SELECT * INTO v_legacy_invoice
  FROM invoices_legacy
  WHERE id = p_legacy_invoice_id AND holding_id = v_holding_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Factura legacy no encontrada');
  END IF;

  -- ─── Validar acceso al contrato ───────────────────────────────────────────
  -- Nota: eliminada la restricción AND is_legacy = true para soportar contratos
  -- con contract_invoices que no están marcados como legacy (ej.: contratos
  -- en estados intermedios como 'Borrador', 'En revisión', etc.)
  SELECT * INTO v_contract
  FROM contracts
  WHERE id = p_contract_id AND holding_id = v_holding_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Contrato no encontrado');
  END IF;

  -- ─── Validar que haya al menos un match ───────────────────────────────────
  v_matches_count := jsonb_array_length(p_matches);
  IF v_matches_count = 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'No se proporcionaron matches');
  END IF;

  -- ─── Calcular totales para FX ─────────────────────────────────────────────
  FOR v_i IN 0..(v_matches_count - 1) LOOP
    v_match := p_matches->v_i;
    v_total_contract := v_total_contract + COALESCE((v_match->>'coverage_amount_contract')::numeric, 0);
    v_total_invoice  := v_total_invoice  + COALESCE((v_match->>'coverage_amount_invoice')::numeric, 0);
  END LOOP;

  -- FX: cuántas unidades de moneda factura por unidad de moneda contrato
  v_fx_rate := CASE
    WHEN v_total_contract > 0 THEN ROUND(v_total_invoice / v_total_contract, 6)
    ELSE 1.0
  END;

  -- ─── IVA proporcional al monto reconciliado ────────────────────────────────
  v_vat_amount := CASE
    WHEN COALESCE(v_legacy_invoice.amount_invoice_currency, 0) > 0
    THEN ROUND(
      COALESCE(v_legacy_invoice.vat, 0)
      * v_total_invoice / v_legacy_invoice.amount_invoice_currency,
      2
    )
    ELSE COALESCE(v_legacy_invoice.vat, 0)
  END;

  v_total_with_vat := v_total_invoice + v_vat_amount;

  v_tax_rate_pct := CASE
    WHEN v_total_invoice > 0 AND v_vat_amount > 0
    THEN ROUND((v_vat_amount / v_total_invoice) * 100, 2)
    ELSE NULL
  END;

  -- ─── Crear factura normalizada en invoices ────────────────────────────────
  INSERT INTO invoices (
    holding_id,
    company_id,
    client_id,
    client_entity_id,
    client_tax_id,
    contract_id,
    invoice_number,
    issue_date,
    due_date,
    scheduled_at,
    original_issue_date,
    contract_currency,
    invoice_currency,
    amount_contract_currency,
    amount_invoice_currency,
    vat,
    total_invoice_currency,
    tax_rate,
    fx_contract_to_invoice,
    is_legacy,
    legacy_invoice_id,
    status
  ) VALUES (
    v_holding_id,
    v_legacy_invoice.company_id,
    v_contract.client_id,
    v_legacy_invoice.client_entity_id,
    v_legacy_invoice.client_tax_id,
    p_contract_id,
    v_legacy_invoice.invoice_number,
    v_legacy_invoice.issue_date,
    v_legacy_invoice.due_date,
    v_legacy_invoice.issue_date,
    v_legacy_invoice.issue_date,
    v_contract.contract_currency,
    v_legacy_invoice.invoice_currency,
    v_total_contract,
    v_total_invoice,
    v_vat_amount,
    v_total_with_vat,
    v_tax_rate_pct,
    v_fx_rate,
    true,
    p_legacy_invoice_id,
    v_legacy_invoice.status
  )
  RETURNING id INTO v_new_invoice_id;

  -- ─── Procesar cada match ──────────────────────────────────────────────────
  FOR v_i IN 0..(v_matches_count - 1) LOOP
    v_match             := p_matches->v_i;
    v_coverage_contract := COALESCE((v_match->>'coverage_amount_contract')::numeric, 0);
    v_coverage_invoice  := COALESCE((v_match->>'coverage_amount_invoice')::numeric, 0);

    SELECT * INTO v_ci
    FROM contract_invoices
    WHERE id = (v_match->>'contract_invoice_id')::uuid
      AND contract_id = p_contract_id;

    IF NOT FOUND THEN CONTINUE; END IF;

    v_remaining := ROUND(v_ci.amount - v_coverage_contract, 2);

    IF v_remaining > 0.01 THEN
      UPDATE contract_invoices
      SET amount     = v_coverage_contract,
          updated_at = NOW()
      WHERE id = v_ci.id;

      INSERT INTO contract_invoices (
        contract_id, holding_id, invoice_date, amount, currency,
        status, is_satisfied, is_editable, contract_item_details
      ) VALUES (
        p_contract_id, v_holding_id, v_ci.invoice_date, v_remaining, v_ci.currency,
        'Programada', false, true, v_ci.contract_item_details
      );
    END IF;

    UPDATE contract_invoices
    SET is_satisfied           = true,
        satisfied_by_legacy_id = p_legacy_invoice_id,
        updated_at             = NOW()
    WHERE id = v_ci.id;

    -- ─── Crear invoice_items proporcionales ────────────────────────────────
    -- FIX: insertar SIN contract_item_id para evitar que el trigger
    -- standardize_invoice_items sobreescriba quantity y unit_price.
    -- Luego UPDATE separado asigna contract_item_id sin disparar el trigger.
    v_items_count := GREATEST(jsonb_array_length(v_ci.contract_item_details), 1);

    FOR v_j IN 0..(jsonb_array_length(v_ci.contract_item_details) - 1) LOOP
      v_item_detail := v_ci.contract_item_details->v_j;

      -- Proporción del ítem en el total del período
      v_item_proportion := CASE
        WHEN v_ci.amount > 0 AND (v_item_detail->>'amount') IS NOT NULL
          THEN COALESCE((v_item_detail->>'amount')::numeric, 0) / v_ci.amount
        ELSE
          1.0 / v_items_count
      END;

      -- Montos del período para este ítem (en cada moneda)
      v_item_amount_contract := ROUND(v_coverage_contract * v_item_proportion, 2);
      v_item_amount_invoice  := ROUND(v_coverage_invoice  * v_item_proportion, 2);

      v_item_name        := COALESCE(v_item_detail->>'product_name', 'Producto legacy');
      v_contract_item_id := NULLIF(v_item_detail->>'contract_item_id', '')::uuid;

      -- Leer quantity real del contract_item para calcular precio unitario correcto
      v_item_quantity := 1;
      IF v_contract_item_id IS NOT NULL THEN
        SELECT COALESCE(quantity, 1)
        INTO   v_item_quantity
        FROM   contract_items
        WHERE  id = v_contract_item_id;
      END IF;

      -- Precio unitario = monto período / unidades
      -- Así subtotal = quantity * unit_price = v_item_amount (correcto)
      v_unit_price_contract := ROUND(v_item_amount_contract / NULLIF(v_item_quantity, 0), 6);
      v_unit_price_invoice  := ROUND(v_item_amount_invoice  / NULLIF(v_item_quantity, 0), 6);

      -- INSERT sin contract_item_id → trigger standardize_invoice_items retorna NEW sin cambios
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
      ) VALUES (
        v_new_invoice_id,
        v_holding_id,
        p_contract_id,
        v_item_name,
        v_item_quantity,
        v_unit_price_contract,
        v_item_amount_contract,
        v_item_amount_contract,
        v_unit_price_invoice,
        v_item_amount_invoice,
        v_item_amount_invoice,
        v_contract.contract_currency,
        v_legacy_invoice.invoice_currency,
        v_fx_rate
      ) RETURNING id INTO v_item_id;

      -- UPDATE separado: asigna contract_item_id sin activar standardize_invoice_items
      -- (ese trigger es BEFORE INSERT, no corre en UPDATE)
      IF v_contract_item_id IS NOT NULL THEN
        UPDATE invoice_items
        SET contract_item_id = v_contract_item_id
        WHERE id = v_item_id;
      END IF;

    END LOOP;

    -- Fallback: si contract_item_details está vacío, crear un ítem genérico
    IF jsonb_array_length(v_ci.contract_item_details) = 0 THEN
      INSERT INTO invoice_items (
        invoice_id, holding_id, contract_id,
        description, quantity,
        unit_price_contract_currency, subtotal_contract_currency, total_contract_currency,
        unit_price_invoice_currency,  subtotal_invoice_currency,  total_invoice_currency,
        contract_currency, invoice_currency, fx_contract_to_invoice
      ) VALUES (
        v_new_invoice_id, v_holding_id, p_contract_id,
        'Factura legacy reconciliada', 1,
        v_coverage_contract, v_coverage_contract, v_coverage_contract,
        v_coverage_invoice,  v_coverage_invoice,  v_coverage_invoice,
        v_contract.contract_currency, v_legacy_invoice.invoice_currency, v_fx_rate
      );
      -- No UPDATE de contract_item_id (no hay item de referencia)
    END IF;

  END LOOP;

  -- ─── Marcar factura legacy como migrada ───────────────────────────────────
  UPDATE invoices_legacy
  SET reconciliation_status = 'migrated',
      reconciled_invoice_id = v_new_invoice_id,
      contract_id           = p_contract_id,
      reconciled_at         = NOW()
  WHERE id = p_legacy_invoice_id;

  -- ─── Actualizar % de reconciliación del contrato ──────────────────────────
  PERFORM update_legacy_reconciliation_pct(p_contract_id);

  RETURN jsonb_build_object(
    'success',        true,
    'invoice_id',     v_new_invoice_id,
    'fx_rate',        v_fx_rate,
    'total_contract', v_total_contract,
    'total_invoice',  v_total_invoice,
    'vat_amount',     v_vat_amount,
    'total_with_vat', v_total_with_vat
  );
END;
$function$

