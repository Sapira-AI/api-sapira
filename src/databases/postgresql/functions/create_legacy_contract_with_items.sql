CREATE OR REPLACE FUNCTION public.create_legacy_contract_with_items(p_contract_data jsonb, p_items jsonb[], p_client_entity_id uuid, p_user_id uuid DEFAULT NULL::uuid, p_company_id uuid DEFAULT NULL::uuid, p_group_by_period boolean DEFAULT true)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_holding_id           uuid;
  v_company_id           uuid;
  v_contract_id          uuid;
  v_item                 jsonb;
  v_item_id              uuid;
  v_client_id            uuid;
  v_existing_client_id   uuid;
  v_contract_currency    text;
  v_booking_date         date;
  v_contract_end_date    date;
  v_contract_start_date  date;
  v_total_contract_value numeric;
  v_has_previous_contract boolean;
  v_item_categoria       text;
  -- Variables para generacion per-item de contract_invoices
  v_contract_item        record;
  v_item_period_months   integer;
  v_item_num_periods     integer;
  v_item_period_amount   numeric;
  v_item_invoice_date    date;
  v_invoices_created     integer := 0;
BEGIN
  -- Obtener holding_id
  IF p_user_id IS NOT NULL THEN
    SELECT holding_id INTO v_holding_id
    FROM user_holdings WHERE user_id = p_user_id LIMIT 1;
  ELSE
    SELECT holding_id INTO v_holding_id
    FROM user_holdings WHERE user_id = auth.uid() LIMIT 1;
  END IF;
  IF v_holding_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'No se pudo obtener holding_id del usuario');
  END IF;
  -- Resolver company_id
  IF p_company_id IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM companies WHERE id = p_company_id AND holding_id = v_holding_id) THEN
      v_company_id := p_company_id;
    ELSE
      RETURN jsonb_build_object('success', false, 'error', 'La compania especificada no pertenece al holding');
    END IF;
  ELSE
    SELECT id INTO v_company_id FROM companies WHERE holding_id = v_holding_id LIMIT 1;
  END IF;
  IF v_company_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'No se encontro una compania para el holding');
  END IF;
  -- Validar client_id
  v_client_id := (p_contract_data->>'client_id')::uuid;
  IF v_client_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Debe seleccionar un cliente comercial');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM clients WHERE id = v_client_id AND holding_id = v_holding_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Cliente no pertenece al holding');
  END IF;
  -- Asociar client_entity <-> client si aun no tiene client_id
  SELECT client_id INTO v_existing_client_id FROM client_entities WHERE id = p_client_entity_id;
  IF v_existing_client_id IS NULL THEN
    UPDATE client_entities SET client_id = v_client_id WHERE id = p_client_entity_id;
    RAISE NOTICE 'Client entity % asociado con client %', p_client_entity_id, v_client_id;
  ELSIF v_existing_client_id != v_client_id THEN
    RAISE NOTICE 'Client entity % ya asociado con client %, usando % para el contrato',
      p_client_entity_id, v_existing_client_id, v_client_id;
  END IF;
  -- FIX: Asegurar registro en junction table (client_entity_clients)
  INSERT INTO client_entity_clients (client_entity_id, client_id, holding_id, is_primary)
  VALUES (
    p_client_entity_id,
    v_client_id,
    v_holding_id,
    NOT EXISTS (SELECT 1 FROM client_entity_clients WHERE client_entity_id = p_client_entity_id)
  )
  ON CONFLICT (client_entity_id, client_id) DO NOTHING;
  -- Valores del contrato
  v_contract_currency    := p_contract_data->>'contract_currency';
  v_booking_date         := COALESCE((p_contract_data->>'booking_date')::date,   CURRENT_DATE);
  v_contract_end_date    := (p_contract_data->>'contract_end_date')::date;
  v_contract_start_date  := COALESCE((p_contract_data->>'contract_start_date')::date, v_booking_date);
  v_total_contract_value := COALESCE((p_contract_data->>'total_value')::numeric, 0);
  -- Categoria dinamica
  SELECT EXISTS (
    SELECT 1 FROM contracts
    WHERE client_id = v_client_id AND holding_id = v_holding_id
      AND is_legacy = true AND booking_date < v_booking_date
  ) INTO v_has_previous_contract;
  v_item_categoria := CASE WHEN v_has_previous_contract THEN 'UPSELL' ELSE 'NEW' END;
  -- Crear contrato legacy
  INSERT INTO contracts (
    holding_id, client_id, client_entity_id, company_id,
    contract_number, client_name_commercial, legal_client_name,
    legal_representative_name, legal_representative_id,
    contract_currency, type, status, term, total_value,
    booking_date, contract_end_date,
    is_legacy, legacy_status, legacy_cutoff_date, legacy_reconciliation_pct,
    notes, custom_fields, group_invoices_by_period, created_at
  ) VALUES (
    v_holding_id, v_client_id, p_client_entity_id, v_company_id,
    p_contract_data->>'contract_number',
    p_contract_data->>'client_name_commercial',
    p_contract_data->>'legal_client_name',
    p_contract_data->>'legal_representative_name',
    p_contract_data->>'legal_representative_id',
    v_contract_currency,
    COALESCE(p_contract_data->>'type', 'Servicio'),
    'En revisión',  -- FIX: acento correcto (antes: 'En revision')
    COALESCE((p_contract_data->>'term')::integer, 12),
    v_total_contract_value,
    v_booking_date, v_contract_end_date,
    true, 'in_reconciliation',
    (p_contract_data->>'legacy_cutoff_date')::date,
    0,
    p_contract_data->>'notes',
    COALESCE((p_contract_data->'custom_fields')::jsonb, '{}'::jsonb),
    p_group_by_period,
    NOW()
  )
  RETURNING id INTO v_contract_id;
  -- Insertar items del contrato
  FOREACH v_item IN ARRAY p_items LOOP
    INSERT INTO contract_items (
      contract_id, holding_id,
      product_id, product_name, term_months, currency,
      item_type, unit_of_measure,
      unit_price, quantity, price,
      discount_type, discount_value, final_price,
      start_date, end_date,
      billing_method, billing_frequency,
      is_recurring, categoria, account, custom_fields
    ) VALUES (
      v_contract_id, v_holding_id,
      (v_item->>'product_id')::uuid,
      v_item->>'product_name',
      COALESCE((v_item->>'term_months')::integer, 12),
      COALESCE(v_item->>'currency', v_contract_currency),
      v_item->>'item_type',
      v_item->>'unit_of_measure',
      (v_item->>'unit_price')::numeric,
      (v_item->>'quantity')::numeric,
      (v_item->>'price')::numeric,
      v_item->>'discount_type',
      COALESCE((v_item->>'discount_value')::numeric, 0),
      (v_item->>'final_price')::numeric,
      (v_item->>'start_date')::date,
      (v_item->>'end_date')::date,
      v_item->>'billing_method',
      v_item->>'billing_frequency',
      true,
      v_item_categoria,
      v_item->>'account',
      '{}'::jsonb
    )
    RETURNING id INTO v_item_id;
  END LOOP;
  -- Generar contract_invoices por item
  FOR v_contract_item IN
    SELECT id, product_name, final_price, term_months, billing_frequency, start_date, end_date
    FROM contract_items
    WHERE contract_id = v_contract_id
  LOOP
    v_item_period_months := CASE COALESCE(v_contract_item.billing_frequency, 'Mensual')
      WHEN 'Mensual'    THEN 1
      WHEN 'Trimestral' THEN 3
      WHEN 'Semestral'  THEN 6
      WHEN 'Anual'      THEN 12
      WHEN 'Bianual'    THEN 24
      ELSE 1
    END;
    v_item_num_periods := CEIL(
      COALESCE(v_contract_item.term_months, 12)::numeric / v_item_period_months
    );
    v_item_period_amount := ROUND(
      COALESCE(v_contract_item.final_price, 0) / NULLIF(v_item_num_periods, 0),
      2
    );
    FOR i IN 0..(v_item_num_periods - 1) LOOP
      v_item_invoice_date :=
        COALESCE(v_contract_item.start_date, v_contract_start_date)
        + (i * v_item_period_months * INTERVAL '1 month');
      IF v_item_invoice_date <= COALESCE(v_contract_item.end_date, v_contract_end_date, v_item_invoice_date) THEN
        INSERT INTO contract_invoices (
          contract_id, holding_id, invoice_date, amount, currency,
          status, contract_item_details, is_editable, is_satisfied
        ) VALUES (
          v_contract_id, v_holding_id, v_item_invoice_date, v_item_period_amount, v_contract_currency,
          'Programada',
          jsonb_build_array(jsonb_build_object(
            'contract_item_id', v_contract_item.id,
            'product_name',     v_contract_item.product_name,
            'amount',           v_item_period_amount
          )),
          true, false
        );
        v_invoices_created := v_invoices_created + 1;
      END IF;
    END LOOP;
  END LOOP;
  -- Consolidar por periodo si aplica
  IF p_group_by_period THEN
    WITH per_item_data AS (
      SELECT id, invoice_date, amount, contract_item_details
      FROM contract_invoices
      WHERE contract_id = v_contract_id
        AND COALESCE(is_satisfied, false) = false
    ),
    grouped AS (
      SELECT
        invoice_date,
        SUM(amount)  AS total_amount,
        jsonb_agg(detail ORDER BY (detail->>'contract_item_id')::text) AS combined_details
      FROM per_item_data,
      LATERAL jsonb_array_elements(contract_item_details) AS detail
      GROUP BY invoice_date
    ),
    deleted AS (
      DELETE FROM contract_invoices
      WHERE contract_id = v_contract_id
        AND COALESCE(is_satisfied, false) = false
    )
    INSERT INTO contract_invoices (
      contract_id, holding_id, invoice_date, amount, currency,
      status, contract_item_details, is_editable, is_satisfied
    )
    SELECT
      v_contract_id, v_holding_id, invoice_date, total_amount, v_contract_currency,
      'Programada', combined_details, true, false
    FROM grouped;
  END IF;
  RAISE NOTICE '[LEGACY_CONTRACT] Contract % created: % raw invoices, group_by_period=%',
    v_contract_id, v_invoices_created, p_group_by_period;
  RETURN jsonb_build_object(
    'success',         true,
    'contract_id',     v_contract_id,
    'contract_number', p_contract_data->>'contract_number'
  );
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$function$

