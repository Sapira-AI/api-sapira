CREATE OR REPLACE FUNCTION public.assign_admin_role_safe(p_user_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    admin_role_id uuid;
BEGIN
    -- Log para debugging
    RAISE NOTICE 'assign_admin_role_safe called with user_id: %', p_user_id;
    
    -- Obtener o crear rol de Administrador
    SELECT id INTO admin_role_id FROM public.roles WHERE name = 'Administrador';
    
    IF admin_role_id IS NULL THEN
        -- Crear rol de Administrador si no existe
        INSERT INTO public.roles (name, description)
        VALUES ('Administrador', 'Acceso completo al sistema')
        RETURNING id INTO admin_role_id;
        
        -- Crear permisos básicos
        INSERT INTO public.permissions (code, description) VALUES
        ('ALL_PERMISSIONS', 'Acceso completo al sistema'),
        ('MANAGE_USERS', 'Gestionar usuarios'),
        ('MANAGE_CLIENTS', 'Gestionar clientes'),
        ('MANAGE_CONTRACTS', 'Gestionar contratos'),
        ('MANAGE_INVOICES', 'Gestionar facturas'),
        ('VIEW_REPORTS', 'Ver reportes')
        ON CONFLICT (code) DO NOTHING;
        
        -- Asignar permisos al rol
        INSERT INTO public.role_permissions (role_id, permission_id)
        SELECT admin_role_id, id FROM public.permissions
        ON CONFLICT DO NOTHING;
    END IF;
    
    -- Asignar rol al usuario
    UPDATE public.users 
    SET role_id = admin_role_id, status = 'Activo'
    WHERE id = p_user_id;
    
    IF FOUND THEN
        RAISE NOTICE 'Admin role assigned successfully to user: %', p_user_id;
        RETURN true;
    ELSE
        RAISE NOTICE 'Failed to assign admin role to user: %', p_user_id;
        RETURN false;
    END IF;
END;
$function$

