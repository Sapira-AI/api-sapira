CREATE OR REPLACE FUNCTION public.invoice_reassign_entity(p_contract_id uuid, p_invoice_ids uuid[], p_new_client_entity_id uuid, p_new_company_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_holding_id uuid := get_current_user_holding_id();
  v_user_id uuid := auth.uid();
  v_contract_client uuid;
  v_company_legal_name text; v_company_tax_id text; v_company_address text;
  v_count int := 0; v_failed jsonb := '[]'::jsonb; v_old jsonb;
BEGIN
  IF NOT user_has_permission('EDIT_FACTURACION') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Sin permiso EDIT_FACTURACION'); END IF;
  IF p_contract_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'p_contract_id es requerido'); END IF;
  IF p_invoice_ids IS NULL OR array_length(p_invoice_ids, 1) IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'p_invoice_ids no puede ser vacío'); END IF;
  IF p_new_client_entity_id IS NULL AND p_new_company_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Debe proveer al menos un cambio (client_entity o company)'); END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_contract_id::text, 0));
  SELECT client_id INTO v_contract_client FROM contracts
  WHERE id = p_contract_id AND holding_id = v_holding_id;
  IF v_contract_client IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Contrato no encontrado'); END IF;
  IF p_new_client_entity_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM client_entity_clients
       WHERE client_entity_id = p_new_client_entity_id
         AND client_id = v_contract_client AND holding_id = v_holding_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'La razón social seleccionada no está vinculada al cliente del contrato'); END IF;
  IF p_new_company_id IS NOT NULL THEN
    SELECT legal_name, tax_id, legal_address INTO v_company_legal_name, v_company_tax_id, v_company_address
    FROM companies WHERE id = p_new_company_id AND holding_id = v_holding_id;
    IF v_company_legal_name IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'Compañía no encontrada en el holding'); END IF;
  END IF;
  WITH locked AS (
    SELECT id, client_entity_id, company_id, issuer_legal_name, issuer_tax_id, issuer_address
    FROM invoices WHERE id = ANY(p_invoice_ids) AND contract_id = p_contract_id
      AND holding_id = v_holding_id AND status = 'Por Emitir' FOR UPDATE)
  SELECT jsonb_agg(jsonb_build_object('id', id, 'client_entity_id', client_entity_id,
    'company_id', company_id, 'issuer_legal_name', issuer_legal_name,
    'issuer_tax_id', issuer_tax_id, 'issuer_address', issuer_address)) INTO v_old FROM locked;
  UPDATE invoices SET
    client_entity_id = COALESCE(p_new_client_entity_id, client_entity_id),
    company_id = COALESCE(p_new_company_id, company_id),
    issuer_legal_name = CASE WHEN p_new_company_id IS NOT NULL THEN v_company_legal_name ELSE issuer_legal_name END,
    issuer_tax_id = CASE WHEN p_new_company_id IS NOT NULL THEN v_company_tax_id ELSE issuer_tax_id END,
    issuer_address = CASE WHEN p_new_company_id IS NOT NULL THEN v_company_address ELSE issuer_address END
  WHERE id = ANY(p_invoice_ids) AND contract_id = p_contract_id
    AND holding_id = v_holding_id AND status = 'Por Emitir';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('invoice_id', id, 'reason',
    CASE WHEN contract_id <> p_contract_id THEN 'Contrato distinto'
         WHEN holding_id <> v_holding_id THEN 'Holding distinto'
         WHEN status <> 'Por Emitir' THEN 'Status=' || status
         ELSE 'unknown' END)), '[]'::jsonb) INTO v_failed
  FROM invoices WHERE id = ANY(p_invoice_ids)
    AND (contract_id <> p_contract_id OR holding_id <> v_holding_id OR status <> 'Por Emitir');
  INSERT INTO invoice_restructure_log(holding_id, contract_id, actor_user_id, action, payload)
  VALUES (v_holding_id, p_contract_id, v_user_id, 'reassign_entity',
    jsonb_build_object('new_client_entity_id', p_new_client_entity_id,
      'new_company_id', p_new_company_id, 'updated_count', v_count, 'old', v_old, 'failed', v_failed));
  RETURN jsonb_build_object('success', true, 'updated_count', v_count, 'failed', v_failed);
END; $function$

