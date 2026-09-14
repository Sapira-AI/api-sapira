CREATE OR REPLACE FUNCTION public.create_credit_note_safe(p_invoice_id uuid, p_credit_type credit_note_type, p_reason credit_note_reason, p_amount_contract_currency numeric, p_notes text DEFAULT NULL::text, p_new_date date DEFAULT NULL::date, p_nc_issue_date date DEFAULT NULL::date, p_nc_invoice_number text DEFAULT NULL::text, p_nc_fx_rate numeric DEFAULT NULL::numeric, p_revenue_treatment text DEFAULT NULL::text)
 RETURNS TABLE(success boolean, credit_note_id uuid, new_invoice_id uuid, message text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_user_id uuid;
  v_holding_id uuid;
  v_invoice public.invoices%ROWTYPE;
  v_nc_invoice_id uuid;
  v_replacement_id uuid := NULL;
  v_replacement_scheduled_at date;
  v_replacement_due_date date;
  v_existing_cancellation_count integer;
  v_ratio numeric;
  v_amount_invoice numeric;
  v_total_subtotal_contract numeric := 0;
  v_total_subtotal_invoice numeric := 0;
  v_total_tax_contract numeric := 0;
  v_total_tax_invoice numeric := 0;
  v_nc_total numeric := 0;
  v_fx_system_ratio numeric;
  v_nc_initial_status text;
  v_orig_item RECORD;
  v_new_item_id uuid;
  v_nc_fx_to_invoice numeric;
  v_nc_issue_date date;
  -- F2: distribución proporcional del descuento entre líneas de la original
  v_orig_total_subtotal numeric := 0;
  v_dist_line_count integer := 0;
  v_dist_line_idx integer := 0;
  v_dist_remaining numeric;
  v_line_amount numeric;
  -- IVA de la NC: SIEMPRE neto × tax_rate de la factura original (regla de
  -- negocio 2026-07-27) — nunca se prorratea el IVA almacenado.
  v_line_tax numeric;
  v_line_tax_invoice numeric;
BEGIN
  SELECT id INTO v_user_id FROM public.users WHERE auth_id = auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Usuario no autenticado o no encontrado';
  END IF;

  SELECT * INTO v_invoice FROM public.invoices WHERE id = p_invoice_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Factura no encontrada'; END IF;

  v_holding_id := v_invoice.holding_id;

  IF NOT EXISTS (SELECT 1 FROM public.user_holdings WHERE user_id = v_user_id AND holding_id = v_holding_id) THEN
    RAISE EXCEPTION 'Sin permisos sobre el holding de la factura';
  END IF;

  IF v_invoice.document_type = 'NC' THEN RAISE EXCEPTION 'No se puede emitir una NC sobre otra NC'; END IF;
  IF v_invoice.status = 'Cancelada' THEN RAISE EXCEPTION 'La factura ya está cancelada'; END IF;
  IF v_invoice.status NOT IN ('Emitida','Enviada','Vencida','Pagada') THEN
    RAISE EXCEPTION 'No se puede emitir NC sobre una factura en estado "%". Solo se permite sobre Emitida, Enviada, Vencida o Pagada.', v_invoice.status;
  END IF;

  IF p_credit_type = 'cancellation' THEN
    SELECT COUNT(*) INTO v_existing_cancellation_count
    FROM public.invoices
    WHERE related_invoice_id = p_invoice_id AND credit_type = 'cancellation' AND document_type = 'NC';
    IF v_existing_cancellation_count > 0 THEN RAISE EXCEPTION 'Ya existe una NC de anulación previa para esta factura'; END IF;
    -- F2: el tratamiento de revenue solo aplica a descuentos
    IF p_revenue_treatment IS NOT NULL THEN
      RAISE EXCEPTION 'El tratamiento de revenue solo aplica a NC de tipo descuento';
    END IF;
  ELSIF p_credit_type = 'discount' THEN
    IF p_amount_contract_currency IS NULL OR p_amount_contract_currency <= 0 THEN
      RAISE EXCEPTION 'El monto del descuento debe ser mayor a 0';
    END IF;
    IF p_amount_contract_currency > COALESCE(v_invoice.amount_contract_currency, 0) THEN
      RAISE EXCEPTION 'El monto del descuento (%) no puede ser mayor al monto de la factura (%)',
        p_amount_contract_currency, v_invoice.amount_contract_currency;
    END IF;
    -- F2: devengo del descuento OBLIGATORIO (sin default implícito)
    IF p_revenue_treatment IS NULL OR p_revenue_treatment NOT IN ('impact_month', 'defer_forward') THEN
      RAISE EXCEPTION 'Debes indicar cómo devengar el descuento: impact_month (impactar el mes de la NC) o defer_forward (devengar hacia adelante)';
    END IF;
  END IF;

  IF COALESCE(v_invoice.amount_contract_currency, 0) > 0 AND COALESCE(v_invoice.amount_invoice_currency, 0) > 0 THEN
    v_ratio := v_invoice.amount_contract_currency::numeric / v_invoice.amount_invoice_currency::numeric;
  ELSE
    v_ratio := 1;
  END IF;

  v_nc_initial_status := CASE p_credit_type WHEN 'cancellation' THEN 'Cancelada' ELSE 'Emitida' END;

  v_nc_issue_date    := COALESCE(p_nc_issue_date, CURRENT_DATE);
  v_nc_fx_to_invoice := COALESCE(p_nc_fx_rate, v_invoice.fx_contract_to_invoice, 1);

  INSERT INTO public.invoices(
    holding_id, company_id, client_id, client_entity_id, contract_id,
    issue_date, due_date, scheduled_at, original_issue_date,
    contract_currency, invoice_currency, system_currency,
    amount_contract_currency, amount_invoice_currency,
    vat, total_invoice_currency, amount_system_currency, total_system_currency,
    fx_contract_to_invoice, fx_contract_to_system,
    status, invoice_type, document_type, related_invoice_id,
    issuer_tax_id, issuer_legal_name, issuer_address,
    client_tax_id, payment_method, fiscal_regime, export_type,
    tax_rate, notes, invoice_number,
    credit_type, credit_reason, nc_revenue_treatment
  ) VALUES (
    v_holding_id, v_invoice.company_id, v_invoice.client_id, v_invoice.client_entity_id, v_invoice.contract_id,
    v_nc_issue_date, v_nc_issue_date, v_nc_issue_date, v_nc_issue_date,
    v_invoice.contract_currency, v_invoice.invoice_currency, v_invoice.system_currency,
    0, 0, 0, 0, 0, 0,
    v_nc_fx_to_invoice, COALESCE(v_invoice.fx_contract_to_system, 1),
    v_nc_initial_status, 'Manual', 'NC', p_invoice_id,
    v_invoice.issuer_tax_id, v_invoice.issuer_legal_name, v_invoice.issuer_address,
    v_invoice.client_tax_id, v_invoice.payment_method, v_invoice.fiscal_regime, v_invoice.export_type,
    v_invoice.tax_rate,
    'NC ' || p_credit_type::text || ' / ' || p_reason::text || COALESCE(' — ' || p_notes, ''),
    p_nc_invoice_number,
    p_credit_type::text, p_reason::text,
    CASE WHEN p_credit_type = 'discount' THEN p_revenue_treatment ELSE NULL END
  ) RETURNING id INTO v_nc_invoice_id;

  IF p_credit_type = 'cancellation' THEN
    FOR v_orig_item IN SELECT * FROM public.invoice_items WHERE invoice_id = p_invoice_id ORDER BY created_at LOOP
      INSERT INTO public.invoice_items(
        holding_id, invoice_id, contract_id, product_id,
        description, quantity, unit_of_measure, discount_pct, tax_code,
        unit_price_contract_currency, unit_price_invoice_currency,
        subtotal_contract_currency, subtotal_invoice_currency,
        tax_amount_contract_currency, tax_amount_invoice_currency,
        total_contract_currency, total_invoice_currency,
        contract_currency, invoice_currency, fx_contract_to_invoice,
        billing_period_start, billing_period_end
      ) VALUES (
        v_holding_id, v_nc_invoice_id, v_orig_item.contract_id, v_orig_item.product_id,
        COALESCE(v_orig_item.description, '') || ' (NC anulación)',
        v_orig_item.quantity, COALESCE(v_orig_item.unit_of_measure, 'UND'), COALESCE(v_orig_item.discount_pct, 0), v_orig_item.tax_code,
        -ABS(COALESCE(v_orig_item.unit_price_contract_currency, 0)), -ABS(COALESCE(v_orig_item.unit_price_invoice_currency, 0)),
        -ABS(COALESCE(v_orig_item.subtotal_contract_currency, 0)), -ABS(COALESCE(v_orig_item.subtotal_invoice_currency, 0)),
        -ABS(COALESCE(v_orig_item.tax_amount_contract_currency, 0)), -ABS(COALESCE(v_orig_item.tax_amount_invoice_currency, 0)),
        -ABS(COALESCE(v_orig_item.total_contract_currency, 0)), -ABS(COALESCE(v_orig_item.total_invoice_currency, 0)),
        v_orig_item.contract_currency, v_orig_item.invoice_currency, COALESCE(v_orig_item.fx_contract_to_invoice, 1),
        v_orig_item.billing_period_start, v_orig_item.billing_period_end
      ) RETURNING id INTO v_new_item_id;

      IF v_orig_item.contract_item_id IS NOT NULL THEN
        UPDATE public.invoice_items SET contract_item_id = v_orig_item.contract_item_id WHERE id = v_new_item_id;
      END IF;
    END LOOP;
  ELSE
    -- F2: la NC de descuento se distribuye proporcionalmente entre las líneas
    -- POSITIVAS de la factura original (por subtotal en moneda de contrato),
    -- heredando contract_item_id (vía UPDATE post-insert, bypass del trigger
    -- standardize), producto y billing period. La última línea absorbe el
    -- residuo de redondeo para que la suma sea exacta. Patrón NC32.
    SELECT COALESCE(SUM(subtotal_contract_currency), 0), COUNT(*)
    INTO v_orig_total_subtotal, v_dist_line_count
    FROM public.invoice_items
    WHERE invoice_id = p_invoice_id AND COALESCE(subtotal_contract_currency, 0) > 0;

    IF v_dist_line_count = 0 OR v_orig_total_subtotal <= 0 THEN
      -- Fallback (factura sin líneas con subtotal positivo): línea única
      -- genérica sin vínculo a ítem — comportamiento previo. Invisible para el
      -- devengo por ítem; solo netea el total facturado del documento.
      v_amount_invoice := p_amount_contract_currency / NULLIF(v_ratio, 0);
      IF v_amount_invoice IS NULL THEN v_amount_invoice := p_amount_contract_currency; END IF;
      v_line_tax := ROUND(p_amount_contract_currency * COALESCE(v_invoice.tax_rate, 0) / 100, 2);
      v_line_tax_invoice := ROUND(v_amount_invoice * COALESCE(v_invoice.tax_rate, 0) / 100, 2);

      INSERT INTO public.invoice_items(
        holding_id, invoice_id, contract_id, description, quantity, unit_of_measure, discount_pct,
        unit_price_contract_currency, unit_price_invoice_currency,
        subtotal_contract_currency, subtotal_invoice_currency,
        tax_amount_contract_currency, tax_amount_invoice_currency,
        total_contract_currency, total_invoice_currency,
        contract_currency, invoice_currency, fx_contract_to_invoice
      ) VALUES (
        v_holding_id, v_nc_invoice_id, v_invoice.contract_id,
        'Descuento aplicado' || COALESCE(' — ' || p_notes, ''),
        1, 'UND', 0,
        -ABS(p_amount_contract_currency), -ABS(v_amount_invoice),
        -ABS(p_amount_contract_currency), -ABS(v_amount_invoice),
        -ABS(v_line_tax), -ABS(v_line_tax_invoice),
        -ABS(p_amount_contract_currency + v_line_tax), -ABS(v_amount_invoice + v_line_tax_invoice),
        v_invoice.contract_currency, v_invoice.invoice_currency, COALESCE(v_invoice.fx_contract_to_invoice, 1)
      );
    ELSE
      v_dist_remaining := p_amount_contract_currency;
      v_dist_line_idx := 0;

      FOR v_orig_item IN
        SELECT * FROM public.invoice_items
        WHERE invoice_id = p_invoice_id AND COALESCE(subtotal_contract_currency, 0) > 0
        ORDER BY created_at, id
      LOOP
        v_dist_line_idx := v_dist_line_idx + 1;
        IF v_dist_line_idx = v_dist_line_count THEN
          v_line_amount := v_dist_remaining;
        ELSE
          v_line_amount := ROUND(p_amount_contract_currency * v_orig_item.subtotal_contract_currency / v_orig_total_subtotal, 2);
          v_dist_remaining := v_dist_remaining - v_line_amount;
        END IF;

        v_amount_invoice := v_line_amount / NULLIF(v_ratio, 0);
        IF v_amount_invoice IS NULL THEN v_amount_invoice := v_line_amount; END IF;
        v_line_tax := ROUND(v_line_amount * COALESCE(v_invoice.tax_rate, 0) / 100, 2);
        v_line_tax_invoice := ROUND(v_amount_invoice * COALESCE(v_invoice.tax_rate, 0) / 100, 2);

        INSERT INTO public.invoice_items(
          holding_id, invoice_id, contract_id, product_id,
          description, quantity, unit_of_measure, discount_pct, tax_code,
          unit_price_contract_currency, unit_price_invoice_currency,
          subtotal_contract_currency, subtotal_invoice_currency,
          tax_amount_contract_currency, tax_amount_invoice_currency,
          total_contract_currency, total_invoice_currency,
          contract_currency, invoice_currency, fx_contract_to_invoice,
          billing_period_start, billing_period_end
        ) VALUES (
          v_holding_id, v_nc_invoice_id, v_orig_item.contract_id, v_orig_item.product_id,
          COALESCE(v_orig_item.description, '') || ' (NC descuento)',
          1, 'UND', 0, v_orig_item.tax_code,
          -ABS(v_line_amount), -ABS(v_amount_invoice),
          -ABS(v_line_amount), -ABS(v_amount_invoice),
          -ABS(v_line_tax), -ABS(v_line_tax_invoice),
          -ABS(v_line_amount + v_line_tax), -ABS(v_amount_invoice + v_line_tax_invoice),
          v_orig_item.contract_currency, v_orig_item.invoice_currency, COALESCE(v_orig_item.fx_contract_to_invoice, 1),
          v_orig_item.billing_period_start, v_orig_item.billing_period_end
        ) RETURNING id INTO v_new_item_id;

        IF v_orig_item.contract_item_id IS NOT NULL THEN
          UPDATE public.invoice_items SET contract_item_id = v_orig_item.contract_item_id WHERE id = v_new_item_id;
        END IF;
      END LOOP;
    END IF;
  END IF;

  IF p_nc_fx_rate IS NOT NULL AND p_nc_fx_rate > 0 THEN
    UPDATE public.invoice_items
    SET unit_price_invoice_currency = ROUND(unit_price_contract_currency / p_nc_fx_rate, 2),
        subtotal_invoice_currency   = ROUND(subtotal_contract_currency   / p_nc_fx_rate, 2),
        tax_amount_invoice_currency = ROUND(tax_amount_contract_currency / p_nc_fx_rate, 2),
        total_invoice_currency      = ROUND(total_contract_currency      / p_nc_fx_rate, 2),
        fx_contract_to_invoice      = p_nc_fx_rate
    WHERE invoice_id = v_nc_invoice_id;
  END IF;

  SELECT COALESCE(SUM(subtotal_contract_currency), 0), COALESCE(SUM(subtotal_invoice_currency), 0),
         COALESCE(SUM(tax_amount_contract_currency), 0), COALESCE(SUM(tax_amount_invoice_currency), 0)
  INTO v_total_subtotal_contract, v_total_subtotal_invoice, v_total_tax_contract, v_total_tax_invoice
  FROM public.invoice_items WHERE invoice_id = v_nc_invoice_id;

  IF COALESCE(v_invoice.fx_contract_to_invoice, 0) > 0 THEN
    v_fx_system_ratio := COALESCE(v_invoice.fx_contract_to_system, v_invoice.fx_contract_to_invoice) / v_invoice.fx_contract_to_invoice;
  ELSE
    v_fx_system_ratio := 1;
  END IF;

  UPDATE public.invoices
  SET amount_contract_currency = v_total_subtotal_contract,
      amount_invoice_currency  = v_total_subtotal_invoice,
      vat                      = v_total_tax_contract,
      total_invoice_currency   = v_total_subtotal_invoice + v_total_tax_invoice,
      amount_system_currency   = (v_total_subtotal_invoice) * v_fx_system_ratio,
      total_system_currency    = (v_total_subtotal_invoice + v_total_tax_invoice) * v_fx_system_ratio
  WHERE id = v_nc_invoice_id;

  v_nc_total := v_total_subtotal_contract + v_total_tax_contract;

  IF p_credit_type = 'cancellation' THEN
    UPDATE public.invoices
    SET status = 'Cancelada',
        notes = COALESCE(notes || E'\n', '') || 'Anulada por NC ' || v_nc_invoice_id::text
    WHERE id = p_invoice_id;

    v_replacement_scheduled_at := COALESCE(p_new_date, v_invoice.scheduled_at, CURRENT_DATE);

    IF v_invoice.due_date IS NOT NULL AND v_invoice.issue_date IS NOT NULL THEN
      v_replacement_due_date := v_replacement_scheduled_at + (v_invoice.due_date - v_invoice.issue_date);
    ELSE
      v_replacement_due_date := v_replacement_scheduled_at + INTERVAL '30 days';
    END IF;

    INSERT INTO public.invoices(
      holding_id, company_id, client_id, client_entity_id, contract_id,
      issue_date, due_date, scheduled_at, original_issue_date,
      contract_currency, invoice_currency, system_currency,
      amount_contract_currency, amount_invoice_currency,
      vat, total_invoice_currency, amount_system_currency, total_system_currency,
      fx_contract_to_invoice, fx_contract_to_system,
      status, invoice_type, document_type,
      issuer_tax_id, issuer_legal_name, issuer_address,
      client_tax_id, payment_method, fiscal_regime, export_type,
      tax_rate, notes
    ) VALUES (
      v_holding_id, v_invoice.company_id, v_invoice.client_id, v_invoice.client_entity_id, v_invoice.contract_id,
      v_replacement_scheduled_at, v_replacement_due_date, v_replacement_scheduled_at, v_replacement_scheduled_at,
      v_invoice.contract_currency, v_invoice.invoice_currency, v_invoice.system_currency,
      v_invoice.amount_contract_currency, v_invoice.amount_invoice_currency,
      v_invoice.vat, v_invoice.total_invoice_currency, v_invoice.amount_system_currency, v_invoice.total_system_currency,
      COALESCE(v_invoice.fx_contract_to_invoice, 1), COALESCE(v_invoice.fx_contract_to_system, 1),
      'Por Emitir', 'Manual', 'FACTURA',
      v_invoice.issuer_tax_id, v_invoice.issuer_legal_name, v_invoice.issuer_address,
      v_invoice.client_tax_id, v_invoice.payment_method, v_invoice.fiscal_regime, v_invoice.export_type,
      v_invoice.tax_rate,
      'Reemplazo de ' || COALESCE(v_invoice.invoice_number, v_invoice.id::text) || ' (anulada por NC)'
    ) RETURNING id INTO v_replacement_id;

    FOR v_orig_item IN SELECT * FROM public.invoice_items WHERE invoice_id = p_invoice_id ORDER BY created_at LOOP
      INSERT INTO public.invoice_items(
        holding_id, invoice_id, contract_id, product_id,
        description, quantity, unit_of_measure, discount_pct, tax_code,
        unit_price_contract_currency, unit_price_invoice_currency,
        subtotal_contract_currency, subtotal_invoice_currency,
        tax_amount_contract_currency, tax_amount_invoice_currency,
        total_contract_currency, total_invoice_currency,
        contract_currency, invoice_currency, fx_contract_to_invoice,
        billing_period_start, billing_period_end
      ) VALUES (
        v_holding_id, v_replacement_id, v_orig_item.contract_id, v_orig_item.product_id,
        v_orig_item.description, v_orig_item.quantity, COALESCE(v_orig_item.unit_of_measure, 'UND'),
        COALESCE(v_orig_item.discount_pct, 0), v_orig_item.tax_code,
        v_orig_item.unit_price_contract_currency, v_orig_item.unit_price_invoice_currency,
        v_orig_item.subtotal_contract_currency, v_orig_item.subtotal_invoice_currency,
        v_orig_item.tax_amount_contract_currency, v_orig_item.tax_amount_invoice_currency,
        v_orig_item.total_contract_currency, v_orig_item.total_invoice_currency,
        v_orig_item.contract_currency, v_orig_item.invoice_currency, COALESCE(v_orig_item.fx_contract_to_invoice, 1),
        v_orig_item.billing_period_start, v_orig_item.billing_period_end
      ) RETURNING id INTO v_new_item_id;

      IF v_orig_item.contract_item_id IS NOT NULL THEN
        UPDATE public.invoice_items SET contract_item_id = v_orig_item.contract_item_id WHERE id = v_new_item_id;
      END IF;
    END LOOP;
  END IF;

  IF v_invoice.contract_id IS NOT NULL THEN
    PERFORM public.log_lifecycle_event(
      v_invoice.contract_id,
      CASE WHEN p_credit_type = 'cancellation' THEN 'INVOICE_CANCELLED' ELSE 'INVOICE_CREDIT_NOTE' END,
      'NC manual por ' || p_reason::text,
      CURRENT_DATE, v_nc_total,
      'NC ' || p_credit_type::text || ' sobre factura ' || COALESCE(v_invoice.invoice_number, 'sin número'),
      COALESCE(p_notes, ''),
      jsonb_build_object(
        'original_invoice_id', p_invoice_id,
        'nc_invoice_id', v_nc_invoice_id,
        'replacement_invoice_id', v_replacement_id,
        'credit_type', p_credit_type::text,
        'credit_reason', p_reason::text,
        'nc_status', v_nc_initial_status,
        'nc_issue_date', v_nc_issue_date,
        'nc_invoice_number', p_nc_invoice_number,
        'nc_fx_rate', p_nc_fx_rate,
        'nc_revenue_treatment', CASE WHEN p_credit_type = 'discount' THEN p_revenue_treatment ELSE NULL END
      ),
      p_reason::text, 'Recorded'
    );
  END IF;

  RETURN QUERY SELECT true, v_nc_invoice_id, v_replacement_id,
    CASE WHEN p_credit_type = 'cancellation'
         THEN 'Nota de crédito registrada (Cancelada, no afecta KPIs) y factura de reemplazo Por Emitir generada'
         ELSE 'Nota de crédito (descuento) registrada'
    END::text;
END;
$function$

