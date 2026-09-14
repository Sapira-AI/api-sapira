CREATE OR REPLACE FUNCTION public.create_contract_renewal(p_contract_id uuid, p_effective_date date, p_items jsonb DEFAULT '[]'::jsonb, p_reason text DEFAULT NULL::text, p_metadata jsonb DEFAULT '{}'::jsonb, p_approval_required boolean DEFAULT true)
 RETURNS TABLE(success boolean, amendment_id uuid, message text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_user_id uuid;
  v_holding_id uuid;
  v_contract_record RECORD;
  v_amendment_id uuid;
  v_item jsonb;
  v_new_item_id uuid;
  v_original_check RECORD;
BEGIN
  SELECT id INTO v_user_id
  FROM public.users
  WHERE auth_id = auth.uid();

  IF v_user_id IS NULL THEN
    RETURN QUERY SELECT false, NULL::uuid, 'Usuario no encontrado';
    RETURN;
  END IF;

  SELECT holding_id INTO v_holding_id
  FROM public.user_holdings
  WHERE user_id = v_user_id;

  IF v_holding_id IS NULL THEN
    RETURN QUERY SELECT false, NULL::uuid, 'Usuario sin holding asociado';
    RETURN;
  END IF;

  SELECT c.*
  INTO v_contract_record
  FROM public.contracts c
  WHERE c.id = p_contract_id
    AND c.holding_id = v_holding_id;

  IF NOT FOUND THEN
    RETURN QUERY SELECT false, NULL::uuid, 'Contrato no encontrado o sin permisos';
    RETURN;
  END IF;

  IF jsonb_array_length(p_items) > 0 THEN
    FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
    LOOP
      IF (v_item->>'original_item_id') IS NOT NULL AND (v_item->>'original_item_id') <> '' THEN
        SELECT id, churn_date, renewed_by_item_id, categoria
        INTO v_original_check
        FROM public.contract_items
        WHERE id = (v_item->>'original_item_id')::uuid
          AND contract_id = p_contract_id;

        IF FOUND THEN
          IF v_original_check.churn_date IS NOT NULL THEN
            RAISE EXCEPTION 'No se puede renovar el item %: ya tiene churn_date=%',
              v_original_check.id, v_original_check.churn_date
              USING ERRCODE = 'P0001';
          END IF;
          IF v_original_check.renewed_by_item_id IS NOT NULL THEN
            RAISE EXCEPTION 'No se puede renovar el item %: ya fue renovado por item %',
              v_original_check.id, v_original_check.renewed_by_item_id
              USING ERRCODE = 'P0001';
          END IF;
          IF v_original_check.categoria IN ('CHURN', 'DOWNSELL') THEN
            RAISE EXCEPTION 'No se puede renovar el item %: es de tipo % y no es renovable',
              v_original_check.id, v_original_check.categoria
              USING ERRCODE = 'P0001';
          END IF;
        END IF;
      END IF;
    END LOOP;
  END IF;

  INSERT INTO public.contract_amendments (
    contract_id, type, effective_date, reason, metadata,
    approval_required, requested_by, status
  ) VALUES (
    p_contract_id,
    'renewal'::contract_amendment_type,
    p_effective_date,
    COALESCE(p_reason, 'Renovación de contrato'),
    p_metadata,
    p_approval_required,
    v_user_id,
    CASE WHEN p_approval_required THEN 'Pending' ELSE 'Approved' END
  ) RETURNING id INTO v_amendment_id;

  IF jsonb_array_length(p_items) > 0 THEN
    FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
    LOOP
      INSERT INTO public.contract_items (
        contract_id, product_name, price, final_price, currency,
        billing_frequency, billing_method, start_date, end_date,
        term_months, is_recurring, renews_item_id, product_id, holding_id
      ) VALUES (
        p_contract_id,
        v_item->>'product_name',
        COALESCE((v_item->>'price')::numeric, 0),
        COALESCE((v_item->>'final_price')::numeric, (v_item->>'price')::numeric, 0),
        COALESCE(v_item->>'currency', 'USD'),
        COALESCE(v_item->>'billing_frequency', 'monthly'),
        COALESCE(v_item->>'billing_method', 'advance'),
        p_effective_date,
        CASE
          WHEN (v_item->>'term_months')::integer > 0
          THEN p_effective_date + ((v_item->>'term_months')::integer || ' months')::interval
          ELSE NULL
        END,
        COALESCE((v_item->>'term_months')::integer, 12),
        COALESCE((v_item->>'is_recurring')::boolean, true),
        COALESCE((v_item->>'original_item_id')::uuid, NULL),
        NULLIF(v_item->>'product_id', '')::uuid,
        v_holding_id
      ) RETURNING id INTO v_new_item_id;

      INSERT INTO public.contract_amendment_items (
        amendment_id, new_item_id, original_item_id, scope, item_metadata
      ) VALUES (
        v_amendment_id,
        v_new_item_id,
        (v_item->>'original_item_id')::uuid,
        'permanent'::amendment_scope_type,
        v_item
      );
    END LOOP;
  END IF;

  INSERT INTO public.contract_lifecycle_events (
    contract_id, event_type, event_subtype, title, description,
    effective_date, amount_delta, event_status, created_by, metadata
  ) VALUES (
    p_contract_id,
    'renewal', 'standard_renewal',
    'Renovación de Contrato',
    COALESCE(p_reason, 'Renovación automática de contrato'),
    p_effective_date,
    0,
    CASE WHEN p_approval_required THEN 'pending' ELSE 'approved' END,
    v_user_id,
    jsonb_build_object(
      'amendment_id', v_amendment_id,
      'items_count', jsonb_array_length(p_items),
      'approval_required', p_approval_required
    )
  );

  RETURN QUERY SELECT true, v_amendment_id, 'Renovación creada exitosamente';

EXCEPTION WHEN OTHERS THEN
  RETURN QUERY SELECT false, NULL::uuid, 'Error al crear renovación: ' || SQLERRM;
END;
$function$


CREATE OR REPLACE FUNCTION public.create_contract_renewal(p_contract_id uuid, p_effective_date date, p_term_months integer DEFAULT NULL::integer, p_new_end_date date DEFAULT NULL::date, p_copy_items boolean DEFAULT true, p_metadata jsonb DEFAULT '{}'::jsonb, p_approval_required boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_user_id uuid;
  v_holding_id uuid;
  v_contract_record RECORD;
  v_company_tax_rate numeric;
  v_original_item_id uuid;
  v_original_item RECORD;
  v_new_item_id uuid;
  v_new_start_date date := p_effective_date;
  v_new_end_date date;
  v_lifecycle_event_id uuid;
  v_amendment_id uuid;
  v_created_items jsonb := '[]'::jsonb;
  v_created_invoices jsonb := '[]'::jsonb;
  v_invoice_count integer := 0;
  v_used_term integer;
  v_freq_raw text;
  v_freq text;
  v_period_months int := 1;
  v_method_raw text;
  v_method text;
  v_monthly_base numeric := 0;
  v_period_amount numeric := 0;
  v_period_start date;
  v_period_end date;
  v_issue_date date;
  v_due_date date;
  v_subtotal numeric;
  v_tax_amount numeric;
  v_total numeric;
  v_new_invoice_id uuid;
  v_custom_schedule jsonb;
  v_entry jsonb;
  v_sched_date date;
  v_sched_amount numeric;
  v_bp_end date;
  v_renewal_final_price numeric;
  v_renewal_unit_price numeric;
  v_renewal_quantity numeric;
  v_renewal_price numeric;
  v_item_qty numeric;
  v_item_unit_price numeric;
  v_has_price_change boolean;
  v_original_monthly numeric;
  v_renewal_monthly numeric;
  v_child RECORD;
  v_child_monthly numeric;
  v_children_monthly_sum numeric := 0;
  v_children_ids uuid[] := ARRAY[]::uuid[];
BEGIN
  SELECT id INTO v_user_id FROM public.users WHERE auth_id = auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Usuario no encontrado';
  END IF;
  SELECT holding_id INTO v_holding_id FROM public.user_holdings WHERE user_id = v_user_id;
  IF v_holding_id IS NULL THEN
    RAISE EXCEPTION 'Usuario sin holding asociado';
  END IF;
  SELECT c.*, comp.tax_rate INTO v_contract_record
  FROM public.contracts c
  JOIN public.companies comp ON c.company_id = comp.id
  WHERE c.id = p_contract_id AND c.holding_id = v_holding_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Contrato no encontrado o sin permisos';
  END IF;
  v_company_tax_rate := v_contract_record.tax_rate;
  IF v_company_tax_rate IS NULL THEN
    RAISE EXCEPTION 'TAX_RATE_NOT_CONFIGURED: La empresa % no tiene configurada una tasa de impuesto (tax_rate). Configure el impuesto en la empresa antes de generar facturas.', v_contract_record.company_id
      USING ERRCODE = 'P0001';
  END IF;
  v_original_item_id := COALESCE((p_metadata->>'original_item_id')::uuid, NULL);
  IF v_original_item_id IS NULL THEN
    RAISE EXCEPTION 'original_item_id requerido en metadata';
  END IF;
  SELECT * INTO v_original_item
  FROM public.contract_items
  WHERE id = v_original_item_id AND contract_id = p_contract_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Item original no encontrado';
  END IF;

  IF v_original_item.churn_date IS NOT NULL THEN
    RAISE EXCEPTION 'No se puede renovar el item %: ya tiene churn_date=%',
      v_original_item.id, v_original_item.churn_date
      USING ERRCODE = 'P0001';
  END IF;
  IF v_original_item.renewed_by_item_id IS NOT NULL THEN
    RAISE EXCEPTION 'No se puede renovar el item %: ya fue renovado por item %',
      v_original_item.id, v_original_item.renewed_by_item_id
      USING ERRCODE = 'P0001';
  END IF;
  IF v_original_item.categoria IN ('CHURN', 'DOWNSELL') THEN
    RAISE EXCEPTION 'No se puede renovar el item %: es de tipo % y no es renovable',
      v_original_item.id, v_original_item.categoria
      USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.contract_amendments (
    contract_id, type, effective_date, approval_required, metadata, reason, status, requested_by, holding_id
  ) VALUES (
    p_contract_id,
    'RENEWAL'::public.contract_amendment_type,
    p_effective_date,
    p_approval_required,
    COALESCE(p_metadata, '{}'::jsonb),
    'Contract renewal',
    CASE WHEN p_approval_required THEN 'Pending' ELSE 'Approved' END,
    v_user_id,
    v_holding_id
  ) RETURNING id INTO v_amendment_id;

  IF p_approval_required THEN
    INSERT INTO public.contract_lifecycle_events (
      contract_id, event_type, event_status, title, description, effective_date, created_by, holding_id, metadata
    ) VALUES (
      p_contract_id, 'renewal', 'pending', 'Solicitud de Renovación',
      'Renovación de contrato pendiente de aprobación', p_effective_date,
      v_user_id, v_holding_id,
      jsonb_build_object(
        'amendment_id', v_amendment_id, 'original_item_id', v_original_item_id,
        'term_months', p_term_months, 'new_end_date', p_new_end_date, 'approval_required', true
      )
    ) RETURNING id INTO v_lifecycle_event_id;
    RETURN jsonb_build_object(
      'success', true, 'approval_required', true, 'amendment_id', v_amendment_id,
      'lifecycle_event_id', v_lifecycle_event_id,
      'message', 'Solicitud de renovación creada pendiente de aprobación'
    );
  END IF;

  v_used_term := COALESCE(p_term_months, v_original_item.term_months, 1);
  IF p_new_end_date IS NOT NULL THEN
    v_new_end_date := p_new_end_date;
  ELSE
    v_new_end_date := (v_new_start_date + (v_used_term || ' month')::interval - interval '1 day')::date;
  END IF;

  v_freq_raw := lower(COALESCE(p_metadata->>'billing_frequency', v_original_item.billing_frequency, 'Mensual'));
  IF v_freq_raw LIKE '%mensual%' OR v_freq_raw LIKE '%month%' THEN
    v_period_months := 1; v_freq := 'Mensual';
  ELSIF v_freq_raw LIKE '%trimes%' OR v_freq_raw LIKE '%quarter%' THEN
    v_period_months := 3; v_freq := 'Trimestral';
  ELSIF v_freq_raw LIKE '%semes%' OR v_freq_raw LIKE '%semi%' THEN
    v_period_months := 6; v_freq := 'Semestral';
  ELSIF v_freq_raw LIKE '%anual%' OR v_freq_raw LIKE '%annual%' OR v_freq_raw LIKE '%year%' THEN
    v_period_months := 12; v_freq := 'Anual';
  ELSE
    v_period_months := 1; v_freq := 'Mensual';
  END IF;

  v_method_raw := lower(COALESCE(p_metadata->>'billing_method', v_original_item.billing_method, 'Anticipado'));
  IF v_method_raw LIKE '%vencid%' OR v_method_raw LIKE '%arrear%' OR v_method_raw LIKE '%post%' THEN
    v_method := 'Vencido';
  ELSE
    v_method := 'Anticipado';
  END IF;

  v_renewal_final_price := COALESCE((p_metadata->>'final_price_override')::numeric, v_original_item.final_price);
  v_renewal_unit_price := COALESCE((p_metadata->>'unit_price_override')::numeric, v_original_item.unit_price);
  v_renewal_quantity := COALESCE((p_metadata->>'quantity_override')::numeric, v_original_item.quantity);
  v_renewal_price := COALESCE((p_metadata->>'price_override')::numeric, v_original_item.price);

  v_original_monthly := COALESCE(
    v_original_item.monthly_price,
    CASE WHEN COALESCE(v_original_item.term_months, 0) > 0
         THEN ROUND(v_original_item.final_price / v_original_item.term_months, 2)
         ELSE 0 END
  );
  v_renewal_monthly := CASE WHEN COALESCE(v_used_term, 0) > 0
                            THEN ROUND(v_renewal_final_price / v_used_term, 2)
                            ELSE 0 END;
  v_has_price_change := (
    v_original_monthly IS NOT NULL
    AND v_renewal_monthly IS NOT NULL
    AND ABS(v_renewal_monthly - v_original_monthly) >= 0.01
  );

  FOR v_child IN
    SELECT id, monthly_price, final_price, term_months
    FROM public.contract_items
    WHERE contract_id = p_contract_id
      AND related_item_id = v_original_item.id
      AND COALESCE(categoria, '') = 'UPSELL'
      AND churn_date IS NULL
      AND renewed_by_item_id IS NULL
  LOOP
    v_child_monthly := COALESCE(
      v_child.monthly_price,
      CASE WHEN COALESCE(v_child.term_months, 0) > 0
           THEN ROUND(v_child.final_price / v_child.term_months, 2)
           ELSE 0 END
    );
    v_children_monthly_sum := v_children_monthly_sum + v_child_monthly;
    v_children_ids := array_append(v_children_ids, v_child.id);
  END LOOP;

  IF array_length(v_children_ids, 1) > 0 THEN
    v_renewal_final_price := v_renewal_final_price + ROUND(v_children_monthly_sum * v_used_term, 2);
  END IF;

  INSERT INTO public.contract_items (
    contract_id, product_id, product_name, term_months, currency, price, discount_type, discount_value,
    final_price, billing_method, billing_frequency, start_date, end_date, is_recurring, renews_item_id, holding_id,
    unit_price, quantity,
    categoria, item_type, unit_of_measure,
    annual_unit_price, annual_price, price_entry_mode
  ) VALUES (
    p_contract_id, v_original_item.product_id, v_original_item.product_name, v_used_term,
    v_original_item.currency, v_renewal_price, v_original_item.discount_type, v_original_item.discount_value,
    v_renewal_final_price, v_method, v_freq, v_new_start_date, v_new_end_date,
    v_original_item.is_recurring, v_original_item.id, v_holding_id,
    v_renewal_unit_price, v_renewal_quantity,
    'RENEWAL', v_original_item.item_type, v_original_item.unit_of_measure,
    v_original_item.annual_unit_price, v_original_item.annual_price, v_original_item.price_entry_mode
  ) RETURNING id INTO v_new_item_id;

  UPDATE public.contract_items SET renewed_by_item_id = v_new_item_id WHERE id = v_original_item.id;

  IF array_length(v_children_ids, 1) > 0 THEN
    UPDATE public.contract_items
    SET renewed_by_item_id = v_new_item_id
    WHERE id = ANY(v_children_ids);
  END IF;

  IF v_has_price_change THEN
    IF COALESCE(v_original_item.price_entry_mode, 'monthly') = 'annual' THEN
      UPDATE public.contract_items
      SET annual_unit_price       = ROUND(v_renewal_unit_price * 12, 6),
          annual_price            = ROUND(v_renewal_unit_price * 12 * COALESCE(v_renewal_quantity, 1), 2),
          renewal_base_unit_price = v_original_item.unit_price
      WHERE id = v_new_item_id;
    ELSE
      UPDATE public.contract_items
      SET renewal_base_unit_price = v_original_item.unit_price
      WHERE id = v_new_item_id;
    END IF;
  END IF;

  v_created_items := v_created_items || jsonb_build_object(
    'id', v_new_item_id, 'product_name', v_original_item.product_name,
    'final_price', v_renewal_final_price, 'start_date', v_new_start_date, 'end_date', v_new_end_date,
    'price_changed', v_has_price_change,
    'renewal_base_unit_price', CASE WHEN v_has_price_change THEN v_original_item.unit_price ELSE NULL END,
    'consolidated_children_count', COALESCE(array_length(v_children_ids, 1), 0),
    'consolidated_children_monthly_sum', v_children_monthly_sum,
    'consolidated_children_ids', to_jsonb(v_children_ids)
  );

  v_monthly_base := COALESCE(v_renewal_final_price, v_renewal_price, 0) / NULLIF(v_used_term, 0);
  IF v_monthly_base IS NULL THEN v_monthly_base := 0; END IF;

  v_custom_schedule := p_metadata->'custom_schedule';
  IF v_custom_schedule IS NOT NULL AND jsonb_typeof(v_custom_schedule) = 'array' AND jsonb_array_length(v_custom_schedule) > 0 THEN
    FOR v_entry IN SELECT * FROM jsonb_array_elements(v_custom_schedule)
    LOOP
      v_sched_date := (v_entry->>'date')::date;
      v_sched_amount := COALESCE((v_entry->>'amount')::numeric, 0);
      IF v_sched_date IS NULL THEN CONTINUE; END IF;

      v_subtotal := v_sched_amount;
      v_tax_amount := ROUND(v_subtotal * (v_company_tax_rate / 100), 2);
      v_total := v_subtotal + v_tax_amount;
      v_issue_date := v_sched_date;
      v_due_date := v_issue_date + interval '30 days';
      v_bp_end := (v_sched_date + (v_period_months || ' month')::interval - interval '1 day')::date;

      INSERT INTO public.invoices (
        company_id, client_id, client_entity_id, contract_id,
        scheduled_at, original_issue_date, issue_date, due_date,
        vat, amount_contract_currency, amount_invoice_currency,
        total_invoice_currency, total_system_currency,
        contract_currency, invoice_currency, fx_contract_to_invoice,
        status, invoice_type, document_type, export_type, invoice_series,
        holding_id, issuer_legal_name, issuer_tax_id, issuer_address, client_tax_id,
        notes
      ) VALUES (
        v_contract_record.company_id, v_contract_record.client_id,
        v_contract_record.client_entity_id, p_contract_id,
        v_sched_date, v_sched_date, v_issue_date, v_due_date,
        v_tax_amount, v_subtotal, v_subtotal, v_total, v_total,
        v_original_item.currency, v_original_item.currency, 1.0,
        'Por Emitir',
        'Automatica',
        'FACTURA', 1, 'FAC',
        v_holding_id,
        (SELECT legal_name FROM companies WHERE id = v_contract_record.company_id),
        (SELECT tax_id FROM companies WHERE id = v_contract_record.company_id),
        (SELECT legal_address FROM companies WHERE id = v_contract_record.company_id),
        (SELECT ce.tax_id FROM client_entities ce WHERE ce.id = v_contract_record.client_entity_id),
        'Renovación de contrato'
      ) RETURNING id INTO v_new_invoice_id;

      v_item_qty := COALESCE(v_renewal_quantity, 1);
      v_item_unit_price := ROUND(v_subtotal / v_item_qty, 6);

      INSERT INTO public.invoice_items (
        invoice_id, contract_item_id, product_id,
        description, quantity, unit_of_measure,
        unit_price_contract_currency, unit_price_invoice_currency,
        discount_pct,
        subtotal_contract_currency, subtotal_invoice_currency,
        tax_amount_contract_currency, tax_amount_invoice_currency,
        total_contract_currency, total_invoice_currency,
        contract_currency, invoice_currency, fx_contract_to_invoice,
        holding_id, contract_id,
        billing_period_start, billing_period_end
      ) VALUES (
        v_new_invoice_id, v_new_item_id, v_original_item.product_id,
        v_original_item.product_name || CASE WHEN NULLIF(TRIM(v_original_item.account), '') IS NOT NULL THEN ' Cuenta ' || TRIM(v_original_item.account) ELSE '' END || ' - Periodo '
          || TO_CHAR(v_sched_date, 'DD/MM/YYYY') || ' a '
          || TO_CHAR(v_bp_end, 'DD/MM/YYYY'),
        v_item_qty, COALESCE(v_original_item.unit_of_measure, 'UND'),
        v_item_unit_price, v_item_unit_price,
        0,
        v_subtotal, v_subtotal,
        v_tax_amount, v_tax_amount,
        v_total, v_total,
        v_original_item.currency, v_original_item.currency, 1,
        v_holding_id, p_contract_id,
        v_sched_date, v_bp_end
      );

      v_invoice_count := v_invoice_count + 1;
      v_created_invoices := v_created_invoices || jsonb_build_object(
        'id', v_new_invoice_id, 'scheduled_at', v_sched_date, 'amount', v_total
      );
    END LOOP;
  ELSE
    v_period_start := v_new_start_date;
    WHILE v_period_start <= v_new_end_date LOOP
      v_period_end := (v_period_start + (v_period_months || ' month')::interval - interval '1 day')::date;
      IF v_period_end > v_new_end_date THEN
        v_period_end := v_new_end_date;
      END IF;

      v_period_amount := ROUND(COALESCE(v_monthly_base, 0) * v_period_months, 2);

      IF v_method = 'Vencido' THEN
        v_issue_date := v_period_end;
      ELSE
        v_issue_date := v_period_start;
      END IF;
      v_due_date := v_issue_date + interval '30 days';

      v_subtotal := v_period_amount;
      v_tax_amount := ROUND(v_subtotal * (v_company_tax_rate / 100), 2);
      v_total := v_subtotal + v_tax_amount;

      INSERT INTO public.invoices (
        company_id, client_id, client_entity_id, contract_id,
        scheduled_at, original_issue_date, issue_date, due_date,
        vat, amount_contract_currency, amount_invoice_currency,
        total_invoice_currency, total_system_currency,
        contract_currency, invoice_currency, fx_contract_to_invoice,
        status, invoice_type, document_type, export_type, invoice_series,
        holding_id, issuer_legal_name, issuer_tax_id, issuer_address, client_tax_id,
        notes
      ) VALUES (
        v_contract_record.company_id, v_contract_record.client_id,
        v_contract_record.client_entity_id, p_contract_id,
        CASE WHEN v_method = 'Vencido' THEN v_period_end ELSE v_period_start END,
        CASE WHEN v_method = 'Vencido' THEN v_period_end ELSE v_period_start END,
        v_issue_date, v_due_date,
        v_tax_amount, v_subtotal, v_subtotal, v_total, v_total,
        v_original_item.currency, v_original_item.currency, 1.0,
        'Por Emitir',
        'Automatica',
        'FACTURA', 1, 'FAC',
        v_holding_id,
        (SELECT legal_name FROM companies WHERE id = v_contract_record.company_id),
        (SELECT tax_id FROM companies WHERE id = v_contract_record.company_id),
        (SELECT legal_address FROM companies WHERE id = v_contract_record.company_id),
        (SELECT ce.tax_id FROM client_entities ce WHERE ce.id = v_contract_record.client_entity_id),
        'Renovación de contrato'
      ) RETURNING id INTO v_new_invoice_id;

      v_item_qty := COALESCE(v_renewal_quantity, 1);
      v_item_unit_price := ROUND(v_subtotal / v_item_qty, 6);

      INSERT INTO public.invoice_items (
        invoice_id, contract_item_id, product_id,
        description, quantity, unit_of_measure,
        unit_price_contract_currency, unit_price_invoice_currency,
        discount_pct,
        subtotal_contract_currency, subtotal_invoice_currency,
        tax_amount_contract_currency, tax_amount_invoice_currency,
        total_contract_currency, total_invoice_currency,
        contract_currency, invoice_currency, fx_contract_to_invoice,
        holding_id, contract_id,
        billing_period_start, billing_period_end
      ) VALUES (
        v_new_invoice_id, v_new_item_id, v_original_item.product_id,
        v_original_item.product_name || CASE WHEN NULLIF(TRIM(v_original_item.account), '') IS NOT NULL THEN ' Cuenta ' || TRIM(v_original_item.account) ELSE '' END || ' - Periodo '
          || TO_CHAR(v_period_start, 'DD/MM/YYYY') || ' a '
          || TO_CHAR(v_period_end, 'DD/MM/YYYY'),
        v_item_qty, COALESCE(v_original_item.unit_of_measure, 'UND'),
        v_item_unit_price, v_item_unit_price,
        0,
        v_subtotal, v_subtotal,
        v_tax_amount, v_tax_amount,
        v_total, v_total,
        v_original_item.currency, v_original_item.currency, 1,
        v_holding_id, p_contract_id,
        v_period_start, v_period_end
      );

      v_invoice_count := v_invoice_count + 1;
      v_created_invoices := v_created_invoices || jsonb_build_object(
        'id', v_new_invoice_id,
        'scheduled_at', CASE WHEN v_method = 'Vencido' THEN v_period_end ELSE v_period_start END,
        'amount', v_total
      );

      v_period_start := (v_period_start + (v_period_months || ' month')::interval)::date;
    END LOOP;
  END IF;

  UPDATE public.contract_amendments
  SET status = 'Approved', approved_by = v_user_id
  WHERE id = v_amendment_id;

  INSERT INTO public.contract_lifecycle_events (
    contract_id, event_type, event_status, title, description,
    effective_date, created_by, completed_at, holding_id, metadata
  ) VALUES (
    p_contract_id, 'renewal', 'completed', 'Renovación Aplicada',
    'Renovación de contrato aplicada automáticamente', p_effective_date,
    v_user_id, now(), v_holding_id,
    jsonb_build_object(
      'amendment_id', v_amendment_id, 'created_items', v_created_items,
      'created_invoices', v_created_invoices, 'invoice_count', v_invoice_count,
      'auto_applied', true, 'billing_frequency', v_freq, 'billing_method', v_method,
      'price_changed', v_has_price_change,
      'consolidated_children_count', COALESCE(array_length(v_children_ids, 1), 0),
      'consolidated_children_ids', to_jsonb(v_children_ids)
    )
  ) RETURNING id INTO v_lifecycle_event_id;

  RETURN jsonb_build_object(
    'success', true, 'approval_required', false, 'amendment_id', v_amendment_id,
    'lifecycle_event_id', v_lifecycle_event_id, 'created_items', v_created_items,
    'created_invoices', v_created_invoices, 'invoice_count', v_invoice_count,
    'price_changed', v_has_price_change,
    'consolidated_children_count', COALESCE(array_length(v_children_ids, 1), 0),
    'message', 'Renovación aplicada exitosamente'
  );
EXCEPTION WHEN OTHERS THEN
  RAISE EXCEPTION 'Error en renovación: %', SQLERRM;
END;
$function$

