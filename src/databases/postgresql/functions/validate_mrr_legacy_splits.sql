CREATE OR REPLACE FUNCTION public.validate_mrr_legacy_splits(p_invoice_item_legacy_id uuid, p_period_month date)
 RETURNS TABLE(is_valid boolean, source_subtotal numeric, allocated_sum numeric, difference numeric)
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_source_subtotal numeric;
  v_allocated_sum numeric;
BEGIN
  -- Obtener subtotal original
  SELECT subtotal INTO v_source_subtotal
  FROM mrr_legacy
  WHERE invoice_item_legacy_id = p_invoice_item_legacy_id
    AND period_month = p_period_month
  LIMIT 1;
  
  -- Sumar allocated de todos los splits
  SELECT SUM(allocated_invoice_currency) INTO v_allocated_sum
  FROM mrr_legacy
  WHERE invoice_item_legacy_id = p_invoice_item_legacy_id
    AND period_month = p_period_month;
  
  RETURN QUERY SELECT 
    (v_source_subtotal = v_allocated_sum) as is_valid,
    v_source_subtotal,
    v_allocated_sum,
    (v_source_subtotal - v_allocated_sum) as difference;
END;
$function$;

COMMENT ON FUNCTION public."validate_mrr_legacy_splits"(p_invoice_item_legacy_id uuid, p_period_month date) IS 'Valida que la suma de allocated_invoice_currency de todos los splits sea igual al subtotal original';
