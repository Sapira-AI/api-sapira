CREATE OR REPLACE FUNCTION public.update_invoice_legacy_status_on_mrr_creation()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
BEGIN
  -- Actualizar la factura legacy a 'mrr_legacy' cuando se crea un registro MRR
  UPDATE public.invoices_legacy
  SET reconciliation_status = 'mrr_legacy'
  WHERE id = NEW.invoice_legacy_id
    AND reconciliation_status = 'pending';
  
  RETURN NEW;
END;
$function$

