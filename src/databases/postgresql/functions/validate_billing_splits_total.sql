CREATE OR REPLACE FUNCTION public.validate_billing_splits_total(p_contract_id uuid, p_date date)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_total NUMERIC;
BEGIN
  SELECT COALESCE(SUM(percent_allocation), 0) INTO v_total
  FROM contract_billing_splits
  WHERE contract_id = p_contract_id
    AND effective_from <= p_date
    AND (effective_to IS NULL OR effective_to >= p_date);
    
  RETURN v_total = 100;
END;
$function$

