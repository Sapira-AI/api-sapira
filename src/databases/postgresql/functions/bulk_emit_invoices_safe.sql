CREATE OR REPLACE FUNCTION public.bulk_emit_invoices_safe(p_invoice_ids uuid[], p_issue_date date)
 RETURNS TABLE(invoice_id uuid, success boolean, message text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_invoice_id UUID;
  v_result RECORD;
BEGIN
  FOREACH v_invoice_id IN ARRAY p_invoice_ids
  LOOP
    SELECT * INTO v_result FROM public.emit_invoice_safe(v_invoice_id, p_issue_date);
    RETURN QUERY SELECT v_invoice_id, v_result.success, v_result.message;
  END LOOP;
END;
$function$

