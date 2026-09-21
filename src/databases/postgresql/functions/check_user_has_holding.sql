CREATE OR REPLACE FUNCTION public.check_user_has_holding()
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    user_record_id UUID;
    has_holding BOOLEAN := false;
BEGIN
    -- Obtener el ID del usuario en la tabla public.users usando auth.uid()
    SELECT id INTO user_record_id 
    FROM public.users 
    WHERE auth_id = auth.uid();
    
    -- Si no encontramos por auth_id, intentar por email
    IF user_record_id IS NULL THEN
        SELECT id INTO user_record_id 
        FROM public.users 
        WHERE email = (SELECT email FROM auth.users WHERE id = auth.uid());
    END IF;
    
    -- Verificar si tiene holding
    IF user_record_id IS NOT NULL THEN
        SELECT EXISTS(
            SELECT 1 FROM public.user_holdings 
            WHERE user_id = user_record_id
        ) INTO has_holding;
    END IF;
    
    RETURN has_holding;
END;
$function$

