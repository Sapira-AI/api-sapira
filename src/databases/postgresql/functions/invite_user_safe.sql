CREATE OR REPLACE FUNCTION public.invite_user_safe(p_inviter_auth_id uuid, p_email text, p_name text, p_role_id uuid, p_holding_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    inviter_user_id  uuid;
    inviter_is_super boolean;
    v_holding        uuid;
    v_role_holding   uuid;
    new_user_id      uuid;
BEGIN
    -- 1) Resolver inviter
    SELECT id, COALESCE(is_super_admin, false)
      INTO inviter_user_id, inviter_is_super
    FROM public.users
    WHERE auth_id = p_inviter_auth_id;

    IF inviter_user_id IS NULL THEN
        RAISE EXCEPTION 'Inviter user not found with auth_id: %', p_inviter_auth_id;
    END IF;

    -- 2) Resolver holding destino (determinista)
    IF p_holding_id IS NOT NULL THEN
        v_holding := p_holding_id;
        IF NOT inviter_is_super AND NOT EXISTS (
            SELECT 1 FROM public.user_holdings
            WHERE user_id = inviter_user_id AND holding_id = v_holding
        ) THEN
            RAISE EXCEPTION 'No perteneces al holding indicado para invitar usuarios';
        END IF;
    ELSE
        -- Fallback: holding seleccionado en la UI; si no hay, el más antiguo.
        SELECT holding_id INTO v_holding
        FROM public.user_holdings
        WHERE user_id = inviter_user_id AND selected = true
        LIMIT 1;

        IF v_holding IS NULL THEN
            SELECT holding_id INTO v_holding
            FROM public.user_holdings
            WHERE user_id = inviter_user_id
            ORDER BY created_at NULLS LAST
            LIMIT 1;
        END IF;

        IF v_holding IS NULL THEN
            RAISE EXCEPTION 'Inviter has no holding associated';
        END IF;
    END IF;

    -- 3) El rol debe pertenecer al holding destino
    IF p_role_id IS NOT NULL THEN
        SELECT holding_id INTO v_role_holding FROM public.roles WHERE id = p_role_id;
        IF v_role_holding IS NULL THEN
            RAISE EXCEPTION 'Rol % no encontrado', p_role_id;
        ELSIF v_role_holding <> v_holding THEN
            RAISE EXCEPTION 'El rol seleccionado pertenece a otro holding';
        END IF;
    END IF;

    -- 4) Crear usuario "pendiente" (idempotente por email)
    INSERT INTO public.users(email, name, status, role_id)
    VALUES (p_email, p_name, 'Pendiente', p_role_id)
    ON CONFLICT(email) DO UPDATE SET
        role_id = EXCLUDED.role_id,
        name = EXCLUDED.name
    RETURNING id INTO new_user_id;

    -- 5) Vincular al holding destino (idempotente)
    INSERT INTO public.user_holdings(user_id, holding_id)
    VALUES (new_user_id, v_holding)
    ON CONFLICT (user_id, holding_id) DO NOTHING;

    -- 6) Info para el correo de invitación
    RETURN jsonb_build_object(
        'user_id', new_user_id,
        'email', p_email,
        'holding_id', v_holding
    );
END $function$

