CREATE OR REPLACE FUNCTION public.get_user_holding_id()
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    user_record_id UUID;
    holding_id_result UUID;
    user_status TEXT;
BEGIN
    -- Paso 1: Obtener el ID del usuario en la tabla public.users usando auth.uid()
    SELECT id, status INTO user_record_id, user_status
    FROM public.users 
    WHERE auth_id = auth.uid();
    
    -- Si no encontramos el usuario por auth_id, intentar por email
    IF user_record_id IS NULL THEN
        SELECT id, status INTO user_record_id, user_status
        FROM public.users 
        WHERE email = (SELECT email FROM auth.users WHERE id = auth.uid());
    END IF;
    
    -- Si aún no tenemos el usuario, retornar NULL (caso crítico)
    IF user_record_id IS NULL THEN
        RAISE WARNING 'Usuario no encontrado en public.users para auth.uid(): %', auth.uid();
        RETURN NULL;
    END IF;
    
    -- Paso 2: Buscar primero el holding con selected=true
    SELECT uh.holding_id INTO holding_id_result
    FROM public.user_holdings uh
    WHERE uh.user_id = user_record_id
      AND uh.selected = true
      AND uh.is_active = true
    LIMIT 1;
    
    -- Si no hay holding con selected=true, buscar el primer holding activo disponible
    IF holding_id_result IS NULL THEN
        SELECT uh.holding_id INTO holding_id_result
        FROM public.user_holdings uh
        WHERE uh.user_id = user_record_id
          AND uh.is_active = true
        ORDER BY uh.created_at ASC
        LIMIT 1;
    END IF;
    
    -- Si no tiene holding y no es usuario pendiente, es un problema crítico
    IF holding_id_result IS NULL AND user_status != 'Pendiente' THEN
        RAISE WARNING 'Usuario activo sin holding detectado: user_id=%, status=%', user_record_id, user_status;
    END IF;
    
    RETURN holding_id_result;
END;
$function$

