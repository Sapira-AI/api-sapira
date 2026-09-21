CREATE OR REPLACE FUNCTION public.execute_auto_renewal_for_item(p_item_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_item RECORD;
  v_renewal_date date;
  v_renewal_term integer;
  v_renewal_result jsonb;
BEGIN
  -- Obtener el item
  SELECT ci.*, c.id as contract_id
  INTO v_item
  FROM public.contract_items ci
  JOIN public.contracts c ON ci.contract_id = c.id
  WHERE ci.id = p_item_id;
  
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Item % no encontrado', p_item_id;
  END IF;
  
  IF v_item.auto_renew = false THEN
    RAISE EXCEPTION 'Item % no tiene auto_renew habilitado', p_item_id;
  END IF;
  
  IF v_item.end_date IS NULL THEN
    RAISE EXCEPTION 'Item % no tiene end_date definido', p_item_id;
  END IF;
  
  IF v_item.renewed_by_item_id IS NOT NULL THEN
    RAISE EXCEPTION 'Item % ya fue renovado', p_item_id;
  END IF;
  
  -- Calcular fecha de renovación
  v_renewal_date := (v_item.end_date + interval '1 day')::date;
  v_renewal_term := COALESCE(v_item.auto_renew_term_months, v_item.term_months, 12);
  
  -- Ejecutar renovación
  SELECT public.create_contract_renewal(
    p_contract_id := v_item.contract_id,
    p_effective_date := v_renewal_date,
    p_term_months := v_renewal_term,
    p_new_end_date := NULL,
    p_copy_items := true,
    p_metadata := jsonb_build_object(
      'original_item_id', v_item.id,
      'billing_frequency', v_item.billing_frequency,
      'billing_method', v_item.billing_method,
      'auto_renewal', true,
      'manual_execution', true,
      'auto_renewal_executed_at', NOW()
    ),
    p_approval_required := false
  ) INTO v_renewal_result;
  
  -- Marcar como auto-renovado
  UPDATE public.contract_items
  SET auto_renewed_at = NOW()
  WHERE id = p_item_id;
  
  RETURN jsonb_build_object(
    'success', true,
    'item_id', p_item_id,
    'renewal_date', v_renewal_date,
    'renewal_term', v_renewal_term,
    'result', v_renewal_result
  );
END;
$function$

