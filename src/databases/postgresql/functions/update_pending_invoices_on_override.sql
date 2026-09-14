CREATE OR REPLACE FUNCTION public.update_pending_invoices_on_override(p_contract_item_id uuid, p_period_month date)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_contract_id uuid;
  v_item_data RECORD;
  v_override RECORD;
  v_invoice RECORD;
  v_new_amount numeric;
  v_effective_unit_price numeric;
  v_effective_quantity numeric;
  v_effective_unit_measure text;
BEGIN
  -- Obtener datos del item
  SELECT contract_id, unit_price, quantity, unit_of_measure, final_price, term_months
  INTO v_item_data
  FROM contract_items
  WHERE id = p_contract_item_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Contract item % not found', p_contract_item_id;
  END IF;

  -- Buscar override para este período
  SELECT unit_price, quantity, unit_of_measure
  INTO v_override
  FROM quantities
  WHERE contract_item_id = p_contract_item_id
    AND period = p_period_month;

  -- Determinar valores efectivos
  v_effective_unit_price := COALESCE(v_override.unit_price, v_item_data.unit_price, v_item_data.final_price / NULLIF(v_item_data.term_months, 0));
  v_effective_quantity := COALESCE(v_override.quantity, v_item_data.quantity, 1);
  v_effective_unit_measure := COALESCE(v_override.unit_of_measure, v_item_data.unit_of_measure, 'UND');

  -- Calcular nuevo monto
  v_new_amount := v_effective_unit_price * v_effective_quantity;

  RAISE NOTICE 'Actualizando facturas Por Emitir para item % período %: unit_price=%, quantity=%, amount=%',
    p_contract_item_id, p_period_month, v_effective_unit_price, v_effective_quantity, v_new_amount;

  -- Actualizar invoice_items de facturas "Por Emitir" que incluyan este item + período
  FOR v_invoice IN
    SELECT i.id as invoice_id, ii.id as item_id, ii.tax_rate
    FROM invoices i
    INNER JOIN invoice_items ii ON ii.invoice_id = i.id
    WHERE i.contract_id = v_item_data.contract_id
      AND i.status = 'Por Emitir'
      AND ii.contract_item_id = p_contract_item_id
      AND DATE_TRUNC('month', i.issue_date)::date = p_period_month
  LOOP
    UPDATE invoice_items
    SET 
      unit_price = v_effective_unit_price,
      quantity = v_effective_quantity,
      subtotal = v_new_amount,
      total = v_new_amount * (1 + COALESCE(v_invoice.tax_rate, 0)),
      updated_at = now()
    WHERE id = v_invoice.item_id;

    -- Recalcular totales de la factura
    UPDATE invoices
    SET 
      amount_net = (SELECT SUM(subtotal) FROM invoice_items WHERE invoice_id = v_invoice.invoice_id),
      total_invoice_currency = (SELECT SUM(total) FROM invoice_items WHERE invoice_id = v_invoice.invoice_id),
      updated_at = now()
    WHERE id = v_invoice.invoice_id;

    RAISE NOTICE '✅ Factura % actualizada por override de item %', v_invoice.invoice_id, p_contract_item_id;
  END LOOP;

  IF NOT FOUND THEN
    RAISE NOTICE '⏭️ No se encontraron facturas Por Emitir para actualizar';
  END IF;
END;
$function$

