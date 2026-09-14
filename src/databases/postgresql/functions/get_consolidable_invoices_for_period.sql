CREATE OR REPLACE FUNCTION public.get_consolidable_invoices_for_period(p_contract_id uuid, p_period date)
 RETURNS TABLE(invoice_id uuid, invoice_number text, scheduled_at date, amount numeric, currency text, status text, document_type text, can_consolidate boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_period_start date;
  v_period_end date;
BEGIN
  -- Normalizar período
  v_period_start := date_trunc('month', p_period)::date;
  v_period_end := (date_trunc('month', p_period) + interval '1 month - 1 day')::date;
  
  RETURN QUERY
  SELECT 
    i.id,
    i.invoice_number,
    i.scheduled_at,
    i.total_invoice_currency,
    i.invoice_currency,
    i.status,
    i.document_type,
    (
      i.is_active = true
      AND i.consolidated_into_invoice_id IS NULL
      AND i.invoice_type != 'Consolidada'
      AND i.status IN ('Por Emitir', 'Emitida')
    ) as can_consolidate
  FROM invoices i
  WHERE i.contract_id = p_contract_id
    AND i.scheduled_at >= v_period_start
    AND i.scheduled_at <= v_period_end
  ORDER BY i.scheduled_at, i.created_at;
END;
$function$

