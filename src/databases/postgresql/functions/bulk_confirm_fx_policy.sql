CREATE OR REPLACE FUNCTION public.bulk_confirm_fx_policy(p_contract_ids uuid[], p_fx_policy text DEFAULT 'monthly_avg'::text)
 RETURNS TABLE(contract_id uuid, success boolean, message text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_user_id uuid;
  v_holding_id uuid;
  v_contract RECORD;
  v_cid uuid;
BEGIN
  -- Resolver usuario actual
  SELECT public.get_current_user_id() INTO v_user_id;
  IF v_user_id IS NULL THEN
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

  -- Validar política FX
  IF p_fx_policy NOT IN ('fixed_period', 'monthly_avg') THEN
    FOREACH v_cid IN ARRAY p_contract_ids LOOP
      contract_id := v_cid;
      success := false;
      message := 'Política FX inválida. Use fixed_period o monthly_avg';
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

      -- Verificar si ya está confirmado
      IF v_contract.fx_company_confirmed_at IS NOT NULL THEN
        contract_id := v_cid;
        success := false;
        message := 'La política FX ya está confirmada';
        RETURN NEXT;
        CONTINUE;
      END IF;

      -- Si es fixed_period, verificar que existan tasas configuradas
      IF p_fx_policy = 'fixed_period' THEN
        IF NOT EXISTS (
          SELECT 1 FROM public.contract_fx_period_rates 
          WHERE contract_id = v_cid
        ) THEN
          contract_id := v_cid;
          success := false;
          message := 'Política fixed_period requiere tasas FX configuradas';
          RETURN NEXT;
          CONTINUE;
        END IF;
      END IF;

      -- Actualizar contrato con política confirmada
      UPDATE public.contracts
      SET 
        fx_company_policy = p_fx_policy,
        fx_company_confirmed_at = now()
      WHERE id = v_cid;

      contract_id := v_cid;
      success := true;
      message := 'Política FX confirmada exitosamente';
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
$function$

