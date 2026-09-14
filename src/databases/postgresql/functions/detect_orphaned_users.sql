CREATE OR REPLACE FUNCTION public.detect_orphaned_users()
 RETURNS TABLE(user_id uuid, email text, auth_id uuid, created_at timestamp without time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
    RETURN QUERY
    SELECT u.id, u.email, u.auth_id, u.created_at
    FROM public.users u
    LEFT JOIN public.user_holdings uh ON u.id = uh.user_id
    WHERE uh.user_id IS NULL
    AND u.status != 'Pendiente'; -- Excluir usuarios pendientes de invitación
END;
$function$

