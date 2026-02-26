CREATE OR REPLACE FUNCTION public.refresh_revenue_schedule_for_invoice_contract()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE 
  v_contract_id uuid; 
  v_invoice_id uuid;
  v_contract_status text;
BEGIN
  IF TG_TABLE_NAME = 'invoice_items' THEN 
    v_invoice_id := COALESCE(NEW.invoice_id, OLD.invoice_id);
  ELSIF TG_TABLE_NAME = 'invoices' THEN 
    v_invoice_id := COALESCE(NEW.id, OLD.id); 
  END IF;

  IF v_invoice_id IS NOT NULL THEN
    SELECT i.contract_id, c.status INTO v_contract_id, v_contract_status
    FROM invoices i
    LEFT JOIN contracts c ON c.id = i.contract_id
    WHERE i.id = v_invoice_id;

    IF v_contract_id IS NOT NULL AND v_contract_status = 'Activo' THEN
      PERFORM revenue_schedule_rebuild(v_contract_id);
    END IF;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$function$
