CREATE OR REPLACE FUNCTION public.auto_expire_contracts()
 RETURNS TABLE(expired_count integer, expired_contract_ids uuid[])
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_contract RECORD;
  v_count integer := 0;
  v_ids uuid[] := '{}';
BEGIN
  -- Buscar contratos activos donde TODOS los items recurrentes ya vencieron
  -- y ninguno fue renovado (renewed_by_item_id IS NULL)
  FOR v_contract IN
    SELECT c.id, c.holding_id
    FROM public.contracts c
    WHERE c.status = 'Activo'
      -- Tiene al menos un item recurrente
      AND EXISTS (
        SELECT 1 FROM public.contract_items ci
        WHERE ci.contract_id = c.id
          AND ci.is_recurring = true
      )
      -- TODOS los items recurrentes ya vencieron y no fueron renovados
      AND NOT EXISTS (
        SELECT 1 FROM public.contract_items ci
        WHERE ci.contract_id = c.id
          AND ci.is_recurring = true
          AND ci.renewed_by_item_id IS NULL
          AND (ci.end_date IS NULL OR ci.end_date >= CURRENT_DATE)
      )
      -- No tiene un amendment RENEWAL pendiente
      AND NOT EXISTS (
        SELECT 1 FROM public.contract_amendments ca
        WHERE ca.contract_id = c.id
          AND ca.type = 'RENEWAL'
          AND ca.status = 'Pending'
      )
  LOOP
    -- Actualizar estado del contrato
    UPDATE public.contracts
    SET status = 'Expirado'
    WHERE id = v_contract.id;

    -- Registrar lifecycle event
    INSERT INTO public.contract_lifecycle_events (
      contract_id, event_type, event_status, title, description,
      effective_date, holding_id, metadata
    ) VALUES (
      v_contract.id,
      'status_change',
      'completed',
      'Contrato Expirado',
      'Contrato marcado como expirado automáticamente — todos los items recurrentes han vencido sin renovación.',
      CURRENT_DATE,
      v_contract.holding_id,
      jsonb_build_object('auto_expired', true, 'expired_at', now())
    );

    v_count := v_count + 1;
    v_ids := v_ids || v_contract.id;
  END LOOP;

  RETURN QUERY SELECT v_count, v_ids;
END;
$function$

