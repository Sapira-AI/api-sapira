CREATE OR REPLACE FUNCTION public._recalc_invoice_header_from_items(p_invoice_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_sub_ctr numeric; v_sub_inv numeric; v_tax_ctr numeric; v_tax_inv numeric;
BEGIN
  SELECT COALESCE(SUM(subtotal_contract_currency),0), COALESCE(SUM(subtotal_invoice_currency),0),
         COALESCE(SUM(tax_amount_contract_currency),0), COALESCE(SUM(tax_amount_invoice_currency),0)
  INTO v_sub_ctr, v_sub_inv, v_tax_ctr, v_tax_inv
  FROM public.invoice_items WHERE invoice_id = p_invoice_id;

  UPDATE public.invoices SET
    amount_contract_currency = v_sub_ctr,
    amount_invoice_currency  = v_sub_inv,
    vat                      = v_tax_ctr,
    total_invoice_currency   = v_sub_inv + v_tax_inv
  WHERE id = p_invoice_id;
END;
$function$

