CREATE OR REPLACE FUNCTION public.sync_invoice_items_on_invoice_update()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Si cambió el status o issue_date, actualizar todos los items
  IF (OLD.status IS DISTINCT FROM NEW.status) 
     OR (OLD.issue_date IS DISTINCT FROM NEW.issue_date) THEN
    
    UPDATE public.invoice_items
    SET 
      status = NEW.status,
      issue_date = NEW.issue_date,
      updated_at = now()
    WHERE invoice_id = NEW.id;
    
    RAISE NOTICE 'Sincronizados invoice_items para invoice %: status=%, issue_date=%', 
                 NEW.id, NEW.status, NEW.issue_date;
  END IF;
  
  RETURN NEW;
END;
$function$
