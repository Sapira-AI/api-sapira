CREATE OR REPLACE FUNCTION public.get_commercial_clients_by_tax_id(p_tax_id text, p_holding_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(client_id uuid, client_name text, entity_id uuid, entity_legal_name text, tax_id text, country text, is_primary boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_holding_id uuid;
BEGIN
  -- Si no se proporciona holding_id, obtener el del usuario actual
  IF p_holding_id IS NULL THEN
    SELECT get_current_user_holding_id() INTO v_holding_id;
  ELSE
    v_holding_id := p_holding_id;
  END IF;
  
  IF v_holding_id IS NULL THEN
    RAISE EXCEPTION 'No se pudo obtener el holding del usuario';
  END IF;

  RETURN QUERY
  SELECT 
    c.id as client_id,
    c.name_commercial as client_name,
    ce.id as entity_id,
    ce.legal_name as entity_legal_name,
    ce.tax_id,
    ce.country,
    cec.is_primary
  FROM client_entities ce
  INNER JOIN client_entity_clients cec ON cec.client_entity_id = ce.id
  INNER JOIN clients c ON c.id = cec.client_id
  WHERE ce.tax_id = p_tax_id
    AND ce.holding_id = v_holding_id
    AND c.holding_id = v_holding_id
  ORDER BY cec.is_primary DESC, c.name_commercial;
END;
$function$

