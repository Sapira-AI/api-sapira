CREATE OR REPLACE FUNCTION public.validate_legacy_reconciliation(p_invoice_legacy_id uuid)
 RETURNS TABLE(is_valid boolean, total_invoice numeric, total_matched numeric, total_confirmed numeric, unmatched_amount numeric, lines_count integer, lines_matched integer, lines_confirmed integer, warnings jsonb, blockers jsonb)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_result RECORD;
  v_warnings JSONB := '[]'::JSONB;
  v_blockers JSONB := '[]'::JSONB;
  v_is_valid BOOLEAN := true;
BEGIN
  SELECT 
    il.total_invoice_currency,
    COUNT(DISTINCT iil.id) as lines_total,
    COUNT(DISTINCT CASE WHEN EXISTS (
      SELECT 1 FROM invoice_items_legacy_match m 
      WHERE m.invoice_item_legacy_id = iil.id
    ) THEN iil.id END) as lines_with_match,
    COUNT(DISTINCT CASE WHEN EXISTS (
      SELECT 1 FROM invoice_items_legacy_match m 
      WHERE m.invoice_item_legacy_id = iil.id AND m.status = 'confirmed'
    ) THEN iil.id END) as lines_with_confirmed,
    COALESCE(SUM(
      (SELECT SUM(m.amount_invoice_currency) 
       FROM invoice_items_legacy_match m 
       WHERE m.invoice_item_legacy_id = iil.id)
    ), 0) as total_matched_amount,
    COALESCE(SUM(
      (SELECT SUM(m.amount_invoice_currency) 
       FROM invoice_items_legacy_match m 
       WHERE m.invoice_item_legacy_id = iil.id AND m.status = 'confirmed')
    ), 0) as total_confirmed_amount
  INTO v_result
  FROM invoices_legacy il
  LEFT JOIN invoice_items_legacy iil ON iil.invoices_legacy_id = il.id
  WHERE il.id = p_invoice_legacy_id
    AND il.holding_id = get_current_user_holding_id()
  GROUP BY il.id, il.total_invoice_currency;

  IF v_result.lines_with_confirmed < v_result.lines_total THEN
    v_blockers := v_blockers || jsonb_build_object(
      'code', 'INCOMPLETE_LINES',
      'message', format('Only %s of %s lines have confirmed matches', 
                        v_result.lines_with_confirmed, v_result.lines_total)
    );
    v_is_valid := false;
  END IF;

  IF ABS(v_result.total_confirmed_amount - v_result.total_invoice_currency) > 0.01 THEN
    IF ABS(v_result.total_confirmed_amount - v_result.total_invoice_currency) / v_result.total_invoice_currency > 0.02 THEN
      v_blockers := v_blockers || jsonb_build_object(
        'code', 'AMOUNT_MISMATCH',
        'message', format('Confirmed amount (%s) differs from invoice total (%s) by more than 2%%',
                          v_result.total_confirmed_amount, v_result.total_invoice_currency)
      );
      v_is_valid := false;
    ELSE
      v_warnings := v_warnings || jsonb_build_object(
        'code', 'MINOR_AMOUNT_DIFF',
        'message', format('Small difference between confirmed amount (%s) and invoice total (%s)',
                          v_result.total_confirmed_amount, v_result.total_invoice_currency)
      );
    END IF;
  END IF;

  IF EXISTS (
    SELECT 1 FROM invoice_items_legacy_match m
    JOIN invoice_items_legacy iil ON iil.id = m.invoice_item_legacy_id
    WHERE iil.invoices_legacy_id = p_invoice_legacy_id
      AND m.status = 'confirmed'
      AND (m.fx_contract_to_invoice IS NULL OR m.fx_contract_to_invoice <= 0)
  ) THEN
    v_blockers := v_blockers || jsonb_build_object(
      'code', 'INVALID_FX',
      'message', 'Some confirmed matches have invalid FX rates'
    );
    v_is_valid := false;
  END IF;

  RETURN QUERY SELECT 
    v_is_valid,
    v_result.total_invoice_currency,
    v_result.total_matched_amount,
    v_result.total_confirmed_amount,
    v_result.total_invoice_currency - v_result.total_confirmed_amount,
    v_result.lines_total,
    v_result.lines_with_match,
    v_result.lines_with_confirmed,
    v_warnings,
    v_blockers;
END;
$function$

