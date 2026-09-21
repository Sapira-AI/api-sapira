CREATE OR REPLACE FUNCTION public.recalculate_invoice_totals(p_invoice_id uuid)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_subtotal_contract numeric;
  v_subtotal_invoice numeric;
  v_vat_contract numeric;
  v_vat_invoice numeric;
  v_total_contract numeric;
  v_total_invoice numeric;
BEGIN
  -- Sumar desde invoice_items
  SELECT 
    COALESCE(SUM(subtotal_contract_currency), 0),
    COALESCE(SUM(subtotal_invoice_currency), 0),
    COALESCE(SUM(tax_amount_contract_currency), 0),
    COALESCE(SUM(tax_amount_invoice_currency), 0),
    COALESCE(SUM(total_contract_currency), 0),
    COALESCE(SUM(total_invoice_currency), 0)
  INTO
    v_subtotal_contract,
    v_subtotal_invoice,
    v_vat_contract,
    v_vat_invoice,
    v_total_contract,
    v_total_invoice
  FROM public.invoice_items
  WHERE invoice_id = p_invoice_id;
  
  -- Actualizar invoice
  UPDATE public.invoices
  SET 
    amount_contract_currency = v_subtotal_contract,
    amount_invoice_currency = v_subtotal_invoice,
    vat = v_vat_invoice,
    total_invoice_currency = v_total_invoice
  WHERE id = p_invoice_id;
END;
$function$

