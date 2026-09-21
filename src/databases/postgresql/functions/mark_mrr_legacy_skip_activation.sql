CREATE OR REPLACE FUNCTION public.mark_mrr_legacy_skip_activation(p_record_ids uuid[], p_reason text, p_skip boolean DEFAULT true)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_updated_count integer;
BEGIN
  IF p_skip THEN
    -- Mark as skip_activation
    UPDATE mrr_legacy
    SET 
      skip_activation = true,
      skip_activation_reason = p_reason,
      skip_activation_at = now(),
      updated_at = now()
    WHERE id = ANY(p_record_ids)
      AND migrated_to_contract_id IS NULL;
  ELSE
    -- Revert skip_activation
    UPDATE mrr_legacy
    SET 
      skip_activation = false,
      skip_activation_reason = NULL,
      skip_activation_at = NULL,
      updated_at = now()
    WHERE id = ANY(p_record_ids);
  END IF;

  GET DIAGNOSTICS v_updated_count = ROW_COUNT;

  RETURN jsonb_build_object(
    'success', true,
    'updated_count', v_updated_count
  );
END;
$function$

