CREATE OR REPLACE FUNCTION public.create_company_holding(p_name text, p_website text, p_phone text, p_email text, p_logo_url text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  new_holding_id uuid;
BEGIN
  -- Insert the new holding and get its ID
  INSERT INTO public.company_holdings (
    name,
    website,
    phone,
    email,
    logo_url
  ) VALUES (
    p_name,
    p_website,
    p_phone,
    p_email,
    p_logo_url
  )
  RETURNING id INTO new_holding_id;
  
  RETURN new_holding_id;
END;
$function$

