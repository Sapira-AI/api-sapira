CREATE OR REPLACE FUNCTION public.get_items_pending_auto_renewal(p_days_before_expiry integer DEFAULT 90)
 RETURNS TABLE(item_id uuid, contract_id uuid, product_name text, end_date date, days_until_expiry integer, auto_renew_term_months integer, holding_id uuid)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT 
    ci.id as item_id,
    ci.contract_id,
    ci.product_name,
    ci.end_date,
    (ci.end_date - CURRENT_DATE)::integer as days_until_expiry,
    COALESCE(ci.auto_renew_term_months, ci.term_months, 12) as auto_renew_term_months,
    ci.holding_id
  FROM public.contract_items ci
  WHERE ci.auto_renew = true
    AND ci.end_date IS NOT NULL
    AND ci.end_date <= (CURRENT_DATE + (p_days_before_expiry || ' days')::interval)
    AND ci.end_date > CURRENT_DATE
    AND ci.renewed_by_item_id IS NULL
  ORDER BY ci.end_date ASC;
$function$

