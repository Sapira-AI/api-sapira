CREATE OR REPLACE FUNCTION public.trg_set_contract_item_categoria()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_client_id UUID;
  v_calculated_categoria TEXT;
BEGIN
  -- Solo aplicar categorización automática si categoria es NULL o 'RECURRENT'
  IF NEW.categoria IS NOT NULL AND NEW.categoria != 'RECURRENT' THEN
    RETURN NEW;
  END IF;
  
  -- Obtener client_id del contrato
  SELECT client_id INTO v_client_id
  FROM contracts
  WHERE id = NEW.contract_id;
  
  -- Si no hay product_id, dejar como está
  IF NEW.product_id IS NULL THEN
    RETURN NEW;
  END IF;
  
  -- Calcular categoria inteligente
  v_calculated_categoria := calculate_contract_item_categoria(
    NEW.contract_id,
    v_client_id,
    NEW.product_id
  );
  
  NEW.categoria := v_calculated_categoria;
  RETURN NEW;
END;
$function$

