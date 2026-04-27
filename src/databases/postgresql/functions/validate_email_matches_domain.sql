CREATE OR REPLACE FUNCTION public.validate_email_matches_domain()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  domain_name TEXT;
BEGIN
  -- Obtener el dominio de la configuración
  SELECT sender_domain INTO domain_name
  FROM holding_email_sender_settings
  WHERE id = NEW.domain_config_id;
  
  -- Validar que el email termina con @dominio
  IF NEW.from_email NOT LIKE '%@' || domain_name THEN
    RAISE EXCEPTION 'El email % no pertenece al dominio %', NEW.from_email, domain_name;
  END IF;
  
  RETURN NEW;
END;
$function$

