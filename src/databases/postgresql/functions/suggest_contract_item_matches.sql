CREATE OR REPLACE FUNCTION public.suggest_contract_item_matches(p_invoice_item_legacy_id uuid, p_contract_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(contract_item_id uuid, contract_id uuid, product_name text, product_id uuid, currency text, price numeric, final_price numeric, confidence_score numeric, match_reason text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_item RECORD;
BEGIN
  SELECT 
    iil.*,
    il.invoice_currency,
    il.client_tax_id,
    il.legal_client_name
  INTO v_item
  FROM invoice_items_legacy iil
  JOIN invoices_legacy il ON il.id = iil.invoices_legacy_id
  WHERE iil.id = p_invoice_item_legacy_id;

  RETURN QUERY
  WITH contract_candidates AS (
    SELECT DISTINCT c.id as cid
    FROM contracts c
    LEFT JOIN client_entities ce ON ce.id = c.client_entity_id
    WHERE c.holding_id = get_current_user_holding_id()
      AND (p_contract_id IS NULL OR c.id = p_contract_id)
      AND (ce.tax_id = v_item.client_tax_id OR c.legal_representative_id = v_item.client_tax_id)
  )
  SELECT 
    ci.id,
    ci.contract_id,
    ci.product_name,
    ci.product_id,
    ci.currency,
    ci.price,
    ci.final_price,
    (
      CASE WHEN ci.currency = v_item.currency THEN 0.4 ELSE 0.0 END +
      (similarity(LOWER(ci.product_name), LOWER(v_item.description)) * 0.3) +
      CASE 
        WHEN ci.final_price = 0 THEN 0.0
        WHEN ABS(ci.final_price - v_item.total) / GREATEST(ci.final_price, v_item.total) < 0.05 THEN 0.3
        WHEN ABS(ci.final_price - v_item.total) / GREATEST(ci.final_price, v_item.total) < 0.15 THEN 0.2
        WHEN ABS(ci.final_price - v_item.total) / GREATEST(ci.final_price, v_item.total) < 0.30 THEN 0.1
        ELSE 0.0
      END
    ) as confidence_score,
    CONCAT(
      CASE WHEN ci.currency = v_item.currency THEN 'Same currency; ' ELSE '' END,
      'Description similarity: ', ROUND(similarity(LOWER(ci.product_name), LOWER(v_item.description))::numeric * 100), '%; ',
      'Amount diff: ', ROUND(ABS(ci.final_price - v_item.total)::numeric, 2)
    ) as match_reason
  FROM contract_items ci
  WHERE ci.contract_id IN (SELECT cid FROM contract_candidates)
  ORDER BY confidence_score DESC
  LIMIT 10;
END;
$function$

