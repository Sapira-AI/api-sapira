CREATE OR REPLACE FUNCTION public.sync_user_on_login()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_user_id uuid;
    v_user_name text;
    v_provider text;
    v_holding_id uuid;
    default_holding_name text;
    current_status text;
BEGIN
    -- Extraer nombre del usuario de metadata
    v_user_name := COALESCE(
        NEW.raw_user_meta_data->>'full_name',
        NEW.raw_user_meta_data->>'name',
        split_part(NEW.email, '@', 1)
    );
    
    -- Detectar provider de autenticación
    v_provider := COALESCE(
        NEW.raw_app_meta_data->>'provider',
        'email'
    );
    
    RAISE NOTICE 'sync_user_on_login ejecutándose para: % (provider: %)', NEW.email, v_provider;
    
    -- 1. Buscar usuario por auth_id (ya vinculado previamente)
    SELECT id, status INTO v_user_id, current_status
    FROM public.users 
    WHERE auth_id = NEW.id;
    
    -- 2. Si no existe por auth_id, buscar por email (usuario invitado pendiente)
    IF v_user_id IS NULL THEN
        SELECT id, status INTO v_user_id, current_status
        FROM public.users 
        WHERE email = NEW.email AND auth_id IS NULL;
    END IF;
    
    -- 3. Si existe usuario en public.users (fue invitado)
    IF v_user_id IS NOT NULL THEN
        RAISE NOTICE 'Usuario encontrado en public.users: % (status actual: %)', v_user_id, current_status;
        
        -- Actualizar auth_id y activar usuario
        UPDATE public.users
        SET 
            auth_id = NEW.id,
            auth_provider = v_provider,
            status = 'Activo',  -- Cambiar de 'Pendiente' a 'Activo'
            name = COALESCE(name, v_user_name),
            last_access = now()
        WHERE id = v_user_id;
        
        -- Verificar que tenga holding asociado
        SELECT uh.holding_id INTO v_holding_id
        FROM public.user_holdings uh
        WHERE uh.user_id = v_user_id;
        
        IF v_holding_id IS NOT NULL THEN
            RAISE NOTICE '✅ Usuario invitado activado: % (holding: %)', NEW.email, v_holding_id;
        ELSE
            RAISE NOTICE '⚠️ Usuario sin holding asociado: %', NEW.email;
        END IF;
    ELSE
        -- Usuario completamente nuevo (NO invitado, llegó directamente)
        RAISE NOTICE '⚠️ Usuario NO invitado intenta acceder: %', NEW.email;
        
        -- Crear holding temporal para que pueda completar configuración inicial
        default_holding_name := 'Empresa de ' || v_user_name;
        
        INSERT INTO public.company_holdings (name, email)
        VALUES (default_holding_name, NEW.email)
        RETURNING id INTO v_holding_id;
        
        INSERT INTO public.users (
            auth_id, email, name, auth_provider, status
        ) VALUES (
            NEW.id, NEW.email, v_user_name, v_provider, 'Activo'
        ) RETURNING id INTO v_user_id;
        
        INSERT INTO public.user_holdings (user_id, holding_id)
        VALUES (v_user_id, v_holding_id);
        
        RAISE NOTICE '🆕 Nuevo usuario NO invitado creado: % (holding temporal: %)', NEW.email, v_holding_id;
    END IF;
    
    RETURN NEW;
EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE '💥 Error en sync_user_on_login para %: %', NEW.email, SQLERRM;
    RETURN NEW;
END;
$function$

