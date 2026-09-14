CREATE OR REPLACE FUNCTION public.register_item_non_renewal(p_contract_id uuid, p_item_ids uuid[], p_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_holding_id uuid; v_items jsonb; v_min_end_date date;
  v_effective date; v_type text; v_total_recurring int; v_reason_id uuid;
BEGIN
  v_holding_id := public.get_contract_holding(p_contract_id);
  IF v_holding_id IS NULL THEN RAISE EXCEPTION 'Contrato no encontrado o sin permisos'; END IF;

  SELECT jsonb_agg(jsonb_build_object('item_id', id)), MIN(end_date)
  INTO v_items, v_min_end_date FROM public.contract_items
  WHERE id = ANY(p_item_ids) AND contract_id = p_contract_id;

  IF v_items IS NULL THEN RAISE EXCEPTION 'No se encontraron items válidos en p_item_ids'; END IF;
  IF v_min_end_date IS NULL THEN RAISE EXCEPTION 'Items sin end_date no pueden procesarse por no-renovación'; END IF;

  v_effective := (v_min_end_date + INTERVAL '1 day')::date;

  SELECT COUNT(*) INTO v_total_recurring FROM public.contract_items
  WHERE contract_id = p_contract_id AND COALESCE(is_recurring, false) = true
    AND churn_date IS NULL AND COALESCE(categoria, '') NOT IN ('CHURN', 'DOWNSELL');

  v_type := CASE WHEN array_length(p_item_ids, 1) >= v_total_recurring THEN 'CHURN' ELSE 'DOWNSELL' END;

  IF p_reason IS NOT NULL AND p_reason <> '' THEN
    SELECT id INTO v_reason_id FROM public.churn_reasons
    WHERE holding_id = v_holding_id AND is_active AND lower(name) = lower(p_reason) LIMIT 1;
  END IF;

  RETURN public.apply_contract_contraction(p_contract_id, v_type, v_items, v_effective, v_reason_id, p_reason);
END;
$function$

