CREATE OR REPLACE FUNCTION public.consolidate_invoices_simple(p_contract_id uuid, p_invoice_ids uuid[], p_notes text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_holding_id uuid;
  v_invoice_count int;
  v_first_invoice RECORD;
  v_period_start date;
  v_period_end date;
  v_total_subtotal numeric := 0;
  v_total_vat numeric := 0;
  v_total_amount numeric := 0;
  v_currency text;
  v_contract_currency text;
  v_total_subtotal_ctr numeric := 0;
  v_invoice_amounts_null boolean;
  v_consolidated_invoice_id uuid;
  v_same_group_id uuid;
  v_earliest_scheduled_date date;
  v_latest_due_date date;
  v_src RECORD;
  v_new_item_id uuid;
BEGIN
  -- Validar que se proporcionen al menos 2 facturas
  IF array_length(p_invoice_ids, 1) < 2 THEN
    RAISE EXCEPTION 'Se requieren al menos 2 facturas para consolidar';
  END IF;

  -- Obtener holding_id del contrato
  SELECT holding_id INTO v_holding_id
  FROM contracts
  WHERE id = p_contract_id;

  IF v_holding_id IS NULL THEN
    RAISE EXCEPTION 'Contrato no encontrado';
  END IF;

  -- Obtener información de la primera factura
  SELECT * INTO v_first_invoice
  FROM invoices
  WHERE id = p_invoice_ids[1];

  IF v_first_invoice IS NULL THEN
    RAISE EXCEPTION 'Factura no encontrada';
  END IF;

  v_invoice_count := array_length(p_invoice_ids, 1);

  -- Normalizar período al primer día del mes
  v_period_start := date_trunc('month', v_first_invoice.scheduled_at)::date;
  v_period_end := (date_trunc('month', v_first_invoice.scheduled_at) + interval '1 month - 1 day')::date;

  -- Validaciones críticas (solo se consolidan facturas en estado 'Por Emitir')
  IF EXISTS (
    SELECT 1 FROM invoices
    WHERE id = ANY(p_invoice_ids)
    AND (
      contract_id != p_contract_id
      OR date_trunc('month', scheduled_at) != date_trunc('month', v_first_invoice.scheduled_at)
      OR is_active = false
      OR consolidated_into_invoice_id IS NOT NULL
      OR status <> 'Por Emitir'
    )
  ) THEN
    RAISE EXCEPTION 'Una o más facturas no cumplen los criterios: mismo contrato, mismo mes, activas, no consolidadas, en estado Por Emitir';
  END IF;

  -- Fechas y monedas desde las facturas
  SELECT
    MIN(scheduled_at),
    MAX(due_date),
    MAX(invoice_currency),
    MAX(contract_currency)
  INTO v_earliest_scheduled_date, v_latest_due_date, v_currency, v_contract_currency
  FROM invoices
  WHERE id = ANY(p_invoice_ids);

  -- Totales del header derivados de los ITEMS que se copiaran 1:1
  -- (suma exacta de las lineas; en spot los montos en moneda factura quedan NULL)
  SELECT
    COALESCE(SUM(subtotal_contract_currency), 0),
    COALESCE(SUM(subtotal_invoice_currency), 0),
    COALESCE(SUM(tax_amount_invoice_currency), 0),
    COALESCE(SUM(total_invoice_currency), 0),
    bool_and(subtotal_invoice_currency IS NULL)
  INTO v_total_subtotal_ctr, v_total_subtotal, v_total_vat, v_total_amount, v_invoice_amounts_null
  FROM invoice_items
  WHERE invoice_id = ANY(p_invoice_ids);

  -- Generar un nuevo invoice_group_id para la consolidación
  v_same_group_id := gen_random_uuid();

  -- Crear factura consolidada con fechas correctas (incluyendo issue_date)
  INSERT INTO invoices(
    holding_id,
    contract_id,
    company_id,
    client_id,
    client_entity_id,
    scheduled_at,
    issue_date,
    due_date,
    original_issue_date,
    contract_currency,
    invoice_currency,
    amount_contract_currency,
    amount_invoice_currency,
    vat,
    total_invoice_currency,
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
    consolidated_into_invoice_id
  )
  SELECT
    v_holding_id,
    p_contract_id,
    v_first_invoice.company_id,
    v_first_invoice.client_id,
    v_first_invoice.client_entity_id,
    v_earliest_scheduled_date,
    v_earliest_scheduled_date,
    v_latest_due_date,
    v_earliest_scheduled_date,
    v_contract_currency,
    v_currency,
    v_total_subtotal_ctr,
    CASE WHEN v_invoice_amounts_null THEN NULL ELSE v_total_subtotal END,
    CASE WHEN v_invoice_amounts_null THEN NULL ELSE v_total_vat END,
    CASE WHEN v_invoice_amounts_null THEN NULL ELSE v_total_amount END,
    CASE
      WHEN v_total_subtotal_ctr = 0 THEN 'Cancelada'
      ELSE 'Por Emitir'
    END,
    CASE
      WHEN v_total_subtotal_ctr < 0 THEN 'NC'
      ELSE 'FACTURA'
    END,
    'Consolidada',
    v_same_group_id,
    v_first_invoice.issuer_tax_id,
    v_first_invoice.issuer_legal_name,
    v_first_invoice.issuer_address,
    v_first_invoice.client_tax_id,
    v_first_invoice.payment_method,
    v_first_invoice.fiscal_regime,
    v_first_invoice.export_type,
    true,
    NULL
  RETURNING id INTO v_consolidated_invoice_id;

  -- Copiar los items de las facturas originales 1:1 (sin agrupar ni totalizar):
  -- cada linea conserva su periodo, cantidad, montos, FX, descuento y override.
  -- standardize_invoice_items() pisa los montos en el INSERT cuando hay contract_item_id;
  -- por eso se restauran con un UPDATE inmediato (el trigger no actua en UPDATE).
  FOR v_src IN
    SELECT *
    FROM invoice_items
    WHERE invoice_id = ANY(p_invoice_ids)
    ORDER BY billing_period_start NULLS LAST, created_at
  LOOP
    INSERT INTO invoice_items(
      invoice_id,
      holding_id,
      contract_item_id,
      product_id,
      description,
      quantity,
      unit_of_measure,
      discount_pct,
      tax_code,
      odoo_tax_id,
      custom_fields,
      subscription_item_id,
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
      billing_period_start,
      billing_period_end
    )
    VALUES (
      v_consolidated_invoice_id,
      v_holding_id,
      v_src.contract_item_id,
      v_src.product_id,
      v_src.description,
      v_src.quantity,
      v_src.unit_of_measure,
      v_src.discount_pct,
      v_src.tax_code,
      v_src.odoo_tax_id,
      v_src.custom_fields,
      v_src.subscription_item_id,
      v_src.unit_price_contract_currency,
      v_src.unit_price_invoice_currency,
      v_src.subtotal_contract_currency,
      v_src.subtotal_invoice_currency,
      v_src.tax_amount_contract_currency,
      v_src.tax_amount_invoice_currency,
      v_src.total_contract_currency,
      v_src.total_invoice_currency,
      v_src.contract_currency,
      v_src.invoice_currency,
      v_src.fx_contract_to_invoice,
      v_src.fx_rate_source,
      v_src.fx_rate_date,
      v_src.billing_period_start,
      v_src.billing_period_end
    )
    RETURNING id INTO v_new_item_id;

    -- Restaurar los montos/monedas que standardize_invoice_items() / auto_populate
    -- pudieron pisar en el INSERT (solo cuando hay contract_item_id).
    IF v_src.contract_item_id IS NOT NULL THEN
      UPDATE invoice_items SET
        quantity                     = v_src.quantity,
        unit_of_measure              = v_src.unit_of_measure,
        unit_price_contract_currency = v_src.unit_price_contract_currency,
        unit_price_invoice_currency  = v_src.unit_price_invoice_currency,
        subtotal_contract_currency   = v_src.subtotal_contract_currency,
        subtotal_invoice_currency    = v_src.subtotal_invoice_currency,
        tax_amount_contract_currency = v_src.tax_amount_contract_currency,
        tax_amount_invoice_currency  = v_src.tax_amount_invoice_currency,
        total_contract_currency      = v_src.total_contract_currency,
        total_invoice_currency       = v_src.total_invoice_currency,
        contract_currency            = v_src.contract_currency,
        invoice_currency             = v_src.invoice_currency
      WHERE id = v_new_item_id;
    END IF;
  END LOOP;

  -- Marcar facturas originales como inactivas y consolidadas
  UPDATE invoices
  SET
    is_active = false,
    consolidated_into_invoice_id = v_consolidated_invoice_id
  WHERE id = ANY(p_invoice_ids);

  -- Retornar resultado
  RETURN jsonb_build_object(
    'success', true,
    'consolidated_invoice_id', v_consolidated_invoice_id,
    'original_invoice_count', v_invoice_count,
    'total_amount', v_total_amount,
    'scheduled_at', v_earliest_scheduled_date,
    'due_date', v_latest_due_date
  );

EXCEPTION
  WHEN OTHERS THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', SQLERRM
    );
END;
$function$

