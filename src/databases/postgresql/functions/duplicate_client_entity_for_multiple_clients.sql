CREATE OR REPLACE FUNCTION public.duplicate_client_entity_for_multiple_clients(p_source_entity_id uuid, p_client_ids uuid[])
 RETURNS TABLE(entity_id uuid, client_id uuid, legal_name text, tax_id text)
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_source_entity record;
  v_client_id uuid;
  v_new_entity_id uuid;
  v_holding_id uuid;
BEGIN
  -- Obtener holding del usuario actual
  SELECT get_current_user_holding_id() INTO v_holding_id;
  
  IF v_holding_id IS NULL THEN
    RAISE EXCEPTION 'No se pudo obtener el holding del usuario';
  END IF;

  -- Obtener datos de la entidad origen
  SELECT * INTO v_source_entity
  FROM client_entities
  WHERE id = p_source_entity_id
    AND holding_id = v_holding_id;
  
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Entidad no encontrada o no pertenece al holding del usuario';
  END IF;

  -- Iterar sobre cada client_id
  FOREACH v_client_id IN ARRAY p_client_ids
  LOOP
    -- Si la entidad origen no tiene cliente asignado Y es el primer cliente del array
    IF v_source_entity.client_id IS NULL THEN
      -- Asignar el primer cliente sin duplicar
      UPDATE client_entities
      SET client_id = v_client_id
      WHERE id = p_source_entity_id;
      
      RETURN QUERY
      SELECT 
        p_source_entity_id,
        v_client_id,
        v_source_entity.legal_name,
        v_source_entity.tax_id;
      
      -- Marcar que ya se asignó el primero para que los siguientes se dupliquen
      v_source_entity.client_id := v_client_id;
    ELSE
      -- Si ya tiene cliente asignado O ya procesamos el primero, duplicar para los siguientes
      -- Esto permite agregar clientes adicionales a una entidad que ya tiene cliente
      -- IMPORTANTE: Se incluye odoo_partner_id para mantener la referencia al partner de Odoo
      INSERT INTO client_entities (
        holding_id,
        client_id,
        legal_name,
        tax_id,
        country,
        legal_address,
        email,
        phone,
        odoo_partner_id
      )
      VALUES (
        v_holding_id,
        v_client_id,
        v_source_entity.legal_name,
        v_source_entity.tax_id,
        v_source_entity.country,
        v_source_entity.legal_address,
        v_source_entity.email,
        v_source_entity.phone,
        v_source_entity.odoo_partner_id
      )
      RETURNING id INTO v_new_entity_id;
      
      RETURN QUERY
      SELECT 
        v_new_entity_id,
        v_client_id,
        v_source_entity.legal_name,
        v_source_entity.tax_id;
    END IF;
  END LOOP;
  
  -- Si la entidad origen ya tenía un cliente asignado, incluirlo en los resultados
  -- para que el frontend sepa que ese cliente ya existía
  IF v_source_entity.client_id IS NOT NULL AND array_length(p_client_ids, 1) > 0 THEN
    -- Verificar si el cliente actual está en el array de nuevos clientes
    IF NOT (v_source_entity.client_id = ANY(p_client_ids)) THEN
      RETURN QUERY
      SELECT 
        v_source_entity.id,
        v_source_entity.client_id,
        v_source_entity.legal_name,
        v_source_entity.tax_id;
    END IF;
  END IF;
END;
$function$;

COMMENT ON FUNCTION public."duplicate_client_entity_for_multiple_clients"(p_source_entity_id uuid, p_client_ids uuid[]) IS 'Duplica una client_entity para asignarla a múltiples clientes comerciales. 
La primera asignación actualiza la entidad original, las siguientes crean duplicados.';
