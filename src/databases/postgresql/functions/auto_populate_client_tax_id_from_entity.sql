CREATE OR REPLACE FUNCTION public.auto_populate_client_tax_id_from_entity()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_tax_id TEXT;
BEGIN
  -- Solo procesar si client_tax_id está vacío o es NULL
  -- y si existe un client_entity_id
  IF (NEW.client_tax_id IS NULL OR NEW.client_tax_id = '') 
     AND NEW.client_entity_id IS NOT NULL THEN
    
    -- Buscar el tax_id desde client_entities
    SELECT tax_id INTO v_tax_id
    FROM public.client_entities
    WHERE id = NEW.client_entity_id
      AND holding_id = NEW.holding_id; -- Validar que sea del mismo holding
    
    -- Si se encontró un tax_id, asignarlo
    IF v_tax_id IS NOT NULL AND v_tax_id != '' THEN
      NEW.client_tax_id := v_tax_id;
    END IF;
  END IF;
  
  RETURN NEW;
END;
$function$

