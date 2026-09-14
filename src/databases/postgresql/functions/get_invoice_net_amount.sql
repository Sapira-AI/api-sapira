CREATE OR REPLACE FUNCTION public.get_invoice_net_amount(p_invoice_id uuid)
 RETURNS TABLE(subtotal_net numeric, vat_net numeric, total_net numeric, credit_notes_count integer)
 LANGUAGE plpgsql
 STABLE
AS $function$
DECLARE
  v_invoice RECORD;
  v_credit_notes_subtotal numeric := 0;
  v_credit_notes_vat numeric := 0;
  v_credit_notes_total numeric := 0;
  v_credit_notes_count int := 0;
BEGIN
  -- Obtener factura principal
  SELECT * INTO v_invoice
  FROM public.invoices
  WHERE id = p_invoice_id;
  
  IF NOT FOUND THEN
    RETURN;
  END IF;
  
  -- Sumar notas de crédito relacionadas (usar document_type en lugar de invoice_type)
  SELECT 
    COALESCE(SUM(amount_invoice_currency), 0),
    COALESCE(SUM(vat), 0),
    COALESCE(SUM(total_invoice_currency), 0),
    COUNT(*)
  INTO 
    v_credit_notes_subtotal,
    v_credit_notes_vat,
    v_credit_notes_total,
    v_credit_notes_count
  FROM public.invoices
  WHERE related_invoice_id = p_invoice_id
    AND document_type = 'NC'; -- Cambio: usar document_type
  
  -- Retornar montos netos (factura + notas de crédito que son negativas)
  RETURN QUERY SELECT
    v_invoice.amount_invoice_currency + v_credit_notes_subtotal,
    v_invoice.vat + v_credit_notes_vat,
    v_invoice.total_invoice_currency + v_credit_notes_total,
    v_credit_notes_count;
END;
$function$

