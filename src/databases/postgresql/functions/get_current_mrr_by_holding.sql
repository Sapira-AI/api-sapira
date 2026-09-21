CREATE OR REPLACE FUNCTION public.get_current_mrr_by_holding(p_holding_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(holding_id uuid, total_mrr numeric, active_contracts integer, active_items integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  RETURN QUERY
  SELECT 
    v.holding_id,
    SUM(v.effective_mrr) as total_mrr,
    COUNT(DISTINCT v.contract_id)::INTEGER as active_contracts,
    COUNT(v.contract_item_id)::INTEGER as active_items
  FROM public.v_current_mrr v
  WHERE p_holding_id IS NULL OR v.holding_id = p_holding_id
  GROUP BY v.holding_id;
END;
$function$

