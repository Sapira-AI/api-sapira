CREATE OR REPLACE FUNCTION public.create_contract_churn(p_contract_id uuid, p_effective_date date, p_reason text DEFAULT NULL::text, p_risk_level text DEFAULT NULL::text, p_retention_action text DEFAULT NULL::text, p_notes text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_holding_id uuid; v_items jsonb; v_reason_id uuid;
BEGIN
  v_holding_id := public.get_contract_holding(p_contract_id);
  IF v_holding_id IS NULL THEN RAISE EXCEPTION 'Contrato no encontrado o sin permisos'; END IF;

  SELECT jsonb_agg(jsonb_build_object('item_id', id)) INTO v_items
  FROM public.contract_items
  WHERE contract_id = p_contract_id AND COALESCE(is_recurring, false) = true
    AND churn_date IS NULL AND COALESCE(categoria, '') NOT IN ('CHURN', 'DOWNSELL');

  IF v_items IS NULL OR jsonb_array_length(v_items) = 0 THEN
    RAISE EXCEPTION 'El contrato no tiene items recurrentes activos para cancelar';
  END IF;

  IF p_reason IS NOT NULL AND p_reason <> '' THEN
    SELECT id INTO v_reason_id FROM public.churn_reasons
    WHERE holding_id = v_holding_id AND is_active AND lower(name) = lower(p_reason) LIMIT 1;
  END IF;

  RETURN public.apply_contract_contraction(
    p_contract_id, 'CHURN', v_items, p_effective_date, v_reason_id,
    COALESCE(NULLIF(p_notes, ''), NULLIF(p_retention_action, ''), NULLIF(p_risk_level, ''))
  );
END;
$function$

