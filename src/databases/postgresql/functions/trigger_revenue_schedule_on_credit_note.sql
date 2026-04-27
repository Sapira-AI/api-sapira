CREATE OR REPLACE FUNCTION public.trigger_revenue_schedule_on_credit_note()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_enabled boolean := false;
  v_invoice_record RECORD;
  v_contract_status text;
BEGIN
  SELECT revenue_schedule_monthly_enabled INTO v_enabled
  FROM financial_settings 
  WHERE holding_id = get_current_user_holding_id()
  LIMIT 1;
  
  IF NOT COALESCE(v_enabled, false) THEN
    RETURN NEW;
  END IF;
  
  SELECT i.contract_id, c.status INTO v_invoice_record.contract_id, v_contract_status
  FROM invoices i
  LEFT JOIN contracts c ON c.id = i.contract_id
  WHERE i.id = NEW.invoice_id;
  
  IF v_invoice_record.contract_id IS NOT NULL AND v_contract_status = 'Activo' THEN
    BEGIN
      PERFORM revenue_schedule_rebuild_for_invoice(NEW.invoice_id);
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'Revenue schedule rebuild failed for credit note on invoice %: %', NEW.invoice_id, SQLERRM;
    END;
  END IF;
  
  RETURN NEW;
END;
$function$

