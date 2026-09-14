CREATE OR REPLACE FUNCTION public.unconsolidate_invoices_simple(p_consolidated_invoice_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_contract_id uuid;
  v_holding_id uuid;
  v_invoice_count int;
  v_source_invoice_ids uuid[];
BEGIN
  -- Obtener datos de la factura consolidada/unificada
  SELECT contract_id, holding_id
  INTO v_contract_id, v_holding_id
  FROM invoices
  WHERE id = p_consolidated_invoice_id
    AND invoice_type IN ('Consolidada', 'Unificada')
    AND is_active = true;

  IF v_contract_id IS NULL THEN
    RAISE EXCEPTION 'Factura consolidada no encontrada o no es una consolidación activa';
  END IF;

  -- Validar que no esté emitida/enviada/pagada (una factura emitida es real, no se edita)
  IF EXISTS (
    SELECT 1 FROM invoices
    WHERE id = p_consolidated_invoice_id
    AND status IN ('Emitida', 'Enviada', 'Pagada', 'Vencida')
  ) THEN
    RAISE EXCEPTION 'No se puede desconsolidar una factura ya emitida, enviada o pagada';
  END IF;

  -- Obtener IDs de facturas originales
  SELECT array_agg(id), COUNT(*)
  INTO v_source_invoice_ids, v_invoice_count
  FROM invoices
  WHERE consolidated_into_invoice_id = p_consolidated_invoice_id;

  IF v_invoice_count = 0 THEN
    RAISE EXCEPTION 'No se encontraron facturas originales para esta consolidación';
  END IF;

  -- Restaurar facturas originales
  UPDATE invoices
  SET
    is_active = true,
    consolidated_into_invoice_id = NULL,
    status = 'Por Emitir'
  WHERE consolidated_into_invoice_id = p_consolidated_invoice_id;

  -- Eliminar items de la factura consolidada
  DELETE FROM invoice_items WHERE invoice_id = p_consolidated_invoice_id;

  -- Eliminar factura consolidada
  DELETE FROM invoices WHERE id = p_consolidated_invoice_id;

  -- Registrar evento en historial
  PERFORM log_lifecycle_event(
    v_contract_id,
    'INVOICE_UNCONSOLIDATION',
    'Desconsolidación de Facturas',
    CURRENT_DATE,
    NULL,
    format('%s facturas restauradas', v_invoice_count),
    'Consolidación revertida',
    jsonb_build_object(
      'consolidated_invoice_id', p_consolidated_invoice_id,
      'restored_invoice_ids', v_source_invoice_ids,
      'invoices_restored', v_invoice_count
    ),
    'consolidation',
    'Completed'
  );

  RETURN jsonb_build_object(
    'success', true,
    'invoices_restored', v_invoice_count,
    'restored_invoice_ids', v_source_invoice_ids
  );
END;
$function$

