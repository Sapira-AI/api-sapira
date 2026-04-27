CREATE OR REPLACE FUNCTION public.after_invoice_payment_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF TG_OP = 'INSERT' OR TG_OP = 'UPDATE' THEN
    PERFORM public.recalc_invoice_status(NEW.invoice_id);
  ELSIF TG_OP = 'DELETE' THEN
    PERFORM public.recalc_invoice_status(OLD.invoice_id);
  END IF;
  RETURN NULL;
END;
$function$

