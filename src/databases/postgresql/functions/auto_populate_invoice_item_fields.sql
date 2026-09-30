CREATE OR REPLACE FUNCTION public.auto_populate_invoice_item_fields()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_invoice_record RECORD;
  v_contract_item_record RECORD;
BEGIN
  -- Costura sapira.writer: en una transacción de la API (v2) este trigger no hace nada; la API escribe cada campo.
  -- El front viejo nunca fija la marca: para él el trigger sigue igual. Regla: docs/reglas-desarrollo/logica-en-api-triggers.md
  IF current_setting('sapira.writer', true) = 'api' THEN
    RETURN NEW;
  END IF;

  -- Obtener datos de la factura
  SELECT contract_id, status, issue_date
  INTO v_invoice_record
  FROM public.invoices
  WHERE id = NEW.invoice_id;
  
  -- Auto-poblar desde invoice
  NEW.contract_id := v_invoice_record.contract_id;
  NEW.status := v_invoice_record.status;
  NEW.issue_date := v_invoice_record.issue_date;
  
  -- Si hay contract_item_id, obtener product_id y currency
  IF NEW.contract_item_id IS NOT NULL THEN
    SELECT product_id, currency
    INTO v_contract_item_record
    FROM public.contract_items
    WHERE id = NEW.contract_item_id;
    
    IF FOUND THEN
      NEW.product_id := v_contract_item_record.product_id;
      -- CORREGIDO: Usar contract_currency e invoice_currency en lugar de currency
      NEW.contract_currency := v_contract_item_record.currency;
      NEW.invoice_currency := COALESCE(NEW.invoice_currency, v_contract_item_record.currency);
    END IF;
  END IF;
  
  RETURN NEW;
END;
$function$

