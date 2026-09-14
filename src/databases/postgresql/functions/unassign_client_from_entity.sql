CREATE OR REPLACE FUNCTION public.unassign_client_from_entity(p_entity_id uuid, p_client_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_holding_id uuid;
  v_deleted boolean;
BEGIN
  -- Obtener holding del usuario actual
  SELECT get_current_user_holding_id() INTO v_holding_id;
  
  IF v_holding_id IS NULL THEN
    RAISE EXCEPTION 'No se pudo obtener el holding del usuario';
  END IF;

  -- Eliminar la relación
  DELETE FROM client_entity_clients
  WHERE client_entity_id = p_entity_id
    AND client_id = p_client_id
    AND holding_id = v_holding_id
  RETURNING true INTO v_deleted;

  RETURN COALESCE(v_deleted, false);
END;
$function$

