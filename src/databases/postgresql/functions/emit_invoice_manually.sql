CREATE OR REPLACE FUNCTION public.emit_invoice_manually(p_invoice_id uuid, p_emission_data jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_invoice RECORD;
  v_new_invoice_id uuid;
  v_remaining_invoice_id uuid;
  v_holding_id uuid;
  v_user_id uuid;

  -- Datos de emisión (usando campos existentes)
  v_issue_date date;
  v_invoice_number text;
  v_folio text;
  v_invoice_currency text;
  v_fx_contract_to_invoice numeric;
  v_total_amount numeric;

  -- Para división
  v_should_split boolean := false;
  v_items_data jsonb;
  v_item jsonb;
  v_emitted_subtotal numeric := 0;
  v_emitted_vat numeric := 0;
  v_emitted_total numeric := 0;
  v_remaining_subtotal numeric := 0;
  v_remaining_vat numeric := 0;
  v_remaining_total numeric := 0;

BEGIN
  -- Obtener factura original
  SELECT * INTO v_invoice
  FROM invoices
  WHERE id = p_invoice_id
    AND status = 'Por Emitir'
    AND is_active = true;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Factura no encontrada o no está en estado Por Emitir';
  END IF;

  v_holding_id := v_invoice.holding_id;
  SELECT get_current_user_id() INTO v_user_id;

  -- Extraer datos de emisión del JSON
  v_issue_date := COALESCE(
    (p_emission_data->>'issue_date')::date,
    CURRENT_DATE
  );

  v_invoice_number := p_emission_data->>'invoice_number';
  v_folio := p_emission_data->>'folio';

  v_invoice_currency := COALESCE(
    p_emission_data->>'invoice_currency',
    v_invoice.invoice_currency
  );

  v_fx_contract_to_invoice := COALESCE(
    (p_emission_data->>'fx_contract_to_invoice')::numeric,
    v_invoice.fx_contract_to_invoice,
    1.0
  );

  -- Obtener items con montos ajustados (si vienen)
  v_items_data := p_emission_data->'items';

  -- Si vienen items ajustados, calcular totales y verificar si hay división
  IF v_items_data IS NOT NULL AND jsonb_array_length(v_items_data) > 0 THEN

    -- Calcular totales de lo que se va a emitir
    FOR v_item IN SELECT * FROM jsonb_array_elements(v_items_data)
    LOOP
      v_emitted_subtotal := v_emitted_subtotal + COALESCE((v_item->>'subtotal_invoice_currency')::numeric, 0);
      v_emitted_vat := v_emitted_vat + COALESCE((v_item->>'tax_amount_invoice_currency')::numeric, 0);
      v_emitted_total := v_emitted_total + COALESCE((v_item->>'total_invoice_currency')::numeric, 0);
    END LOOP;

    -- Decisión de split basada en NETO (subtotal sin IVA): el IVA es derivado
    -- y nunca debe dejar saldo pendiente. Si el usuario sólo cambia el
    -- document_type a uno exento (FACTURA_EXPORTACION) o el tax_rate, el
    -- subtotal no cambia → no hay split.
    IF v_emitted_subtotal < v_invoice.amount_invoice_currency THEN
      v_should_split := true;

      -- Calcular montos restantes desde el neto. El IVA del restante se
      -- recalcula desde el subtotal restante usando la tasa efectiva
      -- (vat / subtotal_neto) de la factura original; si el original ya tenía
      -- IVA = 0 (export), el restante también queda con IVA = 0.
      v_remaining_subtotal := v_invoice.amount_invoice_currency - v_emitted_subtotal;
      v_remaining_vat := CASE
        WHEN v_invoice.amount_invoice_currency > 0
          THEN ROUND(v_remaining_subtotal * (v_invoice.vat / v_invoice.amount_invoice_currency), 2)
        ELSE 0
      END;
      v_remaining_total := v_remaining_subtotal + v_remaining_vat;

      -- Validar que el neto restante sea positivo
      IF v_remaining_subtotal <= 0 THEN
        RAISE EXCEPTION 'El neto restante debe ser mayor a cero para dividir la factura';
      END IF;
    END IF;

    v_total_amount := v_emitted_total;
  ELSE
    -- Si no vienen items, emitir el total programado
    v_total_amount := v_invoice.total_invoice_currency;
    v_emitted_subtotal := v_invoice.amount_invoice_currency;
    v_emitted_vat := v_invoice.vat;
    v_emitted_total := v_invoice.total_invoice_currency;
  END IF;

  -- ============================================================================
  -- CASO 1: Emisión completa (sin división)
  -- ============================================================================
  IF NOT v_should_split THEN

    -- Actualizar factura original con datos reales
    UPDATE invoices
    SET
      status = 'Emitida',
      issue_date = v_issue_date,
      invoice_number = COALESCE(v_invoice_number, invoice_number),
      folio_fiscal_prev = COALESCE(v_folio, folio_fiscal_prev),
      invoice_currency = v_invoice_currency,
      fx_contract_to_invoice = v_fx_contract_to_invoice
    WHERE id = p_invoice_id;

    -- Si vienen items ajustados, actualizarlos
    IF v_items_data IS NOT NULL AND jsonb_array_length(v_items_data) > 0 THEN
      FOR v_item IN SELECT * FROM jsonb_array_elements(v_items_data)
      LOOP
        UPDATE invoice_items
        SET
          quantity = COALESCE((v_item->>'quantity')::numeric, quantity),
          unit_price_invoice_currency = COALESCE((v_item->>'unit_price_invoice_currency')::numeric, unit_price_invoice_currency),
          subtotal_invoice_currency = COALESCE((v_item->>'subtotal_invoice_currency')::numeric, subtotal_invoice_currency),
          tax_amount_invoice_currency = COALESCE((v_item->>'tax_amount_invoice_currency')::numeric, tax_amount_invoice_currency),
          total_invoice_currency = COALESCE((v_item->>'total_invoice_currency')::numeric, total_invoice_currency)
        WHERE id = (v_item->>'invoice_item_id')::uuid;
      END LOOP;
    END IF;

    -- Registrar evento
    PERFORM log_lifecycle_event(
      v_invoice.contract_id,
      'INVOICE_EMITTED_MANUALLY',
      'Factura Emitida Manualmente',
      v_issue_date,
      NULL,
      format('Factura emitida por %s', COALESCE(v_total_amount::text, 'monto completo')),
      p_emission_data->>'notes',
      jsonb_build_object(
        'invoice_id', p_invoice_id,
        'invoice_number', v_invoice_number,
        'folio', v_folio,
        'issue_date', v_issue_date,
        'amount', v_total_amount
      ),
      'invoice',
      'Completed'
    );

    RETURN jsonb_build_object(
      'success', true,
      'action', 'emitted_complete',
      'invoice_id', p_invoice_id,
      'invoice_number', v_invoice_number,
      'amount', v_total_amount
    );

  -- ============================================================================
  -- CASO 2: Emisión parcial (con división)
  -- ============================================================================
  ELSE

    -- Marcar factura original como inactiva y dividida
    UPDATE invoices
    SET
      is_active = false,
      status = 'Dividida'
    WHERE id = p_invoice_id;

    -- Crear factura EMITIDA con el monto real
    -- FIX: removido amount_net (columna inexistente)
    INSERT INTO invoices(
      holding_id,
      contract_id,
      company_id,
      client_id,
      client_entity_id,
      scheduled_at,
      original_issue_date,
      issue_date,
      invoice_number,
      folio_fiscal_prev,
      contract_currency,
      invoice_currency,
      amount_contract_currency,
      amount_invoice_currency,
      vat,
      total_invoice_currency,
      fx_contract_to_invoice,
      status,
      document_type,
      invoice_type,
      invoice_group_id,
      issuer_tax_id,
      issuer_legal_name,
      issuer_address,
      client_tax_id,
      payment_method,
      fiscal_regime,
      export_type,
      is_active,
      split_from_invoice_id,
      split_reason
    )
    SELECT
      v_holding_id,
      v_invoice.contract_id,
      v_invoice.company_id,
      v_invoice.client_id,
      v_invoice.client_entity_id,
      v_invoice.scheduled_at,
      v_invoice.original_issue_date,
      v_issue_date,
      v_invoice_number,
      v_folio,
      v_invoice.contract_currency,
      v_invoice_currency,
      v_emitted_subtotal,
      v_emitted_subtotal,
      v_emitted_vat,
      v_emitted_total,
      v_fx_contract_to_invoice,
      'Emitida',
      v_invoice.document_type,
      v_invoice.invoice_type,
      v_invoice.invoice_group_id,
      v_invoice.issuer_tax_id,
      v_invoice.issuer_legal_name,
      v_invoice.issuer_address,
      v_invoice.client_tax_id,
      v_invoice.payment_method,
      v_invoice.fiscal_regime,
      v_invoice.export_type,
      true, -- Activa
      p_invoice_id,
      'partial_emission'
    RETURNING id INTO v_new_invoice_id;

    -- Crear items de la factura emitida (solo items con cantidad > 0)
    IF v_items_data IS NOT NULL AND jsonb_array_length(v_items_data) > 0 THEN
      FOR v_item IN SELECT * FROM jsonb_array_elements(v_items_data)
      LOOP
        -- Solo insertar si cantidad > 0 y total > 0
        IF COALESCE((v_item->>'quantity')::numeric, 0) > 0
           AND COALESCE((v_item->>'total_invoice_currency')::numeric, 0) > 0 THEN
          INSERT INTO invoice_items(
            invoice_id,
            holding_id,
            contract_item_id,
            product_id,
            description,
            quantity,
            unit_of_measure,
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
            billing_period_start,
            billing_period_end
          )
          SELECT
            v_new_invoice_id,
            v_holding_id,
            (v_item->>'contract_item_id')::uuid,
            (v_item->>'product_id')::uuid,
            v_item->>'description',
            (v_item->>'quantity')::numeric,
            v_item->>'unit_of_measure',
            (v_item->>'unit_price_contract_currency')::numeric,
            (v_item->>'unit_price_invoice_currency')::numeric,
            (v_item->>'subtotal_contract_currency')::numeric,
            (v_item->>'subtotal_invoice_currency')::numeric,
            (v_item->>'tax_amount_contract_currency')::numeric,
            (v_item->>'tax_amount_invoice_currency')::numeric,
            (v_item->>'total_contract_currency')::numeric,
            (v_item->>'total_invoice_currency')::numeric,
            v_invoice.contract_currency,
            v_invoice_currency,
            (v_item->>'billing_period_start')::date,
            (v_item->>'billing_period_end')::date;
        END IF;
      END LOOP;
    END IF;

    -- Crear factura RESTANTE (Por Emitir)
    -- FIX: removido amount_net (columna inexistente)
    INSERT INTO invoices(
      holding_id,
      contract_id,
      company_id,
      client_id,
      client_entity_id,
      scheduled_at,
      original_issue_date,
      contract_currency,
      invoice_currency,
      amount_contract_currency,
      amount_invoice_currency,
      vat,
      total_invoice_currency,
      fx_contract_to_invoice,
      status,
      document_type,
      invoice_type,
      invoice_group_id,
      issuer_tax_id,
      issuer_legal_name,
      issuer_address,
      client_tax_id,
      payment_method,
      fiscal_regime,
      export_type,
      is_active,
      split_from_invoice_id,
      split_reason
    )
    SELECT
      v_holding_id,
      v_invoice.contract_id,
      v_invoice.company_id,
      v_invoice.client_id,
      v_invoice.client_entity_id,
      v_invoice.scheduled_at, -- Mantener fecha programada original
      v_invoice.original_issue_date,
      v_invoice.contract_currency,
      v_invoice.invoice_currency,
      v_remaining_subtotal,
      v_remaining_subtotal,
      v_remaining_vat,
      v_remaining_total,
      v_invoice.fx_contract_to_invoice,
      'Por Emitir',
      v_invoice.document_type,
      v_invoice.invoice_type,
      v_invoice.invoice_group_id,
      v_invoice.issuer_tax_id,
      v_invoice.issuer_legal_name,
      v_invoice.issuer_address,
      v_invoice.client_tax_id,
      v_invoice.payment_method,
      v_invoice.fiscal_regime,
      v_invoice.export_type,
      true, -- Activa
      p_invoice_id,
      'remaining_after_split'
    RETURNING id INTO v_remaining_invoice_id;

    -- Crear items de la factura RESTANTE.
    -- Los montos se derivan del NETO restante por item; el IVA del restante
    -- se reconstruye desde el subtotal restante usando la tasa efectiva del
    -- item original (vat/subtotal) — así items y cabezal siempre cuadran y
    -- el IVA jamás genera "saldo pendiente" por sí solo (consistente con la
    -- decisión de split por neto en líneas anteriores).
    -- Filtro: solo items donde el neto restante (subtotal) sea > 0.
    INSERT INTO invoice_items(
      invoice_id,
      holding_id,
      contract_item_id,
      product_id,
      description,
      quantity,
      unit_of_measure,
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
      billing_period_start,
      billing_period_end
    )
    SELECT
      v_remaining_invoice_id,
      ii.holding_id,
      ii.contract_item_id,
      ii.product_id,
      ii.description,
      ii.quantity - COALESCE(
        (SELECT (item->>'quantity')::numeric
         FROM jsonb_array_elements(v_items_data) item
         WHERE (item->>'invoice_item_id')::uuid = ii.id),
        0
      ) as remaining_quantity,
      ii.unit_of_measure,
      ii.unit_price_contract_currency,
      ii.unit_price_invoice_currency,
      -- Subtotal restante por moneda
      ii.subtotal_contract_currency - COALESCE(
        (SELECT (item->>'subtotal_contract_currency')::numeric
         FROM jsonb_array_elements(v_items_data) item
         WHERE (item->>'invoice_item_id')::uuid = ii.id),
        0
      ) as remaining_subtotal_contract,
      ii.subtotal_invoice_currency - COALESCE(
        (SELECT (item->>'subtotal_invoice_currency')::numeric
         FROM jsonb_array_elements(v_items_data) item
         WHERE (item->>'invoice_item_id')::uuid = ii.id),
        0
      ) as remaining_subtotal_invoice,
      -- IVA restante = subtotal_restante × tasa_efectiva del item original
      ROUND(
        (ii.subtotal_contract_currency - COALESCE(
          (SELECT (item->>'subtotal_contract_currency')::numeric
           FROM jsonb_array_elements(v_items_data) item
           WHERE (item->>'invoice_item_id')::uuid = ii.id),
          0
        )) * (ii.tax_amount_contract_currency / NULLIF(ii.subtotal_contract_currency, 0)),
        2
      ) as remaining_tax_contract,
      ROUND(
        (ii.subtotal_invoice_currency - COALESCE(
          (SELECT (item->>'subtotal_invoice_currency')::numeric
           FROM jsonb_array_elements(v_items_data) item
           WHERE (item->>'invoice_item_id')::uuid = ii.id),
          0
        )) * (ii.tax_amount_invoice_currency / NULLIF(ii.subtotal_invoice_currency, 0)),
        2
      ) as remaining_tax_invoice,
      -- Total restante = subtotal_restante × (1 + tasa_efectiva)
      (ii.subtotal_contract_currency - COALESCE(
        (SELECT (item->>'subtotal_contract_currency')::numeric
         FROM jsonb_array_elements(v_items_data) item
         WHERE (item->>'invoice_item_id')::uuid = ii.id),
        0
      )) * (1 + COALESCE(ii.tax_amount_contract_currency / NULLIF(ii.subtotal_contract_currency, 0), 0)) as remaining_total_contract,
      (ii.subtotal_invoice_currency - COALESCE(
        (SELECT (item->>'subtotal_invoice_currency')::numeric
         FROM jsonb_array_elements(v_items_data) item
         WHERE (item->>'invoice_item_id')::uuid = ii.id),
        0
      )) * (1 + COALESCE(ii.tax_amount_invoice_currency / NULLIF(ii.subtotal_invoice_currency, 0), 0)) as remaining_total_invoice,
      ii.contract_currency,
      ii.invoice_currency,
      ii.billing_period_start,
      ii.billing_period_end
    FROM invoice_items ii
    WHERE ii.invoice_id = p_invoice_id
      -- Solo items con cantidad restante > 0 y NETO restante > 0
      AND (ii.quantity - COALESCE(
        (SELECT (item->>'quantity')::numeric
         FROM jsonb_array_elements(v_items_data) item
         WHERE (item->>'invoice_item_id')::uuid = ii.id),
        0
      )) > 0
      AND (ii.subtotal_invoice_currency - COALESCE(
        (SELECT (item->>'subtotal_invoice_currency')::numeric
         FROM jsonb_array_elements(v_items_data) item
         WHERE (item->>'invoice_item_id')::uuid = ii.id),
        0
      )) > 0;

    -- Registrar evento de división
    PERFORM log_lifecycle_event(
      v_invoice.contract_id,
      'INVOICE_SPLIT_ON_EMISSION',
      'Factura Dividida al Emitir',
      v_issue_date,
      NULL,
      format('Factura dividida: emitida %s, restante %s', v_emitted_total, v_remaining_total),
      p_emission_data->>'notes',
      jsonb_build_object(
        'original_invoice_id', p_invoice_id,
        'emitted_invoice_id', v_new_invoice_id,
        'remaining_invoice_id', v_remaining_invoice_id,
        'emitted_amount', v_emitted_total,
        'remaining_amount', v_remaining_total,
        'invoice_number', v_invoice_number
      ),
      'invoice',
      'Completed'
    );

    RETURN jsonb_build_object(
      'success', true,
      'action', 'split_and_emitted',
      'original_invoice_id', p_invoice_id,
      'emitted_invoice_id', v_new_invoice_id,
      'remaining_invoice_id', v_remaining_invoice_id,
      'emitted_amount', v_emitted_total,
      'remaining_amount', v_remaining_total,
      'invoice_number', v_invoice_number
    );

  END IF;
END;
$function$;

COMMENT ON FUNCTION public."emit_invoice_manually"(p_invoice_id uuid, p_emission_data jsonb) IS 'Emite una factura manualmente con datos reales del ERP. Soporta división si el monto emitido es menor al programado.';
