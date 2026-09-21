CREATE OR REPLACE FUNCTION public.cancel_invoice_with_credit_note(p_invoice_id uuid, p_credit_note_data jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_invoice RECORD;
  v_credit_note_id uuid;
  v_holding_id uuid;
  v_user_id uuid;
  v_reason text;
  v_notes text;
BEGIN
  -- Obtener factura
  SELECT * INTO v_invoice
  FROM invoices
  WHERE id = p_invoice_id
    AND is_active = true;
  
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Factura no encontrada o no está activa';
  END IF;
  
  v_holding_id := v_invoice.holding_id;
  SELECT get_current_user_id() INTO v_user_id;
  
  v_reason := p_credit_note_data->>'reason';
  v_notes := p_credit_note_data->>'notes';
  
  -- Crear nota de crédito
  INSERT INTO invoices(
    holding_id,
    contract_id,
    company_id,
    client_id,
    client_entity_id,
    scheduled_at,
    original_issue_date,
    issue_date,
    contract_currency,
    invoice_currency,
    amount_contract_currency,
    amount_invoice_currency,
    amount_net,
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
    notes
  )
  SELECT
    v_holding_id,
    v_invoice.contract_id,
    v_invoice.company_id,
    v_invoice.client_id,
    v_invoice.client_entity_id,
    CURRENT_DATE,
    CURRENT_DATE,
    CURRENT_DATE,
    v_invoice.contract_currency,
    v_invoice.invoice_currency,
    -v_invoice.amount_contract_currency,
    -v_invoice.amount_invoice_currency,
    -v_invoice.amount_net,
    -v_invoice.vat,
    -v_invoice.total_invoice_currency,
    v_invoice.fx_contract_to_invoice,
    'Por Emitir',
    'NC',
    'Nota de Crédito',
    v_invoice.invoice_group_id,
    v_invoice.issuer_tax_id,
    v_invoice.issuer_legal_name,
    v_invoice.issuer_address,
    v_invoice.client_tax_id,
    v_invoice.payment_method,
    v_invoice.fiscal_regime,
    v_invoice.export_type,
    true,
    format('NC por %s: %s', v_reason, v_notes)
  RETURNING id INTO v_credit_note_id;
  
  -- Copiar items (negativos)
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
    v_credit_note_id,
    ii.holding_id,
    ii.contract_item_id,
    ii.product_id,
    ii.description,
    -ii.quantity,
    ii.unit_of_measure,
    ii.unit_price_contract_currency,
    ii.unit_price_invoice_currency,
    -ii.subtotal_contract_currency,
    -ii.subtotal_invoice_currency,
    -ii.tax_amount_contract_currency,
    -ii.tax_amount_invoice_currency,
    -ii.total_contract_currency,
    -ii.total_invoice_currency,
    ii.contract_currency,
    ii.invoice_currency,
    ii.billing_period_start,
    ii.billing_period_end
  FROM invoice_items ii
  WHERE ii.invoice_id = p_invoice_id;
  
  -- Marcar factura original como cancelada
  UPDATE invoices
  SET status = 'Cancelada'
  WHERE id = p_invoice_id;
  
  -- Registrar evento
  PERFORM log_lifecycle_event(
    v_invoice.contract_id,
    'INVOICE_CANCELLED_WITH_CREDIT_NOTE',
    'Factura Cancelada con Nota de Crédito',
    CURRENT_DATE,
    -v_invoice.total_invoice_currency,
    format('Factura cancelada por %s', v_reason),
    v_notes,
    jsonb_build_object(
      'cancelled_invoice_id', p_invoice_id,
      'credit_note_id', v_credit_note_id,
      'reason', v_reason,
      'amount', v_invoice.total_invoice_currency
    ),
    'invoice',
    'Completed'
  );
  
  RETURN jsonb_build_object(
    'success', true,
    'cancelled_invoice_id', p_invoice_id,
    'credit_note_id', v_credit_note_id,
    'amount', v_invoice.total_invoice_currency
  );
END;
$function$

