CREATE OR REPLACE FUNCTION public.get_entities_by_client(p_client_id uuid)
 RETURNS TABLE(entity_id uuid, legal_name text, tax_id text, country text, is_primary boolean, assigned_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_holding_id uuid;
BEGIN
  -- Obtener holding del usuario actual
  SELECT get_current_user_holding_id() INTO v_holding_id;
  
  IF v_holding_id IS NULL THEN
    RAISE EXCEPTION 'No se pudo obtener el holding del usuario';
  END IF;

  RETURN QUERY
  SELECT 
    ce.id as entity_id,
    ce.legal_name,
    ce.tax_id,
    ce.country,
    cec.is_primary,
    cec.created_at as assigned_at
  FROM client_entity_clients cec
  JOIN client_entities ce ON ce.id = cec.client_entity_id
  WHERE cec.client_id = p_client_id
    AND cec.holding_id = v_holding_id
  ORDER BY cec.is_primary DESC, ce.legal_name;
END;
$function$;

COMMENT ON FUNCTION public."get_entities_by_client"(p_client_id uuid) IS 'Obtiene todas las razones sociales asignadas a un cliente comercial, ordenadas por primary primero.';
