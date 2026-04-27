CREATE OR REPLACE FUNCTION public.set_invoice_payment_defaults()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_invoice RECORD;
BEGIN
  SELECT i.*
  INTO v_invoice
  FROM public.invoices i
  WHERE i.id = NEW.invoice_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice % not found', NEW.invoice_id;
  END IF;

  -- Completar holding_id si no viene
  IF NEW.holding_id IS NULL THEN
    NEW.holding_id := v_invoice.holding_id;
  END IF;

  -- Completar currency con la moneda de la factura si no viene
  IF NEW.currency IS NULL THEN
    NEW.currency := COALESCE(v_invoice.invoice_currency, v_invoice.contract_currency, 'USD');
  END IF;

  -- Registrar quién crea el pago (usuario interno)
  IF NEW.created_by IS NULL THEN
    NEW.created_by := get_current_user_id();
  END IF;

  RETURN NEW;
END;
$function$

