CREATE OR REPLACE FUNCTION public.validate_match_total()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_line_subtotal NUMERIC;
  v_matched_total NUMERIC;
BEGIN
  -- Obtener el SUBTOTAL (sin IVA) del item de factura
  SELECT subtotal INTO v_line_subtotal
  FROM invoice_items_legacy
  WHERE id = NEW.invoice_item_legacy_id;

  -- Calcular el total ya asignado a este item (excluyendo el registro actual si es UPDATE)
  SELECT COALESCE(SUM(amount_invoice_currency), 0)
  INTO v_matched_total
  FROM invoice_items_legacy_match
  WHERE invoice_item_legacy_id = NEW.invoice_item_legacy_id
    AND (TG_OP = 'INSERT' OR id != NEW.id);

  -- Validar que el total matched no exceda el subtotal del item (con 1% de tolerancia)
  IF (v_matched_total + NEW.amount_invoice_currency) > (v_line_subtotal * 1.01) THEN
    RAISE EXCEPTION 'Total matched (%) exceeds line subtotal (%)', 
      v_matched_total + NEW.amount_invoice_currency, v_line_subtotal;
  END IF;

  RETURN NEW;
END;
$function$

