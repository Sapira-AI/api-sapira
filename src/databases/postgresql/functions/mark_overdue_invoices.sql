CREATE OR REPLACE FUNCTION public.mark_overdue_invoices()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_updated integer := 0;
BEGIN
  WITH updated AS (
    UPDATE public.invoices i
    SET status = 'Vencida'
    WHERE i.status IN ('Enviada')
      AND COALESCE(i.document_type, 'FACTURA') <> 'NC'
      AND i.due_date IS NOT NULL
      AND i.due_date < CURRENT_DATE
      AND COALESCE((
        SELECT SUM(p.amount)
        FROM public.invoice_payments p
        WHERE p.invoice_id = i.id AND p.confirmed = true
      ), 0) < COALESCE(i.total_invoice_currency, i.amount_invoice_currency, 0)
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_updated FROM updated;

  RETURN v_updated;
END;
$function$

