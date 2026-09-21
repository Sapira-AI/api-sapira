CREATE OR REPLACE FUNCTION public.close_period_until(p_holding_id uuid, p_company_id uuid, p_until_date date, p_reason text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_current_cutoff date;
  v_user_id uuid;
  v_user_name text;
  v_user_email text;
  v_event_id uuid;
  v_is_super boolean;
  v_is_admin boolean;
  v_user_holding uuid;
BEGIN
  v_is_super := public.is_super_admin();
  v_is_admin := public.is_holding_admin();
  IF NOT (v_is_super OR v_is_admin) THEN
    RAISE EXCEPTION 'Solo admins (holding o super) pueden cerrar períodos'
      USING ERRCODE = '42501';
  END IF;

  IF NOT v_is_super THEN
    v_user_holding := public.get_current_user_holding_id();
    IF v_user_holding IS DISTINCT FROM p_holding_id THEN
      RAISE EXCEPTION 'No autorizado para operar sobre el holding %', p_holding_id
        USING ERRCODE = '42501';
    END IF;
  END IF;

  IF p_reason IS NULL OR length(trim(p_reason)) < 10 THEN
    RAISE EXCEPTION 'El motivo es obligatorio y debe tener al menos 10 caracteres'
      USING ERRCODE = 'P0001';
  END IF;

  IF p_until_date <> (date_trunc('month', p_until_date) + interval '1 month' - interval '1 day')::date THEN
    RAISE EXCEPTION 'p_until_date debe ser el último día de un mes (recibido: %)', p_until_date
      USING ERRCODE = 'P0001';
  END IF;

  SELECT cutoff_date INTO v_current_cutoff
    FROM public.accounting_period_cutoff
   WHERE holding_id = p_holding_id AND company_id = p_company_id;

  IF v_current_cutoff IS NOT NULL AND p_until_date < v_current_cutoff THEN
    RAISE EXCEPTION
      'No se puede cerrar a una fecha anterior al cutoff actual (cutoff=%, nueva=%). Para retroceder se debe usar reopen_period_from.',
      v_current_cutoff, p_until_date
      USING ERRCODE = 'P0001';
  END IF;

  v_user_id := public.get_current_user_id();   -- FIX: antes auth.uid()
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'No se pudo identificar al usuario en public.users'
      USING ERRCODE = '42501';
  END IF;
  SELECT name, email INTO v_user_name, v_user_email
    FROM public.users WHERE id = v_user_id;

  INSERT INTO public.accounting_period_cutoff (
    holding_id, company_id, cutoff_date,
    last_action, last_action_at, last_action_by,
    last_action_by_name, last_action_by_email, last_action_reason
  ) VALUES (
    p_holding_id, p_company_id, p_until_date,
    'CLOSED', now(), v_user_id,
    v_user_name, v_user_email, p_reason
  )
  ON CONFLICT (holding_id, company_id) DO UPDATE
    SET cutoff_date = EXCLUDED.cutoff_date,
        last_action = EXCLUDED.last_action,
        last_action_at = EXCLUDED.last_action_at,
        last_action_by = EXCLUDED.last_action_by,
        last_action_by_name = EXCLUDED.last_action_by_name,
        last_action_by_email = EXCLUDED.last_action_by_email,
        last_action_reason = EXCLUDED.last_action_reason;

  INSERT INTO public.accounting_period_events (
    holding_id, company_id, action,
    cutoff_date_before, cutoff_date_after,
    performed_by, performed_by_name, performed_by_email,
    reason
  ) VALUES (
    p_holding_id, p_company_id, 'CLOSED',
    v_current_cutoff, p_until_date,
    v_user_id, v_user_name, v_user_email,
    p_reason
  )
  RETURNING id INTO v_event_id;

  RETURN v_event_id;
END $function$

