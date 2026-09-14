CREATE OR REPLACE FUNCTION public.bulk_emit_invoices_with_scheduled_dates(p_invoice_ids uuid[])
 RETURNS TABLE(invoice_id uuid, success boolean, message text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_invoice_id UUID;
  v_result RECORD;
  v_scheduled_date DATE;
BEGIN
  FOREACH v_invoice_id IN ARRAY p_invoice_ids
  LOOP
    -- Para cada factura, usar su fecha programada (scheduled_at) como fecha de emisión
    SELECT i.scheduled_at INTO v_scheduled_date FROM public.invoices i WHERE i.id = v_invoice_id;
    
    -- Llamar a emit_invoice_safe con la fecha programada de cada factura
    SELECT * INTO v_result FROM public.emit_invoice_safe(v_invoice_id, v_scheduled_date);
    RETURN QUERY SELECT v_invoice_id, v_result.success, v_result.message;
  END LOOP;
END;
$function$

