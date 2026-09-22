CREATE OR REPLACE FUNCTION public.get_clients_by_entity(p_entity_id uuid)
 RETURNS TABLE(client_id uuid, client_name text, client_segment text, client_industry text, is_primary boolean, assigned_at timestamp with time zone)
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
    c.id as client_id,
    c.name_commercial as client_name,
    c.segment as client_segment,
    c.industry as client_industry,
    cec.is_primary,
    cec.created_at as assigned_at
  FROM client_entity_clients cec
  JOIN clients c ON c.id = cec.client_id
  WHERE cec.client_entity_id = p_entity_id
    AND cec.holding_id = v_holding_id
  ORDER BY cec.is_primary DESC, c.name_commercial;
END;
$function$;

COMMENT ON FUNCTION public."get_clients_by_entity"(p_entity_id uuid) IS 'Obtiene todos los clientes comerciales asignados a una razón social, ordenados por primary primero.';
