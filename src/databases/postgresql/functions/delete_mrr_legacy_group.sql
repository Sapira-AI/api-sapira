CREATE OR REPLACE FUNCTION public.delete_mrr_legacy_group(p_record_ids uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_invoice_ids uuid[];
  v_deleted_count int;
  v_reverted_count int;
BEGIN
  -- Validar que los registros no estén migrados
  IF EXISTS (
    SELECT 1 FROM mrr_legacy
    WHERE id = ANY(p_record_ids)
      AND migrated_to_contract_id IS NOT NULL
  ) THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'No se puede eliminar MRR Legacy ya migrado a contrato'
    );
  END IF;

  -- Obtener IDs de facturas afectadas
  SELECT ARRAY_AGG(DISTINCT invoice_legacy_id)
  INTO v_invoice_ids
  FROM mrr_legacy
  WHERE id = ANY(p_record_ids);
  
  -- Eliminar registros MRR Legacy
  DELETE FROM mrr_legacy
  WHERE id = ANY(p_record_ids);
  
  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
  
  -- Revertir estado de facturas a 'pending'
  -- Solo si no tienen otros registros MRR Legacy activos
  UPDATE invoices_legacy
  SET reconciliation_status = 'pending'
  WHERE id = ANY(v_invoice_ids)
    AND reconciliation_status = 'mrr_legacy'
    AND NOT EXISTS (
      SELECT 1 FROM mrr_legacy
      WHERE invoice_legacy_id = invoices_legacy.id
    );
  
  GET DIAGNOSTICS v_reverted_count = ROW_COUNT;
  
  RETURN jsonb_build_object(
    'success', true,
    'deleted_count', v_deleted_count,
    'reverted_invoices', v_reverted_count
  );
END;
$function$;

COMMENT ON FUNCTION public."delete_mrr_legacy_group"(p_record_ids uuid[]) IS 'Elimina un grupo de registros MRR Legacy y revierte automáticamente el estado de las facturas legacy a pending si no tienen otros registros MRR asociados';
