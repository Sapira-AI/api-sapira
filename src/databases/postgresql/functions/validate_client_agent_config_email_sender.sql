CREATE OR REPLACE FUNCTION public.validate_client_agent_config_email_sender()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_sender_holding_id UUID;
BEGIN
  -- Si hay email_sender_address_id en config_json, validar que pertenezca al holding
  IF NEW.config_json ? 'email_sender_address_id' AND 
     NEW.config_json->>'email_sender_address_id' IS NOT NULL AND
     NEW.config_json->>'email_sender_address_id' != '' THEN
    
    -- Obtener holding_id del email_sender_address
    SELECT hess.holding_id INTO v_sender_holding_id
    FROM email_sender_addresses esa
    INNER JOIN holding_email_sender_settings hess ON esa.domain_config_id = hess.id
    WHERE esa.id = (NEW.config_json->>'email_sender_address_id')::uuid;
    
    -- Validar que pertenezca al mismo holding
    IF v_sender_holding_id IS NULL THEN
      RAISE EXCEPTION 'Email sender address not found';
    END IF;
    
    IF v_sender_holding_id != NEW.holding_id THEN
      RAISE EXCEPTION 'Email sender address does not belong to this holding';
    END IF;
  END IF;
  
  RETURN NEW;
END;
$function$

