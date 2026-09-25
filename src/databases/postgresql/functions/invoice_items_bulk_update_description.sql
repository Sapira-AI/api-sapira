CREATE OR REPLACE FUNCTION public.invoice_items_bulk_update_description(p_contract_id uuid, p_updates jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_holding_id uuid := get_current_user_holding_id();
  v_user_id uuid := auth.uid();
  v_update jsonb; v_count int := 0; v_failed jsonb := '[]'::jsonb; v_affected boolean;
BEGIN
  IF NOT user_has_permission('EDIT_FACTURACION') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Sin permiso EDIT_FACTURACION');
  END IF;
  IF p_contract_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'p_contract_id es requerido');
  END IF;
  IF p_updates IS NULL OR jsonb_typeof(p_updates) <> 'array' OR jsonb_array_length(p_updates) = 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'p_updates debe ser un array no vacío');
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_contract_id::text, 0));
  FOR v_update IN SELECT * FROM jsonb_array_elements(p_updates)
  LOOP
    WITH matched AS (
      UPDATE invoice_items ii
        SET description = v_update->>'description', updated_at = now()
      FROM invoices i
      WHERE ii.id = (v_update->>'invoice_item_id')::uuid
        AND ii.invoice_id = i.id AND i.contract_id = p_contract_id
        AND i.holding_id = v_holding_id AND i.status = 'Por Emitir'
      RETURNING ii.id
    )
    SELECT EXISTS (SELECT 1 FROM matched) INTO v_affected;
    IF v_affected THEN v_count := v_count + 1;
    ELSE v_failed := v_failed || jsonb_build_object('invoice_item_id', v_update->>'invoice_item_id',
      'reason', 'not found, wrong contract, or invoice not Por Emitir'); END IF;
  END LOOP;
  INSERT INTO invoice_restructure_log(holding_id, contract_id, actor_user_id, action, payload)
  VALUES (v_holding_id, p_contract_id, v_user_id, 'update_item_descriptions',
    jsonb_build_object('updates', p_updates, 'updated_count', v_count, 'failed', v_failed));
  RETURN jsonb_build_object('success', true, 'updated_count', v_count, 'failed', v_failed);
END; $function$;

COMMENT ON FUNCTION public."invoice_items_bulk_update_description"(p_contract_id uuid, p_updates jsonb) IS 'Actualiza description de invoice_items específicos, solo de facturas Por Emitir del contrato. Requiere permiso EDIT_FACTURACION.';
