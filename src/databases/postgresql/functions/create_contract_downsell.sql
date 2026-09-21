CREATE OR REPLACE FUNCTION public.create_contract_downsell(p_contract_id uuid, p_effective_date date, p_items jsonb, p_scope text, p_reason text DEFAULT NULL::text, p_metadata jsonb DEFAULT '{}'::jsonb, p_approval_required boolean DEFAULT false)
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
  v_scope_enum public.amendment_scope_type;
BEGIN
  RAISE NOTICE 'DEPRECATED (2026-05-27): create_contract_downsell será eliminada en sesión futura. Use apply_contract_contraction(p_type=''DOWNSELL'') directamente. Ver docs/contratos/contraccion-unificada.md.';

  v_scope_enum := p_scope::public.amendment_scope_type;

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
    'DOWNSELL',
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
        (v_item->>'original_item_id')::uuid,
        (v_item->>'price_delta')::numeric,
        (v_item->>'quantity_delta')::numeric,
        (v_item->>'start_date_override')::date,
        (v_item->>'end_date_override')::date,
        COALESCE(
          NULLIF(v_item->>'scope', '')::public.amendment_scope_type,
          v_scope_enum
        ),
        v_item->>'notes',
        COALESCE(v_item->'item_metadata', '{}'::jsonb)
      );
    END LOOP;
  END IF;

  IF NOT p_approval_required THEN
    SELECT public.approve_contract_amendment(v_id, true, NULL) INTO v_result;
  END IF;

  RETURN v_id;
END;
$function$

