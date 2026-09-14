CREATE OR REPLACE FUNCTION public.reopen_period_from(p_holding_id uuid, p_company_id uuid, p_from_date date, p_reason text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_current_cutoff date;
  v_new_cutoff date;
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
    RAISE EXCEPTION 'Solo admins (holding o super) pueden reabrir períodos'
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

  IF p_from_date <> date_trunc('month', p_from_date)::date THEN
    RAISE EXCEPTION 'p_from_date debe ser el día 1 de un mes (recibido: %)', p_from_date
      USING ERRCODE = 'P0001';
  END IF;

  SELECT cutoff_date INTO v_current_cutoff
    FROM public.accounting_period_cutoff
   WHERE holding_id = p_holding_id AND company_id = p_company_id;

  IF v_current_cutoff IS NULL THEN
    RAISE EXCEPTION 'No hay nada cerrado para reabrir en (holding=%, company=%)',
      p_holding_id, p_company_id
      USING ERRCODE = 'P0001';
  END IF;

  IF p_from_date > v_current_cutoff THEN
    RAISE EXCEPTION
      'El mes a reabrir (%) ya está abierto (cutoff actual: %)',
      p_from_date, v_current_cutoff
      USING ERRCODE = 'P0001';
  END IF;

  v_new_cutoff := (p_from_date - interval '1 day')::date;

  v_user_id := public.get_current_user_id();   -- FIX: antes auth.uid()
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'No se pudo identificar al usuario en public.users'
      USING ERRCODE = '42501';
  END IF;
  SELECT name, email INTO v_user_name, v_user_email
    FROM public.users WHERE id = v_user_id;

  UPDATE public.accounting_period_cutoff
     SET cutoff_date = v_new_cutoff,
         last_action = 'REOPENED',
         last_action_at = now(),
         last_action_by = v_user_id,
         last_action_by_name = v_user_name,
         last_action_by_email = v_user_email,
         last_action_reason = p_reason
   WHERE holding_id = p_holding_id AND company_id = p_company_id;

  INSERT INTO public.accounting_period_events (
    holding_id, company_id, action,
    cutoff_date_before, cutoff_date_after,
    performed_by, performed_by_name, performed_by_email,
    reason
  ) VALUES (
    p_holding_id, p_company_id, 'REOPENED',
    v_current_cutoff, v_new_cutoff,
    v_user_id, v_user_name, v_user_email,
    p_reason
  )
  RETURNING id INTO v_event_id;

  RETURN v_event_id;
END $function$

