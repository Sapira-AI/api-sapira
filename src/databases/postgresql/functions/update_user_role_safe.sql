CREATE OR REPLACE FUNCTION public.update_user_role_safe(p_user_id uuid, p_role_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_caller        uuid;
    v_caller_super  boolean;
    v_role_holding  uuid;
    v_role_name     text;
BEGIN
    v_caller := public.get_current_user_id();
    IF v_caller IS NULL THEN
        RAISE EXCEPTION 'Usuario no autenticado';
    END IF;

    SELECT COALESCE(is_super_admin, false) INTO v_caller_super
    FROM public.users WHERE id = v_caller;

    SELECT holding_id, name INTO v_role_holding, v_role_name
    FROM public.roles WHERE id = p_role_id;
    IF v_role_holding IS NULL THEN
        RAISE EXCEPTION 'Rol % no encontrado', p_role_id;
    END IF;

    -- El rol debe pertenecer a un holding del usuario editado
    IF NOT EXISTS (
        SELECT 1 FROM public.user_holdings
        WHERE user_id = p_user_id AND holding_id = v_role_holding
    ) THEN
        RAISE EXCEPTION 'El rol pertenece a un holding distinto al del usuario editado';
    END IF;

    -- Permisos del caller: super admin, o mismo holding + EDIT_CONFIGURACION
    IF NOT v_caller_super THEN
        IF NOT EXISTS (
            SELECT 1 FROM public.user_holdings
            WHERE user_id = v_caller AND holding_id = v_role_holding
        ) THEN
            RAISE EXCEPTION 'No tienes acceso al holding del usuario editado';
        END IF;
        IF NOT EXISTS (
            SELECT 1
            FROM public.users u
            JOIN public.role_permissions rp ON rp.role_id = u.role_id
            JOIN public.permissions p ON p.id = rp.permission_id
            WHERE u.id = v_caller AND p.code = 'EDIT_CONFIGURACION'
        ) THEN
            RAISE EXCEPTION 'No tienes permiso para editar usuarios';
        END IF;
    END IF;

    UPDATE public.users SET role_id = p_role_id WHERE id = p_user_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Usuario % no encontrado', p_user_id;
    END IF;

    RETURN jsonb_build_object(
        'success', true,
        'user_id', p_user_id,
        'role_id', p_role_id,
        'role_name', v_role_name
    );
END $function$

