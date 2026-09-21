CREATE OR REPLACE FUNCTION public.create_contract_upsell(p_contract_id uuid, p_items jsonb, p_effective_date date, p_reason text DEFAULT NULL::text, p_metadata jsonb DEFAULT '{}'::jsonb, p_approval_required boolean DEFAULT false)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_id uuid;
  v_holding uuid;
  v_user uuid;
  v_item jsonb;
  v_result jsonb;
  v_total_delta numeric := 0;
  v_items_summary jsonb := '[]'::jsonb;
BEGIN
  SELECT public.get_contract_holding(p_contract_id) INTO v_holding;
  IF v_holding IS NULL THEN
    RAISE EXCEPTION 'Contrato no encontrado';
  END IF;

  SELECT public.get_current_user_id() INTO v_user;

  INSERT INTO public.contract_amendments(
    contract_id, holding_id, type, status, effective_date, reason, metadata, approval_required, requested_by
  ) VALUES (
    p_contract_id,
    v_holding,
    'UPSELL',
    CASE WHEN p_approval_required THEN 'Pending' ELSE 'Approved' END,
    p_effective_date,
    p_reason,
    COALESCE(p_metadata, '{}'::jsonb),
    p_approval_required,
    v_user
  ) RETURNING id INTO v_id;

  IF p_items IS NOT NULL THEN
    FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
      INSERT INTO public.contract_amendment_items(
        amendment_id, holding_id, original_item_id, price_delta, quantity_delta,
        start_date_override, end_date_override, scope, notes, item_metadata
      ) VALUES (
        v_id,
        v_holding,
        NULLIF(v_item->>'original_item_id', '')::uuid,
        (v_item->>'price_delta')::numeric,
        (v_item->>'quantity_delta')::numeric,
        NULLIF(v_item->>'start_date_override', '')::date,
        NULLIF(v_item->>'end_date_override', '')::date,
        NULLIF(v_item->>'scope', '')::amendment_scope_type,
        v_item->>'notes',
        COALESCE(v_item->'item_metadata', '{}'::jsonb)
      );
      
      -- Acumular delta para el resumen
      v_total_delta := v_total_delta + COALESCE((v_item->>'price_delta')::numeric, 0);
      v_items_summary := v_items_summary || jsonb_build_array(
        jsonb_build_object(
          'original_item_id', v_item->>'original_item_id',
          'price_delta', v_item->>'price_delta'
        )
      );
    END LOOP;
  END IF;

  IF NOT p_approval_required THEN
    v_result := public.approve_contract_amendment(v_id, true, 'Auto-aprobado');
    
    -- NUEVO: Registrar evento en el historial del ciclo de vida
    -- La función approve_contract_amendment ya llama a log_lifecycle_event,
    -- pero solo cuando hay aprobación manual. Para auto-aprobaciones,
    -- el evento ya se registra dentro de approve_contract_amendment.
    -- No necesitamos duplicar la llamada aquí.
  END IF;

  RETURN v_id;
END;
$function$

