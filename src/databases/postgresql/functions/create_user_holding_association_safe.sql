CREATE OR REPLACE FUNCTION public.create_user_holding_association_safe(p_user_id uuid, p_holding_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
    -- Log para debugging
    RAISE NOTICE 'create_user_holding_association_safe called with user_id: %, holding_id: %', p_user_id, p_holding_id;
    
    -- Verificar que el usuario existe
    IF NOT EXISTS (SELECT 1 FROM public.users WHERE id = p_user_id) THEN
        RAISE EXCEPTION 'User ID % does not exist', p_user_id;
    END IF;
    
    -- Verificar que el holding existe
    IF NOT EXISTS (SELECT 1 FROM public.company_holdings WHERE id = p_holding_id) THEN
        RAISE EXCEPTION 'Holding ID % does not exist', p_holding_id;
    END IF;
    
    -- Insertar la asociación (idempotente con ON CONFLICT)
    INSERT INTO public.user_holdings (user_id, holding_id)
    VALUES (p_user_id, p_holding_id)
    ON CONFLICT (user_id, holding_id) DO NOTHING;
    
    RAISE NOTICE 'User-holding association created/confirmed: user_id=%, holding_id=%', p_user_id, p_holding_id;
    
    RETURN true;
END;
$function$

