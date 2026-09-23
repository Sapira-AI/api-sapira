CREATE OR REPLACE FUNCTION public.bulk_activate_contracts(p_contract_ids uuid[], p_booking_mode text DEFAULT 'keep_existing'::text, p_booking_date date DEFAULT NULL::date, p_comments text DEFAULT NULL::text)
 RETURNS TABLE(contract_id uuid, success boolean, message text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_user_id uuid;
  v_holding_id uuid;
  v_contract RECORD;
  v_booking date;
  v_prev_step uuid;
  v_cid uuid;
BEGIN
  -- Resolver usuario actual
  SELECT public.get_current_user_id() INTO v_user_id;
  IF v_user_id IS NULL THEN
    -- Retornar error para todos los contratos
    FOREACH v_cid IN ARRAY p_contract_ids LOOP
      contract_id := v_cid;
      success := false;
      message := 'Usuario no autenticado';
      RETURN NEXT;
    END LOOP;
    RETURN;
  END IF;

  -- Resolver holding del usuario
  SELECT public.get_current_user_holding_id() INTO v_holding_id;
  IF v_holding_id IS NULL THEN
    FOREACH v_cid IN ARRAY p_contract_ids LOOP
      contract_id := v_cid;
      success := false;
      message := 'Usuario sin holding asociado';
      RETURN NEXT;
    END LOOP;
    RETURN;
  END IF;

  -- Procesar cada contrato
  FOREACH v_cid IN ARRAY p_contract_ids LOOP
    BEGIN
      -- Obtener datos del contrato
      SELECT c.* INTO v_contract
      FROM public.contracts c
      WHERE c.id = v_cid AND c.holding_id = v_holding_id;

      IF NOT FOUND THEN
        contract_id := v_cid;
        success := false;
        message := 'Contrato no encontrado o sin permisos';
        RETURN NEXT;
        CONTINUE;
      END IF;

      -- Validar estado actual
      IF v_contract.status = 'Activo' THEN
        contract_id := v_cid;
        success := false;
        message := 'El contrato ya está activo';
        RETURN NEXT;
        CONTINUE;
      END IF;

      IF v_contract.status IN ('Cancelado', 'Expirado') THEN
        contract_id := v_cid;
        success := false;
        message := 'No se puede activar un contrato ' || v_contract.status;
        RETURN NEXT;
        CONTINUE;
      END IF;

      -- Validar FX policy si aplica
      IF v_contract.contract_currency IS DISTINCT FROM (
        SELECT currency FROM public.companies WHERE id = v_contract.company_id
      ) THEN
        IF v_contract.fx_company_confirmed_at IS NULL THEN
          contract_id := v_cid;
          success := false;
          message := 'FX policy no configurada para este contrato';
          RETURN NEXT;
          CONTINUE;
        END IF;
      END IF;

      -- Guardar step anterior para historial
      v_prev_step := v_contract.current_step_id;

      -- Resolver booking_date según modo
      v_booking := CASE 
        WHEN lower(coalesce(p_booking_mode, 'keep_existing')) = 'set_date' AND p_booking_date IS NOT NULL 
          THEN p_booking_date
        WHEN lower(coalesce(p_booking_mode, 'keep_existing')) = 'today' 
          THEN CURRENT_DATE
        ELSE COALESCE(v_contract.booking_date, CURRENT_DATE)
      END;

      -- Actualizar contrato a Activo
      UPDATE public.contracts
      SET 
        status = 'Activo',
        current_step_id = NULL,
        workflow_completed_at = now(),
        booking_date = v_booking
      WHERE id = v_cid;

      -- Registrar historial de workflow
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
        v_cid,
        v_prev_step,
        'completed',
        COALESCE(p_comments, 'Contrato activado mediante activación masiva'),
        'manual',
        jsonb_build_object(
          'bulk_activation', true,
          'previous_step_id', v_prev_step,
          'booking_mode', p_booking_mode,
          'timestamp', now()
        ),
        v_user_id,
        now()
      );

      contract_id := v_cid;
      success := true;
      message := 'Contrato activado exitosamente';
      RETURN NEXT;

    EXCEPTION WHEN OTHERS THEN
      contract_id := v_cid;
      success := false;
      message := 'Error: ' || SQLERRM;
      RETURN NEXT;
    END;
  END LOOP;

  RETURN;
END;
$function$;

COMMENT ON FUNCTION public."bulk_activate_contracts"(p_contract_ids uuid[], p_booking_mode text, p_booking_date date, p_comments text) IS 'Activa múltiples contratos en una sola operación. 
Modos de booking_date: keep_existing (usa fecha existente o hoy), set_date (usa fecha proporcionada), today (usa fecha actual).
Valida permisos, estado y FX policy para cada contrato.';
