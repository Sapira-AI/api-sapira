CREATE OR REPLACE FUNCTION public.get_current_user_id()
 RETURNS uuid
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    user_record_id UUID;
BEGIN
    -- Primero intentar por auth_id
    SELECT id INTO user_record_id 
    FROM public.users 
    WHERE auth_id = auth.uid();
    
    -- Si no se encuentra por auth_id, intentar por email
    IF user_record_id IS NULL THEN
        SELECT id INTO user_record_id 
        FROM public.users 
        WHERE email = (SELECT email FROM auth.users WHERE id = auth.uid());
    END IF;
    
    RETURN user_record_id;
END;
$function$

