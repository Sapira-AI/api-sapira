CREATE OR REPLACE FUNCTION public.sync_client_entity_primary_client()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'INSERT' OR TG_OP = 'UPDATE' THEN
    -- Si se marca como primary, actualizar client_entities.client_id
    IF NEW.is_primary = true THEN
      -- Desmarcar otros como primary
      UPDATE client_entity_clients
      SET is_primary = false
      WHERE client_entity_id = NEW.client_entity_id
        AND id != NEW.id
        AND is_primary = true;
      
      -- Actualizar client_entities.client_id
      UPDATE client_entities
      SET client_id = NEW.client_id
      WHERE id = NEW.client_entity_id;
    END IF;
  ELSIF TG_OP = 'DELETE' THEN
    -- Si se elimina el primary, limpiar client_entities.client_id
    IF OLD.is_primary = true THEN
      UPDATE client_entities
      SET client_id = NULL
      WHERE id = OLD.client_entity_id;
      
      -- Marcar otro como primary si existe
      UPDATE client_entity_clients
      SET is_primary = true
      WHERE id = (
        SELECT id
        FROM client_entity_clients
        WHERE client_entity_id = OLD.client_entity_id
        ORDER BY created_at ASC
        LIMIT 1
      );
    END IF;
  END IF;
  
  RETURN COALESCE(NEW, OLD);
END;
$function$

