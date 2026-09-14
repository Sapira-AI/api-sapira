CREATE OR REPLACE FUNCTION public.create_user_holding_safe(p_user_id uuid, p_name text, p_website text, p_phone text, p_email text, p_logo_url text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    new_holding_id UUID;
BEGIN
    -- Verificar que el usuario no tenga ya un holding
    IF EXISTS (SELECT 1 FROM public.user_holdings WHERE user_id = p_user_id) THEN
        RAISE EXCEPTION 'User already has a holding associated';
    END IF;
    
    -- Crear el holding
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
    
    -- Asociar usuario con holding
    INSERT INTO public.user_holdings (user_id, holding_id)
    VALUES (p_user_id, new_holding_id);
    
    RETURN new_holding_id;
END;
$function$

