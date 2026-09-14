CREATE OR REPLACE FUNCTION public.get_contract_reconciliation(p_contract_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(contract_id uuid, contract_number text, contract_total numeric, contract_currency text, invoices_total numeric, invoices_count integer, difference numeric, is_balanced boolean, contract_status text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_holding_id UUID;
BEGIN
  -- Get user holding
  SELECT public.get_current_user_holding_id() INTO v_holding_id;
  IF v_holding_id IS NULL THEN
    RAISE EXCEPTION 'Usuario sin holding asociado';
  END IF;

  RETURN QUERY
  WITH contract_totals AS (
    SELECT 
      c.id as contract_id,
      c.contract_number,
      c.status as contract_status,
      COALESCE(SUM(ci.final_price), 0) as contract_total,
      COALESCE(MAX(ci.currency), 'USD') as contract_currency
    FROM contracts c
    LEFT JOIN contract_items ci ON c.id = ci.contract_id
    WHERE c.holding_id = v_holding_id
      AND (p_contract_id IS NULL OR c.id = p_contract_id)
    GROUP BY c.id, c.contract_number, c.status
  ),
  invoice_totals AS (
    SELECT 
      i.contract_id,
      COALESCE(SUM(i.amount_contract_currency), 0) as invoices_total,
      COUNT(i.id) as invoices_count
    FROM invoices i
    WHERE i.holding_id = v_holding_id
      AND i.contract_id IS NOT NULL
      AND (p_contract_id IS NULL OR i.contract_id = p_contract_id)
    GROUP BY i.contract_id
  )
  SELECT 
    ct.contract_id,
    ct.contract_number,
    ct.contract_total,
    ct.contract_currency,
    COALESCE(it.invoices_total, 0) as invoices_total,
    COALESCE(it.invoices_count, 0) as invoices_count,
    ct.contract_total - COALESCE(it.invoices_total, 0) as difference,
    ABS(ct.contract_total - COALESCE(it.invoices_total, 0)) < 0.01 as is_balanced,
    ct.contract_status
  FROM contract_totals ct
  LEFT JOIN invoice_totals it ON ct.contract_id = it.contract_id
  ORDER BY ct.contract_number;
END;
$function$

