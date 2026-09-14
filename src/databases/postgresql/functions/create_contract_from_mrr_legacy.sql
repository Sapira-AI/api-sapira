CREATE OR REPLACE FUNCTION public.create_contract_from_mrr_legacy(p_group_data jsonb, p_form_data jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_contract_id uuid;
  v_holding_id uuid;
  v_client_name_commercial text;
  v_legal_client_name text;
  v_total_value numeric := 0;
  v_contract_end_date date;
  v_max_end_date date;
  v_product jsonb;
  v_product_end_date date;
  v_contract_item_id uuid;
  v_contract_items uuid[] := ARRAY[]::uuid[];
  v_invoice_date date;
  v_invoice_amount numeric;
  v_item_details jsonb;
  v_max_term integer;
  v_is_anticipada boolean;
  v_monthly_price numeric;
  v_billing_period_price numeric;
  v_price_before_discount numeric;
  v_discount_pct numeric;
  v_custom_fields jsonb;
  v_start_date date;
  v_i integer;
  v_j integer;
  v_record_ids uuid[];
  v_fx_result RECORD;
BEGIN
  RAISE NOTICE '[MRR_LEGACY_ACTIVATION] ========== INICIO ==========';
  RAISE NOTICE '[MRR_LEGACY_ACTIVATION] Group: %, Form: %', p_group_data->>'client_id', p_form_data->>'company_id';
  
  -- =====================================================
  -- PASO 1: Obtener holding_id del usuario actual
  -- =====================================================
  
  SELECT get_current_user_holding_id() INTO v_holding_id;
  
  IF v_holding_id IS NULL THEN
    RAISE EXCEPTION 'Usuario no tiene empresa asociada';
  END IF;
  
  RAISE NOTICE '[MRR_LEGACY_ACTIVATION] Holding ID: %', v_holding_id;
  
  -- =====================================================
  -- PASO 2: Obtener client_name_commercial y legal_client_name
  -- =====================================================
  
  SELECT name_commercial INTO v_client_name_commercial
  FROM clients
  WHERE id = (p_group_data->>'client_id')::uuid;
  
  -- Obtener legal_client_name desde client_entities si existe client_entity_id
  IF (p_form_data->>'client_entity_id') IS NOT NULL THEN
    SELECT legal_name INTO v_legal_client_name
    FROM client_entities
    WHERE id = (p_form_data->>'client_entity_id')::uuid;
  END IF;
  
  RAISE NOTICE '[MRR_LEGACY_ACTIVATION] Client: %, Legal Name: %', v_client_name_commercial, v_legal_client_name;
  
  -- =====================================================
  -- PASO 3: Calcular total_value y contract_end_date
  -- =====================================================
  
  v_start_date := (p_form_data->>'start_date')::date;
  v_max_end_date := v_start_date;
  
  FOR v_product IN SELECT * FROM jsonb_array_elements(p_form_data->'products')
  LOOP
    -- Sumar al total_value
    v_total_value := v_total_value + (v_product->>'final_price')::numeric;
    
    -- Calcular end_date del producto
    IF v_product->>'end_date' IS NOT NULL AND v_product->>'end_date' != '' THEN
      v_product_end_date := (v_product->>'end_date')::date;
    ELSIF v_product->>'term_months' IS NOT NULL THEN
      v_product_end_date := (v_start_date + ((v_product->>'term_months')::integer || ' months')::interval - interval '1 day')::date;
    ELSE
      -- Si no hay term_months, usar 12 meses por defecto
      v_product_end_date := (v_start_date + interval '12 months' - interval '1 day')::date;
    END IF;
    
    -- Actualizar máximo
    IF v_product_end_date > v_max_end_date THEN
      v_max_end_date := v_product_end_date;
    END IF;
  END LOOP;
  
  -- Asegurar que contract_end_date siempre tenga un valor
  v_contract_end_date := COALESCE(v_max_end_date, v_start_date + interval '12 months' - interval '1 day');
  
  RAISE NOTICE '[MRR_LEGACY_ACTIVATION] Total Value: %, End Date: %', v_total_value, v_contract_end_date;
  
  -- =====================================================
  -- PASO 4: Crear contrato (ahora incluye auto_invoice)
  -- =====================================================
  
  INSERT INTO contracts (
    client_id,
    company_id,
    status,
    booking_date,
    holding_id,
    contract_number,
    contract_currency,
    requires_references_for_billing,
    auto_invoice,
    type,
    notes,
    fx_company_policy,
    client_entity_id,
    total_value,
    client_name_commercial,
    legal_client_name,
    contract_end_date
  ) VALUES (
    (p_group_data->>'client_id')::uuid,
    (p_form_data->>'company_id')::uuid,
    'En revisión',
    v_start_date,
    v_holding_id,
    p_form_data->>'contract_number',
    p_group_data->>'contract_currency',
    COALESCE((p_form_data->>'requires_references')::boolean, false),
    COALESCE((p_form_data->>'auto_invoice')::boolean, false),
    p_form_data->>'contract_type',
    p_form_data->>'notes',
    p_form_data->>'fx_company_policy',
    (p_form_data->>'client_entity_id')::uuid,
    v_total_value,
    v_client_name_commercial,
    v_legal_client_name,
    v_contract_end_date
  )
  RETURNING id INTO v_contract_id;
  
  RAISE NOTICE '[MRR_LEGACY_ACTIVATION] Contract created: %', v_contract_id;
  
  -- =====================================================
  -- PASO 5: Crear contract_items
  -- =====================================================
  
  FOR v_product IN SELECT * FROM jsonb_array_elements(p_form_data->'products')
  LOOP
    -- Calcular monthly_price
    v_monthly_price := (v_product->>'final_price')::numeric / (v_product->>'term_months')::integer;
    
    -- Calcular billing_period_price según frecuencia
    v_billing_period_price := v_monthly_price;
    CASE LOWER(v_product->>'billing_frequency')
      WHEN 'trimestral' THEN v_billing_period_price := v_monthly_price * 3;
      WHEN 'semestral' THEN v_billing_period_price := v_monthly_price * 6;
      WHEN 'anual' THEN v_billing_period_price := v_monthly_price * 12;
      WHEN 'bianual' THEN v_billing_period_price := v_monthly_price * 24;
      ELSE v_billing_period_price := v_monthly_price;
    END CASE;
    
    -- Calcular precio antes de descuento
    v_discount_pct := COALESCE((v_product->>'discount_pct')::numeric, 0);
    IF v_discount_pct > 0 THEN
      v_price_before_discount := (v_product->>'final_price')::numeric / (1 - v_discount_pct / 100);
    ELSE
      v_price_before_discount := (v_product->>'final_price')::numeric;
    END IF;
    
    -- Extraer custom_fields (campos que empiezan con cf_)
    v_custom_fields := '{}'::jsonb;
    -- Nota: En SQL no podemos iterar dinámicamente sobre keys de jsonb como en JS
    -- Los custom_fields deben venir ya procesados desde el frontend en el jsonb
    IF v_product ? 'custom_fields' THEN
      v_custom_fields := v_product->'custom_fields';
    END IF;
    
    -- Calcular end_date (consistente con cálculo del contrato)
    IF v_product->>'end_date' IS NOT NULL AND v_product->>'end_date' != '' THEN
      v_product_end_date := (v_product->>'end_date')::date;
    ELSIF v_product->>'term_months' IS NOT NULL THEN
      v_product_end_date := (v_start_date + ((v_product->>'term_months')::integer || ' months')::interval - interval '1 day')::date;
    ELSE
      -- Si no hay term_months, usar 12 meses por defecto
      v_product_end_date := (v_start_date + interval '12 months' - interval '1 day')::date;
    END IF;
    
    -- Insertar contract_item
    INSERT INTO contract_items (
      contract_id,
      product_id,
      product_name,
      price,
      final_price,
      monthly_price,
      billing_period_price,
      currency,
      billing_frequency,
      billing_method,
      term_months,
      start_date,
      end_date,
      categoria,
      item_type,
      unit_of_measure,
      unit_price,
      quantity,
      discount_type,
      discount_value,
      is_recurring,
      auto_renew,
      auto_renew_term_months,
      holding_id,
      custom_fields
    ) VALUES (
      v_contract_id,
      (v_product->>'product_id')::uuid,
      v_product->>'product_name',
      v_price_before_discount,
      (v_product->>'final_price')::numeric,
      v_monthly_price,
      v_billing_period_price,
      v_product->>'currency',
      v_product->>'billing_frequency',
      CASE WHEN v_product->>'billing_type' = 'anticipada' THEN 'Anticipado' ELSE 'Vencido' END,
      (v_product->>'term_months')::integer,
      v_start_date,
      v_product_end_date,
      'RENEWAL',
      v_product->>'item_type',
      v_product->>'unit_of_measure',
      (v_product->>'unit_price')::numeric,
      (v_product->>'quantity')::numeric,
      CASE WHEN v_discount_pct > 0 THEN 'Porcentaje' ELSE NULL END,
      CASE WHEN v_discount_pct > 0 THEN v_discount_pct ELSE NULL END,
      true,
      COALESCE((v_product->>'auto_renew')::boolean, false),
      (v_product->>'auto_renew_term_months')::integer,
      v_holding_id,
      CASE WHEN jsonb_typeof(v_custom_fields) = 'object' AND v_custom_fields != '{}'::jsonb THEN v_custom_fields ELSE NULL END
    )
    RETURNING id INTO v_contract_item_id;
    
    v_contract_items := array_append(v_contract_items, v_contract_item_id);
  END LOOP;
  
  RAISE NOTICE '[MRR_LEGACY_ACTIVATION] Contract items created: %', array_length(v_contract_items, 1);
  
  -- =====================================================
  -- PASO 6: Crear contract_invoices (schedule programado)
  -- =====================================================
  
  -- Obtener max term y tipo de facturación
  SELECT MAX((value->>'term_months')::integer) INTO v_max_term
  FROM jsonb_array_elements(p_form_data->'products');
  
  SELECT value->>'billing_type' = 'anticipada' INTO v_is_anticipada
  FROM jsonb_array_elements(p_form_data->'products')
  LIMIT 1;
  
  RAISE NOTICE '[MRR_LEGACY_ACTIVATION] Generating contract_invoices: max_term=%, anticipada=%', v_max_term, v_is_anticipada;
  
  -- Loop para cada período
  FOR v_i IN 0..(v_max_term - 1)
  LOOP
    -- Calcular fecha de factura
    IF v_is_anticipada THEN
      v_invoice_date := v_start_date + (v_i || ' months')::interval;
    ELSE
      v_invoice_date := v_start_date + ((v_i + 1) || ' months')::interval;
    END IF;
    
    -- Calcular monto y detalles de items para esta factura
    v_invoice_amount := 0;
    v_item_details := '[]'::jsonb;
    
    v_j := 0;
    FOR v_product IN SELECT * FROM jsonb_array_elements(p_form_data->'products')
    LOOP
      -- Solo incluir si el producto está activo en este período
      IF v_i < (v_product->>'term_months')::integer THEN
        v_monthly_price := (v_product->>'final_price')::numeric / (v_product->>'term_months')::integer;
        v_invoice_amount := v_invoice_amount + v_monthly_price;
        
        -- Agregar detalle del item
        v_item_details := v_item_details || jsonb_build_object(
          'contract_item_id', v_contract_items[v_j + 1],
          'product_name', v_product->>'product_name',
          'amount', v_monthly_price,
          'quantity', COALESCE((v_product->>'quantity')::numeric, 1),
          'unit_of_measure', v_product->>'unit_of_measure'
        );
      END IF;
      
      v_j := v_j + 1;
    END LOOP;
    
    -- Insertar contract_invoice si hay monto
    IF v_invoice_amount > 0 THEN
      INSERT INTO contract_invoices (
        contract_id,
        invoice_date,
        amount,
        currency,
        status,
        contract_item_details,
        holding_id
      ) VALUES (
        v_contract_id,
        v_invoice_date,
        v_invoice_amount,
        p_group_data->>'contract_currency',
        'Programada',
        v_item_details,
        v_holding_id
      );
    END IF;
  END LOOP;
  
  RAISE NOTICE '[MRR_LEGACY_ACTIVATION] Contract invoices created';
  
  -- =====================================================
  -- PASO 7: Actualizar mrr_legacy records
  -- =====================================================
  
  -- Extraer record_ids del group_data
  SELECT ARRAY(SELECT jsonb_array_elements_text(p_group_data->'record_ids'))::uuid[]
  INTO v_record_ids;
  
  UPDATE mrr_legacy
  SET 
    migrated_to_contract_id = v_contract_id,
    migrated_at = NOW()
  WHERE id = ANY(v_record_ids);
  
  RAISE NOTICE '[MRR_LEGACY_ACTIVATION] MRR legacy records updated: %', array_length(v_record_ids, 1);
  
  -- =====================================================
  -- PASO 7.5: Calcular FX rates para el contrato
  -- =====================================================
  
  RAISE NOTICE '[MRR_LEGACY_ACTIVATION] Calculating FX rates for contract...';
  
  BEGIN
    -- Llamar a calculate_contract_fx_amounts para calcular FX
    SELECT * INTO v_fx_result 
    FROM calculate_contract_fx_amounts(v_contract_id);
    
    IF v_fx_result.success THEN
      RAISE NOTICE '[MRR_LEGACY_ACTIVATION] ✅ FX rates calculated successfully';
    ELSE
      RAISE WARNING '[MRR_LEGACY_ACTIVATION] ⚠️ FX calculation warning: %', v_fx_result.message;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    -- No fallar la transacción completa si falla el cálculo FX
    -- El contrato se crea igual y el FX se puede calcular después
    RAISE WARNING '[MRR_LEGACY_ACTIVATION] ⚠️ Error calculating FX (non-fatal): %', SQLERRM;
  END;
  
  -- =====================================================
  -- PASO 8: Retornar resultado
  -- =====================================================
  
  RAISE NOTICE '[MRR_LEGACY_ACTIVATION] ========== ÉXITO ==========';
  
  RETURN jsonb_build_object(
    'success', true,
    'contract_id', v_contract_id,
    'contract_items_count', array_length(v_contract_items, 1),
    'message', 'Contrato creado exitosamente en estado En revisión'
  );
  
EXCEPTION
  WHEN OTHERS THEN
    RAISE NOTICE '[MRR_LEGACY_ACTIVATION] ========== ERROR ==========';
    RAISE NOTICE '[MRR_LEGACY_ACTIVATION] Error: %', SQLERRM;
    
    -- Retornar error
    RETURN jsonb_build_object(
      'success', false,
      'error', SQLERRM,
      'message', 'Error al crear contrato desde MRR Legacy'
    );
END;
$function$

