CREATE OR REPLACE FUNCTION public.log_lifecycle_event(p_contract_id uuid, p_event_type text, p_title text, p_effective_date date DEFAULT NULL::date, p_amount_delta numeric DEFAULT NULL::numeric, p_summary text DEFAULT NULL::text, p_description text DEFAULT NULL::text, p_items_affected jsonb DEFAULT NULL::jsonb, p_event_subtype text DEFAULT NULL::text, p_status text DEFAULT 'Recorded'::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_id uuid;
  v_holding uuid;
  v_user uuid;
BEGIN
  SELECT public.get_contract_holding(p_contract_id) INTO v_holding;
  IF v_holding IS NULL THEN
    RAISE EXCEPTION 'Contrato no encontrado o sin permisos';
  END IF;

  SELECT public.get_current_user_id() INTO v_user;

  INSERT INTO public.contract_lifecycle_events (
    id,
    contract_id,
    holding_id,
    event_type,
    event_status,
    event_subtype,
    title,
    description,
    summary,
    effective_date,
    amount_delta,
    items_affected,
    created_by
  ) VALUES (
    gen_random_uuid(),
    p_contract_id,
    v_holding,
    p_event_type,
    p_status,
    p_event_subtype,
    p_title,
    p_description,
    p_summary,
    p_effective_date,
    p_amount_delta,
    COALESCE(p_items_affected, '[]'::jsonb),
    v_user
  ) RETURNING id INTO v_id;

  RETURN v_id;
END;
$function$

