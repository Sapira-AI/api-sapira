CREATE OR REPLACE FUNCTION public.rls_user_holding_id()
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE(
    -- Primero intentar obtener el holding con selected=true
    (
      SELECT uh.holding_id
      FROM public.user_holdings uh
      INNER JOIN public.users u ON uh.user_id = u.id
      WHERE u.auth_id = auth.uid()
        AND uh.selected = true
        AND uh.is_active = true
      LIMIT 1
    ),
    -- Si no existe con selected=true, obtener el primer holding activo
    (
      SELECT uh.holding_id
      FROM public.user_holdings uh
      INNER JOIN public.users u ON uh.user_id = u.id
      WHERE u.auth_id = auth.uid()
        AND uh.is_active = true
      ORDER BY uh.created_at ASC
      LIMIT 1
    )
  );
$function$

