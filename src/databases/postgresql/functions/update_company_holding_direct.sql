CREATE OR REPLACE FUNCTION public.update_company_holding_direct(p_id uuid, p_name text, p_website text, p_phone text, p_email text, p_logo_url text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
    -- Actualizar el holding directamente
    UPDATE public.company_holdings
    SET 
        name = p_name,
        website = p_website,
        phone = p_phone,
        email = p_email,
        logo_url = p_logo_url
    WHERE id = p_id;
    
    RETURN FOUND;
END;
$function$

