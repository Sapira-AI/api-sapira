CREATE OR REPLACE FUNCTION public.recalc_revenue_for_contract(p_contract_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_holding_id uuid := public.get_current_user_holding_id();
  v_deleted int := 0;
BEGIN
  -- Validar que el contrato pertenece al holding
  IF NOT EXISTS (SELECT 1 FROM public.contracts c WHERE c.id = p_contract_id AND c.holding_id = v_holding_id) THEN
    RAISE EXCEPTION 'Contrato no encontrado o sin permisos';
  END IF;

  -- El consolidado de revenue se calcula desde contract_items (funciones revenue_consolidated_*), 
  -- por lo que basta con limpiar programación editable para regenerar desde front
  DELETE FROM public.contract_invoices
  WHERE contract_id = p_contract_id AND is_editable = true;

  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  RETURN jsonb_build_object('ok', true, 'deleted_schedules', v_deleted);
END
$function$

