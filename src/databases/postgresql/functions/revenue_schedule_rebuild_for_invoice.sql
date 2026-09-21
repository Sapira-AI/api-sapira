CREATE OR REPLACE FUNCTION public.revenue_schedule_rebuild_for_invoice(p_invoice_id uuid)
 RETURNS TABLE(success boolean, message text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_invoice_record RECORD;
  v_rebuild_result RECORD;
BEGIN
  -- Get invoice details
  SELECT i.contract_id, i.issue_date
  INTO v_invoice_record
  FROM invoices i
  WHERE i.id = p_invoice_id
    AND i.holding_id = get_current_user_holding_id();
  
  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 'Invoice not found or access denied';
    RETURN;
  END IF;
  
  -- Rebuild from the invoice month onwards
  SELECT * INTO v_rebuild_result
  FROM revenue_schedule_rebuild(
    v_invoice_record.contract_id, 
    date_trunc('month', v_invoice_record.issue_date)
  );
  
  RETURN QUERY SELECT v_rebuild_result.success, v_rebuild_result.message;
END;
$function$

