CREATE OR REPLACE FUNCTION public.invoice_bulk_update_terms(p_contract_id uuid, p_invoice_ids uuid[], p_terms text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_holding_id uuid := get_current_user_holding_id();
  v_user_id uuid := auth.uid();
  v_ids uuid[]; v_old jsonb; v_count int := 0;
  v_terms text := NULLIF(TRIM(p_terms), '');
BEGIN
  IF NOT user_has_permission('EDIT_FACTURACION') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Sin permiso EDIT_FACTURACION'); END IF;
  IF p_contract_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'p_contract_id es requerido'); END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_contract_id::text, 0));
  IF p_invoice_ids IS NULL THEN
    SELECT array_agg(id) INTO v_ids FROM invoices
    WHERE contract_id = p_contract_id AND holding_id = v_holding_id
      AND status = 'Por Emitir' AND COALESCE(is_active, true) = true;
  ELSE
    SELECT array_agg(id) INTO v_ids FROM invoices
    WHERE id = ANY(p_invoice_ids) AND contract_id = p_contract_id
      AND holding_id = v_holding_id AND status = 'Por Emitir';
  END IF;
  IF v_ids IS NULL OR array_length(v_ids, 1) IS NULL THEN
    RETURN jsonb_build_object('success', true, 'updated_count', 0,
      'invoice_ids', '[]'::jsonb, 'note', 'No hay facturas Por Emitir que cumplan el criterio'); END IF;
  WITH locked AS (SELECT id, invoice_terms_and_conditions FROM invoices WHERE id = ANY(v_ids) FOR UPDATE)
  SELECT jsonb_agg(jsonb_build_object('id', id, 'terms', invoice_terms_and_conditions))
    INTO v_old FROM locked;
  UPDATE invoices SET invoice_terms_and_conditions = v_terms
  WHERE id = ANY(v_ids) AND status = 'Por Emitir';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  INSERT INTO invoice_restructure_log(holding_id, contract_id, actor_user_id, action, payload)
  VALUES (v_holding_id, p_contract_id, v_user_id, 'update_terms',
    jsonb_build_object('scope', CASE WHEN p_invoice_ids IS NULL THEN 'all_pending' ELSE 'selected' END,
      'new_terms', v_terms, 'new_terms_normalized_from_empty', p_terms IS NOT NULL AND v_terms IS NULL,
      'invoice_count', v_count, 'old', v_old));
  RETURN jsonb_build_object('success', true, 'updated_count', v_count, 'invoice_ids', to_jsonb(v_ids));
END; $function$

