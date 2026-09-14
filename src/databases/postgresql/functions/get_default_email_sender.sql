CREATE OR REPLACE FUNCTION public.get_default_email_sender(p_holding_id uuid)
 RETURNS TABLE(domain_id uuid, sender_id uuid, sender_domain text, from_name text, from_email text, reply_to_email text)
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
BEGIN
  RETURN QUERY
  SELECT 
    hess.id as domain_id,
    esa.id as sender_id,
    hess.sender_domain,
    esa.from_name,
    esa.from_email,
    esa.reply_to_email
  FROM holding_email_sender_settings hess
  INNER JOIN email_sender_addresses esa ON esa.domain_config_id = hess.id
  WHERE hess.holding_id = p_holding_id
    AND hess.is_default = true
    AND hess.is_active = true
    AND esa.is_default = true
    AND esa.is_active = true
  LIMIT 1;
END;
$function$

