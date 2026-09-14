CREATE OR REPLACE FUNCTION public.search_contracts_by_client_identity(p_tax_id text, p_legal_name text DEFAULT NULL::text, p_only_legacy boolean DEFAULT false)
 RETURNS TABLE(contract_id uuid, contract_number text, client_id uuid, client_name text, contract_currency text, total_value numeric, status text, is_legacy boolean, legacy_status text, similarity_score numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  RETURN QUERY
  SELECT 
    c.id,
    c.contract_number,
    c.client_id,
    cl.name_commercial,
    c.contract_currency,
    c.total_value,
    c.status,
    COALESCE(c.is_legacy, false),
    c.legacy_status,
    CASE 
      WHEN p_legal_name IS NULL THEN 1.0
      ELSE similarity(LOWER(c.legal_client_name), LOWER(p_legal_name))
    END as similarity_score
  FROM contracts c
  LEFT JOIN clients cl ON cl.id = c.client_id
  LEFT JOIN client_entities ce ON ce.id = c.client_entity_id
  WHERE c.holding_id = get_current_user_holding_id()
    AND (
      ce.tax_id = p_tax_id 
      OR c.legal_representative_id = p_tax_id
    )
    AND (NOT p_only_legacy OR COALESCE(c.is_legacy, false) = true)
  ORDER BY similarity_score DESC, c.created_at DESC;
END;
$function$

