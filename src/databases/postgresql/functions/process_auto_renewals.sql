CREATE OR REPLACE FUNCTION public.process_auto_renewals(p_days_before_expiry integer DEFAULT 90)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_item RECORD;
  v_renewal_date date;
  v_renewal_term integer;
  v_renewal_result jsonb;
  v_processed_count integer := 0;
  v_failed_count integer := 0;
  v_results jsonb := '[]'::jsonb;
  v_error_message text;
BEGIN
  -- Buscar items que:
  -- 1. Tienen auto_renew = true
  -- 2. Su end_date está dentro de los próximos p_days_before_expiry días
  -- 3. No han sido renovados automáticamente recientemente (evitar duplicados)
  -- 4. No tienen ya una renovación pendiente (no existe renewed_by_item_id)
  
  FOR v_item IN 
    SELECT 
      ci.*,
      c.id as contract_id,
      c.company_id,
      c.client_id
    FROM public.contract_items ci
    JOIN public.contracts c ON ci.contract_id = c.id
    WHERE ci.auto_renew = true
      AND ci.end_date IS NOT NULL
      AND ci.end_date <= (CURRENT_DATE + (p_days_before_expiry || ' days')::interval)
      AND ci.end_date > CURRENT_DATE  -- No procesar items ya vencidos
      AND ci.renewed_by_item_id IS NULL  -- No ha sido renovado aún
      AND (ci.auto_renewed_at IS NULL OR ci.auto_renewed_at < (CURRENT_DATE - interval '7 days'))  -- Evitar re-procesar
    ORDER BY ci.end_date ASC
  LOOP
    BEGIN
      -- Calcular fecha de inicio de la renovación (día siguiente al end_date)
      -- Usar ::date para evitar problemas de timezone
      v_renewal_date := (v_item.end_date + interval '1 day')::date;
      
      -- Determinar el término de la renovación
      v_renewal_term := COALESCE(v_item.auto_renew_term_months, v_item.term_months, 12);
      
      -- Ejecutar renovación usando la función existente
      -- Importante: marcar en metadata que es auto-renovación
      SELECT public.create_contract_renewal(
        p_contract_id := v_item.contract_id,
        p_effective_date := v_renewal_date,
        p_term_months := v_renewal_term,
        p_new_end_date := NULL,  -- Se calculará automáticamente
        p_copy_items := true,
        p_metadata := jsonb_build_object(
          'original_item_id', v_item.id,
          'billing_frequency', v_item.billing_frequency,
          'billing_method', v_item.billing_method,
          'auto_renewal', true,
          'auto_renewal_executed_at', NOW(),
          'auto_renewal_days_before_expiry', p_days_before_expiry
        ),
        p_approval_required := false  -- Auto-renovaciones no requieren aprobación
      ) INTO v_renewal_result;
      
      -- Marcar el item original como auto-renovado
      UPDATE public.contract_items
      SET auto_renewed_at = NOW()
      WHERE id = v_item.id;
      
      -- Registrar éxito
      v_processed_count := v_processed_count + 1;
      v_results := v_results || jsonb_build_object(
        'item_id', v_item.id,
        'product_name', v_item.product_name,
        'contract_id', v_item.contract_id,
        'original_end_date', v_item.end_date,
        'renewal_start_date', v_renewal_date,
        'renewal_term_months', v_renewal_term,
        'status', 'success',
        'result', v_renewal_result
      );
      
    EXCEPTION WHEN OTHERS THEN
      -- Capturar error y continuar con el siguiente item
      v_failed_count := v_failed_count + 1;
      v_error_message := SQLERRM;
      
      v_results := v_results || jsonb_build_object(
        'item_id', v_item.id,
        'product_name', v_item.product_name,
        'contract_id', v_item.contract_id,
        'status', 'error',
        'error', v_error_message
      );
      
      -- Log del error para debugging
      RAISE WARNING 'Error al auto-renovar item %: %', v_item.id, v_error_message;
    END;
  END LOOP;
  
  -- Retornar resumen de ejecución
  RETURN jsonb_build_object(
    'executed_at', NOW(),
    'days_before_expiry', p_days_before_expiry,
    'processed_count', v_processed_count,
    'failed_count', v_failed_count,
    'total_items', v_processed_count + v_failed_count,
    'results', v_results
  );
END;
$function$

