CREATE OR REPLACE FUNCTION public.audit_user_holding_security()
 RETURNS TABLE(issue_type text, user_id uuid, email text, status text, holding_id uuid, details text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_is_super_admin boolean := public.rls_is_super_admin();
  v_holding_id uuid := public.get_current_user_holding_id();
BEGIN
  IF v_is_super_admin THEN
    -- Usuarios activos sin holding
    RETURN QUERY
    SELECT
      'ACTIVE_USER_NO_HOLDING'::text,
      u.id,
      u.email,
      u.status,
      NULL::uuid,
      'Usuario activo sin holding asociado'::text
    FROM public.users u
    LEFT JOIN public.user_holdings uh ON u.id = uh.user_id
    WHERE uh.user_id IS NULL
      AND u.status = 'Activo';

    -- Holdings sin usuarios asociados
    RETURN QUERY
    SELECT
      'ORPHANED_HOLDING'::text,
      NULL::uuid,
      ch.email,
      NULL::text,
      ch.id,
      'Holding sin usuarios asociados'::text
    FROM public.company_holdings ch
    LEFT JOIN public.user_holdings uh ON ch.id = uh.holding_id
    WHERE uh.holding_id IS NULL;

    -- Holdings con nombres temporales (posibles problemas)
    RETURN QUERY
    SELECT
      'TEMPORARY_HOLDING'::text,
      NULL::uuid,
      ch.email,
      NULL::text,
      ch.id,
      'Holding con nombre temporal detectado'::text
    FROM public.company_holdings ch
    WHERE ch.name LIKE 'Empresa de %';

    RETURN;
  END IF;

  -- Modo tenant-scoped (no super admin): limitar auditoría al holding actual
  -- Holding sin usuarios asociados (solo holding actual)
  RETURN QUERY
  SELECT
    'ORPHANED_HOLDING'::text,
    NULL::uuid,
    ch.email,
    NULL::text,
    ch.id,
    'Holding sin usuarios asociados'::text
  FROM public.company_holdings ch
  LEFT JOIN public.user_holdings uh ON ch.id = uh.holding_id
  WHERE ch.id = v_holding_id
    AND uh.holding_id IS NULL;

  -- Holding con nombre temporal (solo holding actual)
  RETURN QUERY
  SELECT
    'TEMPORARY_HOLDING'::text,
    NULL::uuid,
    ch.email,
    NULL::text,
    ch.id,
    'Holding con nombre temporal detectado'::text
  FROM public.company_holdings ch
  WHERE ch.id = v_holding_id
    AND ch.name LIKE 'Empresa de %';
END;
$function$

