CREATE OR REPLACE FUNCTION public.sync_invoice_item_contract_id()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_invoice RECORD;
  v_contract_item_id UUID;
BEGIN
  -- Solo proceder si contract_item_id está vacío
  IF NEW.contract_item_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  -- Obtener información de la factura
  SELECT contract_id INTO v_invoice
  FROM invoices
  WHERE id = NEW.invoice_id;

  -- Si la factura no tiene contrato asociado, no hacer nada
  IF v_invoice.contract_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Intentar encontrar el contract_item_id correspondiente
  -- Buscando en contract_invoices por la descripción del item
  SELECT DISTINCT 
    (jsonb_array_elements(contract_item_details)->>'contract_item_id')::UUID
  INTO v_contract_item_id
  FROM contract_invoices
  WHERE contract_id = v_invoice.contract_id
  AND contract_item_details @> jsonb_build_array(
    jsonb_build_object('product_name', NEW.description)
  )
  LIMIT 1;

  -- Si encontramos el contract_item_id, asignarlo
  IF v_contract_item_id IS NOT NULL THEN
    NEW.contract_item_id := v_contract_item_id;
  END IF;

  RETURN NEW;
END;
$function$
