CREATE OR REPLACE FUNCTION public.generate_invoices_for_contract_item(p_item_id uuid, p_metadata jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_item RECORD;
  v_contract RECORD;
  v_company RECORD;
  v_client RECORD;
  v_entity RECORD;
  v_holding UUID;
  v_item_start DATE;
  v_item_end DATE;
  v_term_months INT;
  v_frequency_months INT;
  v_period_months INT;
  v_freq TEXT;
  v_method TEXT;
  v_method_raw TEXT;
  v_total_invoices INT;
  v_amount_per_period NUMERIC;
  v_new_invoice_id UUID;
  v_invoice_count INT := 0;
  v_created_invoices JSONB := '[]'::JSONB;
  v_tax_rate NUMERIC;
  v_subtotal NUMERIC;
  v_tax_amount NUMERIC;
  v_total NUMERIC;
  v_period_start DATE;
  v_period_end DATE;
  v_scheduled_date DATE;
  v_billing_period RECORD;
  v_i INT;
BEGIN
  SELECT ci.*, c.holding_id, c.company_id, c.client_id, c.client_entity_id, c.contract_currency
  INTO v_item
  FROM contract_items ci
  JOIN contracts c ON c.id = ci.contract_id
  WHERE ci.id = p_item_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Contract item % not found', p_item_id;
  END IF;

  v_holding := v_item.holding_id;

  SELECT * INTO v_contract FROM contracts WHERE id = v_item.contract_id;
  SELECT * INTO v_company FROM companies WHERE id = v_contract.company_id;
  SELECT * INTO v_client FROM clients WHERE id = v_contract.client_id;
  SELECT * INTO v_entity FROM client_entities WHERE id = v_contract.client_entity_id;

  v_item_start := COALESCE(
    (p_metadata->>'start_date')::DATE,
    v_item.start_date,
    v_contract.booking_date,
    CURRENT_DATE
  );

  v_term_months := COALESCE(
    (p_metadata->>'term_months')::INT,
    v_item.term_months,
    12
  );

  v_item_end := COALESCE(
    v_item.end_date,
    v_item_start + (v_term_months || ' months')::INTERVAL
  );

  v_freq := LOWER(COALESCE(p_metadata->>'billing_frequency', v_item.billing_frequency, 'mensual'));
  IF v_freq LIKE '%trimest%' OR v_freq LIKE '%quarter%' THEN
    v_period_months := 3; v_freq := 'trimestral';
  ELSIF v_freq LIKE '%semest%' OR v_freq LIKE '%half%' THEN
    v_period_months := 6; v_freq := 'semestral';
  ELSIF v_freq LIKE '%anual%' OR v_freq LIKE '%year%' THEN
    v_period_months := 12; v_freq := 'anual';
  ELSE
    v_period_months := 1; v_freq := 'mensual';
  END IF;

  v_method_raw := LOWER(COALESCE(p_metadata->>'billing_method', v_item.billing_method, 'anticipado'));
  IF v_method_raw LIKE '%vencid%' OR v_method_raw LIKE '%arrear%' OR v_method_raw LIKE '%post%' THEN
    v_method := 'vencido';
  ELSE
    v_method := 'anticipado';
  END IF;

  v_total_invoices := CEIL(v_term_months::NUMERIC / v_period_months);
  v_amount_per_period := v_item.final_price / v_total_invoices;

  v_tax_rate := v_company.tax_rate;
  IF v_tax_rate IS NULL THEN
    RAISE EXCEPTION 'TAX_RATE_NOT_CONFIGURED: La empresa % no tiene configurada una tasa de impuesto (tax_rate). Configure el impuesto en la empresa antes de generar facturas.', v_company.id
      USING ERRCODE = 'P0001';
  END IF;
  v_tax_rate := v_tax_rate / 100.0;

  FOR v_i IN 0..(v_total_invoices - 1) LOOP
    SELECT * INTO v_billing_period
    FROM calculate_billing_period(
      v_item_start, v_i, v_period_months, v_method
    );

    v_period_start := v_billing_period.period_start;
    v_period_end := v_billing_period.period_end;
    v_scheduled_date := v_billing_period.scheduled_date;

    IF v_period_start > v_item_end THEN
      EXIT;
    END IF;

    v_subtotal := v_amount_per_period;
    v_tax_amount := v_subtotal * v_tax_rate;
    v_total := v_subtotal + v_tax_amount;

    INSERT INTO public.invoices(
      holding_id, contract_id, company_id, client_id, client_entity_id,
      scheduled_at, original_issue_date, issue_date, due_date, status,
      contract_currency, invoice_currency, amount_contract_currency,
      amount_invoice_currency, vat, total_invoice_currency,
      fx_contract_to_invoice, invoice_type, issuer_tax_id,
      issuer_legal_name, recipient_tax_id, recipient_legal_name
    ) VALUES (
      v_holding, v_contract.id, v_company.id, v_client.id, v_entity.id,
      v_scheduled_date, v_scheduled_date, NULL, v_scheduled_date + INTERVAL '30 days', 'Programada',
      v_item.currency, v_item.currency, v_subtotal,
      v_subtotal, v_tax_amount, v_total,
      1.0, 'Factura', v_company.tax_id,
      v_company.legal_name, v_entity.tax_id, v_entity.legal_name
    )
    RETURNING id INTO v_new_invoice_id;

    INSERT INTO public.invoice_items(
      holding_id, invoice_id, contract_item_id, product_id,
      description, quantity, unit_of_measure,
      contract_currency, invoice_currency,
      unit_price_contract_currency, unit_price_invoice_currency,
      subtotal_contract_currency, subtotal_invoice_currency,
      tax_amount_contract_currency, tax_amount_invoice_currency,
      total_contract_currency, total_invoice_currency,
      billing_period_start, billing_period_end
    ) VALUES (
      v_holding, v_new_invoice_id, v_item.id, v_item.product_id,
      v_item.product_name, 1, 'servicio',
      v_item.currency, v_item.currency,
      v_subtotal, v_subtotal,
      v_subtotal, v_subtotal,
      v_tax_amount, v_tax_amount,
      v_total, v_total,
      v_period_start, v_period_end
    );

    v_invoice_count := v_invoice_count + 1;
    v_created_invoices := v_created_invoices || jsonb_build_object(
      'id', v_new_invoice_id,
      'scheduled_at', v_scheduled_date,
      'period_start', v_period_start,
      'period_end', v_period_end,
      'amount', v_total
    );
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'invoice_count', v_invoice_count,
    'invoices', v_created_invoices
  );
END;
$function$

