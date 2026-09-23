CREATE OR REPLACE FUNCTION public.activate_legacy_contract(p_contract_id uuid, p_options jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_holding_id uuid;
  v_contract record;
  v_validation jsonb;
  v_force boolean;
  v_generate_schedule boolean;
  v_load_opening_balances boolean;
  v_can_activate boolean;
  v_user_id uuid;
  v_activated boolean := false;
  v_message text;
BEGIN
  -- =====================================================
  -- 1. Leer opciones
  -- =====================================================
  v_force := COALESCE((p_options->>'force')::boolean, false);
  v_generate_schedule := COALESCE((p_options->>'generate_schedule')::boolean, true);
  v_load_opening_balances := COALESCE((p_options->>'load_opening_balances')::boolean, false);
  
  -- Obtener usuario actual
  v_user_id := public.get_current_user_id();

  -- =====================================================
  -- 2. Validar contrato
  -- =====================================================
  v_validation := public.validate_legacy_activation(p_contract_id);
  v_can_activate := (v_validation->>'can_activate')::boolean;

  -- Si no se puede activar y no se fuerza, retornar sin activar
  IF NOT v_force AND NOT v_can_activate THEN
    RETURN jsonb_build_object(
      'activated', false,
      'contract_id', p_contract_id,
      'validation', v_validation,
      'options', p_options,
      'message', 'Contract cannot be activated. Check validation blockers.'
    );
  END IF;

  -- =====================================================
  -- 3. Obtener datos del contrato
  -- =====================================================
  SELECT 
    c.holding_id,
    c.legacy_cutoff_date,
    c.is_legacy,
    c.status
  INTO v_contract
  FROM contracts c
  WHERE c.id = p_contract_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Contract not found';
  END IF;

  v_holding_id := v_contract.holding_id;

  -- Verificar permisos RLS
  IF v_holding_id != public.get_user_holding_id() THEN
    RAISE EXCEPTION 'Access denied to this contract';
  END IF;

  -- =====================================================
  -- 4. Activar contrato (transacción completa)
  -- =====================================================
  BEGIN
    -- Actualizar estado del contrato
    UPDATE contracts
    SET 
      is_legacy = false,
      legacy_status = 'activated',
      status = 'Activo',
      workflow_completed_at = NOW(),
      updated_at = NOW()
    WHERE id = p_contract_id
      AND holding_id = v_holding_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Failed to update contract status';
    END IF;

    v_activated := true;
    v_message := 'Contract successfully activated';

    -- =====================================================
    -- 5. Generar revenue schedule (si está habilitado)
    -- =====================================================
    IF v_generate_schedule THEN
      BEGIN
        -- Llamar revenue_schedule_rebuild con fecha mínima = legacy_cutoff_date
        -- La función acepta p_from_month para reconstruir desde esa fecha en adelante
        IF v_contract.legacy_cutoff_date IS NOT NULL THEN
          PERFORM public.revenue_schedule_rebuild(
            p_contract_id, 
            v_contract.legacy_cutoff_date
          );
          v_message := v_message || '. Revenue schedule generated from cutoff date.';
        ELSE
          -- Si no hay cutoff_date, generar schedule completo
          PERFORM public.revenue_schedule_rebuild(p_contract_id, NULL);
          v_message := v_message || '. Revenue schedule generated (full rebuild).';
        END IF;
      EXCEPTION WHEN OTHERS THEN
        -- No fallar la activación si falla el schedule
        RAISE WARNING 'Revenue schedule generation failed: %', SQLERRM;
        v_message := v_message || '. Warning: Revenue schedule generation failed.';
      END;
    END IF;

    -- =====================================================
    -- 6. Cargar saldos de apertura (si está habilitado)
    -- =====================================================
    -- NOTA: Esta funcionalidad está RESERVADA para futuras implementaciones.
    -- 
    -- Actualmente, revenue_schedule_rebuild ya maneja correctamente:
    -- 1. Calcula v_billed_cum_initial desde facturas reales con issue_date < cutoff_date
    -- 2. El trigger assign_momentum_to_revenue_schedule asigna momentum automáticamente
    --    basado en contract_items.categoria (NEW/UPSELL/RENEWAL/etc en primer período, BOP después)
    -- 3. Los balances (deferred/unbilled) se calculan correctamente con las fórmulas Excel
    --
    -- Si en el futuro necesitamos cargar saldos de apertura desde facturas legacy,
    -- la estrategia correcta sería:
    -- 1. Migrar facturas legacy a tablas regulares (invoices/invoice_items)
    -- 2. Dejar que revenue_schedule_rebuild las procese automáticamente
    -- 3. NO insertar manualmente en revenue_schedule_monthly
    --
    IF v_load_opening_balances THEN
      -- TODO: Implementar migración de facturas legacy a tablas regulares
      -- Por ahora, esta opción no hace nada
      RAISE NOTICE 'load_opening_balances is not yet implemented. Use generate_schedule instead.';
      v_message := v_message || '. Note: Opening balances feature not yet implemented.';
    END IF;

    -- =====================================================
    -- 7. Registrar evento en contract_lifecycle_events
    -- =====================================================
    BEGIN
      INSERT INTO contract_lifecycle_events (
        contract_id,
        holding_id,
        event_type,
        event_subtype,
        event_status,
        title,
        description,
        effective_date,
        created_by,
        completed_at,
        metadata
      ) VALUES (
        p_contract_id,
        v_holding_id,
        'ACTIVATION',
        'legacy_activation',
        'completed',
        'Legacy Contract Activated',
        format('Contract activated from legacy status. Reconciliation: %s%%', 
          COALESCE((v_validation->>'reconciliation_pct')::text, '0')
        ),
        CURRENT_DATE,
        v_user_id,
        NOW(),
        jsonb_build_object(
          'forced', v_force,
          'generate_schedule', v_generate_schedule,
          'load_opening_balances', v_load_opening_balances,
          'reconciliation_pct', v_validation->>'reconciliation_pct',
          'blockers_count', jsonb_array_length(v_validation->'blockers'),
          'warnings_count', jsonb_array_length(v_validation->'warnings')
        )
      );
    EXCEPTION WHEN OTHERS THEN
      -- No fallar la activación si falla el registro del evento
      RAISE WARNING 'Failed to create lifecycle event: %', SQLERRM;
    END;

  EXCEPTION WHEN OTHERS THEN
    -- Rollback automático por la transacción
    RAISE EXCEPTION 'Contract activation failed: %', SQLERRM;
  END;

  -- =====================================================
  -- Retornar resultado
  -- =====================================================
  RETURN jsonb_build_object(
    'activated', v_activated,
    'contract_id', p_contract_id,
    'validation', v_validation,
    'options', p_options,
    'message', v_message
  );
END;
$function$;

COMMENT ON FUNCTION public."activate_legacy_contract"(p_contract_id uuid, p_options jsonb) IS 'Activa un contrato legacy después de validación. Opcionalmente genera revenue schedule post-cutoff. Soporta activación forzada para casos excepcionales.';
