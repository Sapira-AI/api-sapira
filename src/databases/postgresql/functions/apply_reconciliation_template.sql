CREATE OR REPLACE FUNCTION public.apply_reconciliation_template(p_template_invoice_id uuid, p_target_invoice_ids uuid[], p_user_id uuid, p_billing_periods jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_holding_id uuid;
  v_contract_id uuid;
  v_template_item record;
  v_target_invoice_id uuid;
  v_target_item record;
  v_reconciled_count integer := 0;
  v_failed_count integer := 0;
  v_errors jsonb := '[]'::jsonb;
  v_fx_calculated numeric;
  v_billing_period text;
  v_billing_period_start date;
  v_billing_period_end date;
  v_invoice_details jsonb := '[]'::jsonb;
BEGIN
  v_holding_id := get_current_user_holding_id();
  
  IF v_holding_id IS NULL THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Usuario no tiene holding_id asignado'
    );
  END IF;
  
  -- 1. Obtener el contrato de la plantilla
  SELECT DISTINCT contract_id INTO v_contract_id
  FROM public.invoice_items_legacy_match
  WHERE invoice_item_legacy_id IN (
    SELECT id FROM public.invoice_items_legacy
    WHERE invoices_legacy_id = p_template_invoice_id
  )
  LIMIT 1;
  
  IF v_contract_id IS NULL THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'La factura plantilla no tiene reconciliación'
    );
  END IF;
  
  -- 2. Para cada factura objetivo
  FOREACH v_target_invoice_id IN ARRAY p_target_invoice_ids
  LOOP
    BEGIN
      DECLARE
        v_total_contract numeric := 0;
        v_total_invoice numeric := 0;
        v_invoice_number text;
        v_issue_date date;
        v_invoice_status text;
      BEGIN
        -- Obtener datos de la factura objetivo
        SELECT invoice_number, issue_date, total_invoice_currency, reconciliation_status
        INTO v_invoice_number, v_issue_date, v_total_invoice, v_invoice_status
        FROM public.invoices_legacy
        WHERE id = v_target_invoice_id;
        
        -- Validar que no esté ya migrada
        IF v_invoice_status = 'migrated' THEN
          v_failed_count := v_failed_count + 1;
          v_errors := v_errors || jsonb_build_object(
            'invoice_id', v_target_invoice_id,
            'error', 'Factura ya migrada, no se puede aplicar plantilla'
          );
          CONTINUE;
        END IF;
        
        -- Obtener período de facturación si fue proporcionado
        IF p_billing_periods IS NOT NULL THEN
          v_billing_period := p_billing_periods->>v_target_invoice_id::text;
          
          IF v_billing_period IS NOT NULL THEN
            -- Formato: YYYY-MM → calcular inicio y fin del mes
            v_billing_period_start := (v_billing_period || '-01')::date;
            v_billing_period_end := (v_billing_period_start + INTERVAL '1 month - 1 day')::date;
          END IF;
        END IF;
        
        -- 3. Iterar sobre items de la plantilla (ordenados por cantidad y unidad)
        FOR v_template_item IN
          SELECT 
            m.*,
            iil.quantity as template_quantity,
            iil.unit_of_measure as template_unit,
            ROW_NUMBER() OVER (ORDER BY iil.quantity, COALESCE(iil.unit_of_measure, 'UN')) as item_index
          FROM public.invoice_items_legacy iil
          INNER JOIN public.invoice_items_legacy_match m 
            ON m.invoice_item_legacy_id = iil.id
          WHERE iil.invoices_legacy_id = p_template_invoice_id
          ORDER BY iil.quantity, COALESCE(iil.unit_of_measure, 'UN')
        LOOP
          -- 4. Buscar el item correspondiente en la factura objetivo
          --    (mismo índice en el orden de cantidad + unidad)
          SELECT * INTO v_target_item
          FROM (
            SELECT 
              *,
              ROW_NUMBER() OVER (ORDER BY quantity, COALESCE(unit_of_measure, 'UN')) as item_index
            FROM public.invoice_items_legacy
            WHERE invoices_legacy_id = v_target_invoice_id
          ) items
          WHERE item_index = v_template_item.item_index;
          
          IF v_target_item.id IS NOT NULL THEN
            -- 5. Calcular FX dinámicamente para este item
            --    FX = amount_invoice / amount_contract
            IF v_template_item.amount_contract_currency > 0 THEN
              v_fx_calculated := v_target_item.subtotal / v_template_item.amount_contract_currency;
            ELSE
              v_fx_calculated := 1.0;
            END IF;
            
            -- Acumular totales para calcular FX promedio de la factura
            v_total_contract := v_total_contract + v_template_item.amount_contract_currency;
            
            -- 6. Crear match para el item objetivo usando la plantilla
            INSERT INTO public.invoice_items_legacy_match (
              invoice_item_legacy_id,
              contract_id,
              contract_item_id,
              product_id,
              contract_currency,
              fx_contract_to_invoice,
              amount_contract_currency,
              amount_invoice_currency,
              quantity,
              unit_of_measure,
              billing_period_start,
              billing_period_end,
              status,
              notes,
              created_by,
              holding_id
            )
            VALUES (
              v_target_item.id,
              v_contract_id,
              v_template_item.contract_item_id,
              v_template_item.product_id,
              v_template_item.contract_currency,
              v_fx_calculated,  -- ✅ FX calculado dinámicamente
              v_template_item.amount_contract_currency,  -- Mismo monto en moneda de contrato
              v_target_item.subtotal,  -- Monto de la factura objetivo
              v_template_item.quantity,
              v_template_item.unit_of_measure,
              v_billing_period_start,  -- Período asignado
              v_billing_period_end,
              'tentative',
              'Aplicado desde plantilla de reconciliación masiva (Factura: ' || 
                (SELECT invoice_number FROM public.invoices_legacy WHERE id = p_template_invoice_id) || ')',
              p_user_id,
              v_holding_id
            )
            ON CONFLICT (invoice_item_legacy_id) 
            DO UPDATE SET
              contract_id = EXCLUDED.contract_id,
              contract_item_id = EXCLUDED.contract_item_id,
              product_id = EXCLUDED.product_id,
              contract_currency = EXCLUDED.contract_currency,
              fx_contract_to_invoice = EXCLUDED.fx_contract_to_invoice,
              amount_contract_currency = EXCLUDED.amount_contract_currency,
              amount_invoice_currency = EXCLUDED.amount_invoice_currency,
              quantity = EXCLUDED.quantity,
              unit_of_measure = EXCLUDED.unit_of_measure,
              billing_period_start = EXCLUDED.billing_period_start,
              billing_period_end = EXCLUDED.billing_period_end,
              notes = EXCLUDED.notes,
              updated_at = NOW();
          END IF;
        END LOOP;
        
        -- 7. Actualizar status de la factura
        UPDATE public.invoices_legacy
        SET 
          reconciliation_status = 'reconciled',
          contract_id = v_contract_id
        WHERE id = v_target_invoice_id;
        
        -- 8. Guardar detalles de la factura reconciliada
        v_invoice_details := v_invoice_details || jsonb_build_object(
          'invoice_id', v_target_invoice_id,
          'invoice_number', v_invoice_number,
          'issue_date', v_issue_date,
          'total_invoice', v_total_invoice,
          'total_contract', v_total_contract,
          'fx_calculated', CASE WHEN v_total_contract > 0 
                                THEN v_total_invoice / v_total_contract 
                                ELSE 1.0 END,
          'billing_period', v_billing_period
        );
        
        v_reconciled_count := v_reconciled_count + 1;
      END;
      
    EXCEPTION WHEN OTHERS THEN
      v_failed_count := v_failed_count + 1;
      v_errors := v_errors || jsonb_build_object(
        'invoice_id', v_target_invoice_id,
        'error', SQLERRM
      );
    END;
  END LOOP;
  
  RETURN jsonb_build_object(
    'success', true,
    'reconciled_count', v_reconciled_count,
    'failed_count', v_failed_count,
    'errors', v_errors,
    'invoice_details', v_invoice_details
  );
END;
$function$

