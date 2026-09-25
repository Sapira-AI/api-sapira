CREATE OR REPLACE FUNCTION public.assign_clients_to_entity(p_entity_id uuid, p_client_ids uuid[], p_primary_client_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(entity_id uuid, assigned_client_id uuid, assigned_client_name text, is_primary_client boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_holding_id uuid;
  v_client_id uuid;
  v_is_primary boolean;
BEGIN
  -- Obtener holding del usuario actual
  SELECT get_current_user_holding_id() INTO v_holding_id;
  
  IF v_holding_id IS NULL THEN
    RAISE EXCEPTION 'No se pudo obtener el holding del usuario';
  END IF;

  -- Verificar que la entidad existe y pertenece al holding
  IF NOT EXISTS (
    SELECT 1 FROM client_entities 
    WHERE id = p_entity_id AND holding_id = v_holding_id
  ) THEN
    RAISE EXCEPTION 'Entidad no encontrada o no pertenece al holding del usuario';
  END IF;

  -- Verificar que todos los clientes existen y pertenecen al holding
  IF EXISTS (
    SELECT 1 FROM unnest(p_client_ids) AS cid
    WHERE NOT EXISTS (
      SELECT 1 FROM clients 
      WHERE id = cid AND holding_id = v_holding_id
    )
  ) THEN
    RAISE EXCEPTION 'Uno o más clientes no encontrados o no pertenecen al holding del usuario';
  END IF;

  -- Iterar sobre cada client_id
  FOREACH v_client_id IN ARRAY p_client_ids
  LOOP
    -- Determinar si es primary
    v_is_primary := (p_primary_client_id IS NOT NULL AND v_client_id = p_primary_client_id)
                    OR (p_primary_client_id IS NULL AND v_client_id = p_client_ids[1]);
    
    -- Insertar o actualizar la relación
    INSERT INTO client_entity_clients (
      client_entity_id,
      client_id,
      holding_id,
      is_primary,
      created_by
    )
    VALUES (
      p_entity_id,
      v_client_id,
      v_holding_id,
      v_is_primary,
      auth.uid()
    )
    ON CONFLICT (client_entity_id, client_id) 
    DO UPDATE SET is_primary = EXCLUDED.is_primary;
  END LOOP;

  -- Retornar todas las relaciones de esta entidad
  RETURN QUERY
  SELECT 
    cec.client_entity_id,
    cec.client_id,
    c.name_commercial,
    cec.is_primary
  FROM client_entity_clients cec
  INNER JOIN clients c ON c.id = cec.client_id
  WHERE cec.client_entity_id = p_entity_id
  ORDER BY cec.is_primary DESC, c.name_commercial;
END;
$function$;

COMMENT ON FUNCTION public."assign_clients_to_entity"(p_entity_id uuid, p_client_ids uuid[], p_primary_client_id uuid) IS 'Asigna múltiples clientes comerciales a una razón social. 
Si p_primary_client_id se especifica, ese será el primary, sino el primero del array.
Usa ON CONFLICT para no duplicar si ya existe la relación.';
