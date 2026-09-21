CREATE OR REPLACE FUNCTION public.manual_check_overdue_invoices()
 RETURNS TABLE(invoices_updated integer, invoice_ids uuid[])
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_updated_count INTEGER;
  v_updated_ids UUID[];
BEGIN
  -- Actualizar facturas vencidas (las NC nunca vencen: su ciclo es Emitida/Cancelada)
  WITH updated AS (
    UPDATE public.invoices
    SET status = 'Vencida'
    WHERE due_date < CURRENT_DATE
      AND status IN ('Enviada', 'Emitida')
      AND COALESCE(document_type, 'FACTURA') <> 'NC'
    RETURNING id
  )
  SELECT
    COUNT(*)::INTEGER,
    ARRAY_AGG(id)
  INTO v_updated_count, v_updated_ids
  FROM updated;

  -- Retornar resultado
  RETURN QUERY SELECT v_updated_count, v_updated_ids;
END;
$function$

