CREATE OR REPLACE FUNCTION public.mark_contract_signed_safe(p_contract_id uuid, p_booking_mode text DEFAULT 'auto'::text, p_booking_date date DEFAULT NULL::date, p_comments text DEFAULT NULL::text, p_files text[] DEFAULT ARRAY[]::text[])
 RETURNS TABLE(success boolean, message text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_user_id uuid;
  v_holding_id uuid;
  v_contract RECORD;
  v_prev_step uuid;
  v_booking date;
BEGIN
  -- Resolver usuario y holding
  SELECT public.get_current_user_id() INTO v_user_id;
  IF v_user_id IS NULL THEN
    RETURN QUERY SELECT false, 'Usuario no encontrado';
    RETURN;
  END IF;

  SELECT public.get_current_user_holding_id() INTO v_holding_id;
  IF v_holding_id IS NULL THEN
    RETURN QUERY SELECT false, 'Usuario sin holding asociado';
    RETURN;
  END IF;

  -- Validar contrato y pertenencia al holding
  SELECT c.* INTO v_contract
  FROM public.contracts c
  WHERE c.id = p_contract_id AND c.holding_id = v_holding_id;

  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 'Contrato no encontrado o sin permisos';
    RETURN;
  END IF;

  v_prev_step := v_contract.current_step_id;

  -- Resolver booking_date
  v_booking := CASE 
    WHEN lower(coalesce(p_booking_mode,'auto')) = 'manual' AND p_booking_date IS NOT NULL THEN p_booking_date
    ELSE COALESCE(v_contract.booking_date, CURRENT_DATE)
  END;

  -- Actualizar contrato a Activo y cerrar workflow
  UPDATE public.contracts
  SET status = 'Activo',
      current_step_id = NULL,
      workflow_completed_at = now(),
      booking_date = COALESCE(booking_date, v_booking)
  WHERE id = p_contract_id;

  -- Registrar historial manual (evita dependencia de trigger)
  INSERT INTO public.contract_workflow_history (
    contract_id,
    workflow_step_id,
    status,
    comments,
    transition_type,
    metadata,
    user_id,
    completed_at
  ) VALUES (
    p_contract_id,
    COALESCE(v_prev_step, v_contract.current_step_id),
    'completed',
    COALESCE(p_comments, 'Contrato marcado como firmado'),
    'manual',
    jsonb_build_object(
      'manually_advanced', true,
      'previous_step_id', v_prev_step,
      'timestamp', now()
    ),
    v_user_id,
    now()
  );

  -- Opcional: adjuntar archivos como comentario en historial si hay
  IF p_files IS NOT NULL AND array_length(p_files,1) IS NOT NULL AND array_length(p_files,1) > 0 THEN
    INSERT INTO public.contract_workflow_history (
      contract_id,
      workflow_step_id,
      status,
      comments,
      transition_type,
      metadata,
      user_id
    ) VALUES (
      p_contract_id,
      COALESCE(v_prev_step, v_contract.current_step_id),
      'in_progress',
      'Archivos adjuntos al firmar',
      'manual',
      jsonb_build_object('is_comment', true, 'files_attached', p_files),
      v_user_id
    );
  END IF;

  RETURN QUERY SELECT true, 'Contrato activado exitosamente';
EXCEPTION WHEN OTHERS THEN
  RETURN QUERY SELECT false, 'Error al activar contrato: ' || SQLERRM;
END;
$function$

