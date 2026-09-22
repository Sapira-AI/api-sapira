CREATE OR REPLACE FUNCTION public.change_contract_commercial_client(p_contract_id uuid, p_new_client_id uuid)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_contract record;
  v_new_client record;
  v_new_entity record;
  v_holding_id uuid;
  v_old_client_name text;
  v_new_client_name text;
BEGIN
  -- Obtener holding del usuario actual
  SELECT get_current_user_holding_id() INTO v_holding_id;
  
  IF v_holding_id IS NULL THEN
    RAISE EXCEPTION 'No se pudo obtener el holding del usuario';
  END IF;

  -- Obtener datos del contrato
  SELECT * INTO v_contract
  FROM contracts
  WHERE id = p_contract_id
    AND holding_id = v_holding_id;
  
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Contrato no encontrado o no pertenece al holding del usuario';
  END IF;

  -- Validar que el contrato NO esté en estado Activo, Firmado, Cancelado o Expirado
  IF v_contract.status IN ('Activo', 'Firmado', 'Cancelado', 'Expirado') THEN
    RAISE EXCEPTION 'No se puede cambiar el cliente comercial de un contrato en estado: %', v_contract.status;
  END IF;

  -- Obtener datos del nuevo cliente comercial
  SELECT * INTO v_new_client
  FROM clients
  WHERE id = p_new_client_id
    AND holding_id = v_holding_id;
  
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Cliente comercial no encontrado o no pertenece al holding del usuario';
  END IF;

  -- Guardar nombre del cliente anterior para el log
  SELECT name_commercial INTO v_old_client_name
  FROM clients
  WHERE id = v_contract.client_id;

  v_new_client_name := v_new_client.name_commercial;

  -- Buscar una client_entity que tenga el mismo tax_id y esté asignada al nuevo cliente
  -- AHORA usando la junction table
  IF v_contract.client_entity_id IS NOT NULL THEN
    SELECT ce.* INTO v_new_entity
    FROM client_entities ce
    INNER JOIN client_entity_clients cec ON cec.client_entity_id = ce.id
    WHERE cec.client_id = p_new_client_id
      AND ce.holding_id = v_holding_id
      AND ce.tax_id = (
        SELECT tax_id 
        FROM client_entities 
        WHERE id = v_contract.client_entity_id
      )
    LIMIT 1;
    
    -- Si no existe una entidad con el mismo tax_id para el nuevo cliente, lanzar error
    IF NOT FOUND THEN
      RAISE EXCEPTION 'No existe una razón social con el mismo Tax ID asignada al nuevo cliente comercial. Primero debes asignar la razón social al cliente.';
    END IF;
  ELSE
    -- Si el contrato no tiene client_entity_id, buscar cualquier entidad del nuevo cliente
    SELECT ce.* INTO v_new_entity
    FROM client_entities ce
    INNER JOIN client_entity_clients cec ON cec.client_entity_id = ce.id
    WHERE cec.client_id = p_new_client_id
      AND ce.holding_id = v_holding_id
    LIMIT 1;
  END IF;

  -- Actualizar el contrato con el nuevo cliente y su entidad
  UPDATE contracts
  SET 
    client_id = p_new_client_id,
    client_entity_id = v_new_entity.id,
    client_name_commercial = v_new_client.name_commercial,
    legal_client_name = v_new_entity.legal_name
  WHERE id = p_contract_id;

  -- Retornar información de la operación
  RETURN json_build_object(
    'success', true,
    'contract_id', p_contract_id,
    'old_client_id', v_contract.client_id,
    'old_client_name', v_old_client_name,
    'new_client_id', p_new_client_id,
    'new_client_name', v_new_client_name,
    'new_entity_id', v_new_entity.id,
    'message', format('Cliente comercial cambiado de "%s" a "%s"', v_old_client_name, v_new_client_name)
  );
END;
$function$;

COMMENT ON FUNCTION public."change_contract_commercial_client"(p_contract_id uuid, p_new_client_id uuid) IS 'Cambia el cliente comercial de un contrato que NO está en estado Activo, Firmado, Cancelado o Expirado.
Ahora valida usando la junction table client_entity_clients que exista una razón social con el mismo tax_id asignada al nuevo cliente comercial.
Estados permitidos: En revisión, En proceso.';
