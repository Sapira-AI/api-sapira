CREATE OR REPLACE FUNCTION public.update_invoice_legacy_status()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_invoice_legacy_id UUID;
  v_total_invoice NUMERIC;
  v_total_matched NUMERIC;
  v_total_confirmed NUMERIC;
  v_lines_count INT;
  v_lines_with_match INT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT invoices_legacy_id INTO v_invoice_legacy_id
    FROM invoice_items_legacy
    WHERE id = OLD.invoice_item_legacy_id;
  ELSE
    SELECT invoices_legacy_id INTO v_invoice_legacy_id
    FROM invoice_items_legacy
    WHERE id = NEW.invoice_item_legacy_id;
  END IF;

  SELECT 
    il.total_invoice_currency,
    COUNT(DISTINCT iil.id),
    COUNT(DISTINCT CASE WHEN EXISTS (
      SELECT 1 FROM invoice_items_legacy_match m 
      WHERE m.invoice_item_legacy_id = iil.id
    ) THEN iil.id END)
  INTO v_total_invoice, v_lines_count, v_lines_with_match
  FROM invoices_legacy il
  LEFT JOIN invoice_items_legacy iil ON iil.invoices_legacy_id = il.id
  WHERE il.id = v_invoice_legacy_id
  GROUP BY il.id, il.total_invoice_currency;

  SELECT 
    COALESCE(SUM(m.amount_invoice_currency), 0),
    COALESCE(SUM(CASE WHEN m.status = 'confirmed' THEN m.amount_invoice_currency ELSE 0 END), 0)
  INTO v_total_matched, v_total_confirmed
  FROM invoice_items_legacy_match m
  JOIN invoice_items_legacy iil ON iil.id = m.invoice_item_legacy_id
  WHERE iil.invoices_legacy_id = v_invoice_legacy_id;

  -- CAMBIO: Actualizar reconciliation_status en lugar de status
  UPDATE invoices_legacy
  SET reconciliation_status = CASE
    WHEN v_total_confirmed >= v_total_invoice * 0.99 THEN 'reconciled'
    WHEN v_total_matched > 0 OR v_lines_with_match > 0 THEN 'partially_reconciled'
    ELSE 'pending'
  END
  WHERE id = v_invoice_legacy_id;

  RETURN COALESCE(NEW, OLD);
END;
$function$

