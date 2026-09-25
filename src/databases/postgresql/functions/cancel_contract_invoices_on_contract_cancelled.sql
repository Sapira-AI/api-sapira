CREATE OR REPLACE FUNCTION public.cancel_contract_invoices_on_contract_cancelled()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Doble guard (además del WHEN del trigger): solo al transicionar a Cancelado.
  IF NEW.status = 'Cancelado' AND COALESCE(OLD.status, '') IS DISTINCT FROM 'Cancelado' THEN
    UPDATE public.contract_invoices ci
    SET status     = 'Cancelada',
        updated_at = now()
    WHERE ci.contract_id = NEW.id
      AND ci.holding_id  = NEW.holding_id
      AND COALESCE(ci.is_satisfied, false) = false
      AND ci.status IN ('Programada', 'pending')
      AND ci.invoice_date >= COALESCE(NEW.churn_date, CURRENT_DATE);
  END IF;
  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public."cancel_contract_invoices_on_contract_cancelled"() IS 'Cancela las contract_invoices (cronograma) futuras no satisfechas cuando un contrato pasa a Cancelado (churn o manual). Fix bug "churn deja facturas Programada". Ver feature_bug_churn_scheduled_invoices.';
