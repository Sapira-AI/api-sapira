CREATE OR REPLACE FUNCTION public.calculate_contract_item_categoria(p_contract_id uuid, p_client_id uuid, p_product_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$DECLARE
  v_client_contracts_count INT;
  v_product_exists_in_previous_contracts BOOLEAN;
  v_current_contract_created_at TIMESTAMPTZ;
BEGIN
  -- Obtener fecha de creación del contrato actual
  SELECT created_at INTO v_current_contract_created_at
  FROM contracts
  WHERE id = p_contract_id;
  
  -- Contar contratos anteriores del mismo cliente (creados antes que el actual)
  SELECT COUNT(*) 
  INTO v_client_contracts_count
  FROM contracts
  WHERE client_id = p_client_id
    AND id != p_contract_id
    AND created_at < v_current_contract_created_at;
  
  -- Si es el primer contrato → NEW
  IF v_client_contracts_count = 0 THEN
    RETURN 'NEW';
  END IF;
  
  -- Si no es el primer contrato, verificar si el producto ya existía
  SELECT EXISTS(
    SELECT 1
    FROM contract_items ci
    JOIN contracts c ON ci.contract_id = c.id
    WHERE c.client_id = p_client_id
      AND c.id != p_contract_id
      AND c.created_at < v_current_contract_created_at
      AND ci.product_id = p_product_id
  ) INTO v_product_exists_in_previous_contracts;
  
  -- Si el producto ya existía → UPSELL
  -- Si el producto es nuevo → CROSS-SELL
  IF v_product_exists_in_previous_contracts THEN
    RETURN 'UPSELL';
  ELSE
    RETURN 'CROSS-SELL';
  END IF;
END;$function$;

COMMENT ON FUNCTION public."calculate_contract_item_categoria"(p_contract_id uuid, p_client_id uuid, p_product_id uuid) IS 'Calcula la categoría automática de un item de contrato basándose en historial del cliente y producto';
