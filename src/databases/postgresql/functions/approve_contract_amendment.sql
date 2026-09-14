CREATE OR REPLACE FUNCTION public.approve_contract_amendment(p_amendment_id uuid, p_approved boolean, p_comments text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_amend RECORD;
  v_holding uuid;
  v_total_delta numeric := 0;
  v_items jsonb := '[]'::jsonb;
  v_new_item_id uuid;
  v_contract RECORD;
  v_original_item_id uuid;
  v_term_months int;
  v_original_item RECORD;
  v_amendment_item RECORD;
  v_company RECORD;
  v_client_entity RECORD;
  v_created_items uuid[];
  v_invoice_id uuid;
  v_item RECORD;
  v_start_date date;
  v_end_date date;
  v_current_date date;
  v_frequency_months int;
  v_monthly_price numeric;
  v_tax_rate numeric;
  v_subtotal numeric;
  v_tax_amount numeric;
  v_total numeric;
  v_invoice RECORD;
  v_monthly_reduction numeric;
  v_downsell_months int;
  v_downsell_start date;
  v_downsell_end date;
  v_existing_invoice RECORD;
  v_period_end date;
  v_unit_price numeric;
BEGIN
  SELECT * INTO v_amend FROM public.contract_amendments WHERE id = p_amendment_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Enmienda no encontrada';
  END IF;

  v_holding := v_amend.holding_id;
  SELECT * INTO v_contract FROM public.contracts WHERE id = v_amend.contract_id;

  IF NOT p_approved THEN
    UPDATE public.contract_amendments SET status='Rejected' WHERE id = p_amendment_id;
    RETURN jsonb_build_object('status','rejected');
  END IF;

  UPDATE public.contract_amendments SET status='Approved' WHERE id = p_amendment_id;

  IF v_amend.type = 'RENEWAL' THEN
    v_term_months := COALESCE((v_amend.metadata->>'term_months')::int, 12);
    v_original_item_id := (v_amend.metadata->>'original_item_id')::uuid;

    IF v_original_item_id IS NOT NULL THEN
      INSERT INTO public.contract_items(
        product_id, contract_id, end_date, renews_item_id, is_recurring,
        discount_value, final_price, price, start_date, quote_item_id,
        holding_id, billing_frequency, billing_method, discount_type,
        term_months, currency, product_name, categoria,
        item_type, unit_of_measure, unit_price, quantity,
        booking_date
      )
      SELECT
        s.product_id, s.contract_id,
        (v_amend.effective_date + make_interval(months => v_term_months))::date - 1,
        s.id, s.is_recurring, s.discount_value, s.final_price, s.price,
        v_amend.effective_date, s.quote_item_id, s.holding_id,
        s.billing_frequency, s.billing_method, s.discount_type,
        v_term_months, s.currency, s.product_name, 'RENEWAL',
        s.item_type, s.unit_of_measure, s.unit_price, s.quantity,
        v_amend.effective_date
      FROM public.contract_items s
      WHERE s.id = v_original_item_id
      RETURNING id INTO v_new_item_id;

      v_items := v_items || jsonb_build_array(jsonb_build_object('new_item_id', v_new_item_id::text));

      UPDATE public.contract_items
      SET renewed_by_item_id = v_new_item_id
      WHERE id = v_original_item_id;
    ELSE
      FOR v_new_item_id IN
        WITH src AS (
          SELECT * FROM public.contract_items
          WHERE contract_id = v_amend.contract_id
          AND (is_recurring IS DISTINCT FROM false)
        )
        INSERT INTO public.contract_items(
          product_id, contract_id, end_date, renews_item_id, is_recurring,
          discount_value, final_price, price, start_date, quote_item_id,
          holding_id, billing_frequency, billing_method, discount_type,
          term_months, currency, product_name, categoria,
          item_type, unit_of_measure, unit_price, quantity,
          booking_date
        )
        SELECT
          s.product_id, s.contract_id,
          (v_amend.effective_date + make_interval(months => v_term_months))::date - 1,
          s.id, s.is_recurring, s.discount_value, s.final_price, s.price,
          v_amend.effective_date, s.quote_item_id, s.holding_id,
          s.billing_frequency, s.billing_method, s.discount_type,
          v_term_months, s.currency, s.product_name, 'RENEWAL',
          s.item_type, s.unit_of_measure, s.unit_price, s.quantity,
          v_amend.effective_date
        FROM src s
        RETURNING id
      LOOP
        v_items := v_items || jsonb_build_array(jsonb_build_object('new_item_id', v_new_item_id::text));
      END LOOP;

      UPDATE public.contract_items o
      SET renewed_by_item_id = n.id
      FROM public.contract_items n
      WHERE n.renews_item_id = o.id
      AND o.contract_id = v_amend.contract_id;
    END IF;

    SELECT COALESCE(SUM(final_price),0) INTO v_total_delta
    FROM public.contract_items
    WHERE contract_id = v_amend.contract_id
    AND start_date = v_amend.effective_date;

    PERFORM public.log_lifecycle_event(
      v_amend.contract_id,
      'RENEWAL_APPLIED',
      'Renovación aplicada',
      v_amend.effective_date,
      v_total_delta,
      COALESCE(v_amend.reason, 'Renovación aplicada'),
      NULL,
      v_items
    );

  ELSIF v_amend.type = 'CHURN' THEN
    UPDATE public.contract_items
    SET end_date = LEAST(COALESCE(end_date, v_amend.effective_date), v_amend.effective_date)
    WHERE contract_id = v_amend.contract_id
    AND (end_date IS NULL OR end_date > v_amend.effective_date);

    UPDATE public.contracts
    SET churn_date = v_amend.effective_date, status = 'Churn'
    WHERE id = v_amend.contract_id;

    PERFORM public.log_lifecycle_event(
      v_amend.contract_id,
      'CHURN_APPLIED',
      'Churn aplicado',
      v_amend.effective_date,
      0,
      COALESCE(v_amend.reason, 'Churn aplicado'),
      NULL,
      '[]'::jsonb
    );

  ELSIF v_amend.type = 'UPSELL' THEN
    FOR v_amendment_item IN
      SELECT cai.*
      FROM public.contract_amendment_items cai
      WHERE cai.amendment_id = v_amend.id
      AND cai.original_item_id IS NOT NULL
      AND COALESCE(cai.price_delta, 0) > 0
    LOOP
      SELECT * INTO v_original_item
      FROM public.contract_items
      WHERE id = v_amendment_item.original_item_id;

      INSERT INTO public.contract_items(
        product_id, contract_id, product_name, term_months, currency,
        price, discount_type, discount_value, final_price,
        billing_method, billing_frequency, start_date, end_date,
        is_recurring, holding_id, categoria,
        item_type, unit_of_measure, unit_price, quantity,
        booking_date,
        related_item_id
      ) VALUES (
        v_original_item.product_id,
        v_amend.contract_id,
        v_original_item.product_name || ' (Upselling)',
        v_original_item.term_months,
        v_original_item.currency,
        v_amendment_item.price_delta,
        v_original_item.discount_type,
        0,
        v_amendment_item.price_delta,
        v_original_item.billing_method,
        v_original_item.billing_frequency,
        COALESCE(v_amendment_item.start_date_override, v_amend.effective_date),
        COALESCE(v_amendment_item.end_date_override, v_original_item.end_date),
        v_original_item.is_recurring,
        v_holding,
        'UPSELL',
        v_original_item.item_type, v_original_item.unit_of_measure,
        v_amendment_item.price_delta, 1,
        v_amend.effective_date,
        v_original_item.id
      ) RETURNING id INTO v_new_item_id;

      v_total_delta := v_total_delta + v_amendment_item.price_delta;

      v_items := v_items || jsonb_build_array(jsonb_build_object(
        'new_item_id', v_new_item_id::text,
        'original_item_id', v_amendment_item.original_item_id::text,
        'price_delta', v_amendment_item.price_delta
      ));
    END LOOP;

    PERFORM public.log_lifecycle_event(
      v_amend.contract_id,
      'UPSELL_APPLIED',
      'Upsell aplicado',
      v_amend.effective_date,
      v_total_delta,
      COALESCE(v_amend.reason, 'Upsell aplicado'),
      NULL,
      v_items
    );

  ELSIF v_amend.type = 'DOWNSELL' THEN
    SELECT c.* INTO v_company
    FROM public.companies c
    WHERE c.id = v_contract.company_id;

    SELECT ce.* INTO v_client_entity
    FROM public.client_entities ce
    WHERE ce.id = v_contract.client_entity_id;

    v_tax_rate := COALESCE(v_company.tax_rate, 0);

    FOR v_amendment_item IN
      SELECT cai.*
      FROM public.contract_amendment_items cai
      WHERE cai.amendment_id = v_amend.id
      AND cai.original_item_id IS NOT NULL
      AND (cai.scope::text = 'permanent' OR cai.scope IS NULL)
    LOOP
      SELECT * INTO v_original_item
      FROM public.contract_items
      WHERE id = v_amendment_item.original_item_id;

      v_downsell_start := COALESCE(v_amendment_item.start_date_override, v_amend.effective_date);
      v_downsell_end := COALESCE(v_amendment_item.end_date_override, v_original_item.end_date);

      v_downsell_months := EXTRACT(YEAR FROM AGE(v_downsell_end, v_downsell_start)) * 12 +
                           EXTRACT(MONTH FROM AGE(v_downsell_end, v_downsell_start)) + 1;

      INSERT INTO public.contract_items(
        product_id, contract_id, product_name, term_months, currency,
        price, discount_type, discount_value, final_price,
        billing_method, billing_frequency, start_date, end_date,
        is_recurring, holding_id, categoria,
        item_type, unit_of_measure, unit_price, quantity,
        booking_date,
        related_item_id
      ) VALUES (
        v_original_item.product_id,
        v_amend.contract_id,
        v_original_item.product_name || ' (Downsell)',
        v_downsell_months,
        v_original_item.currency,
        v_amendment_item.price_delta,
        v_original_item.discount_type,
        0,
        v_amendment_item.price_delta,
        v_original_item.billing_method,
        v_original_item.billing_frequency,
        v_downsell_start,
        v_downsell_end,
        v_original_item.is_recurring,
        v_holding,
        'DOWNSELL',
        v_original_item.item_type, v_original_item.unit_of_measure,
        CASE WHEN v_downsell_months > 0
          THEN v_amendment_item.price_delta / v_downsell_months
          ELSE v_amendment_item.price_delta
        END,
        1,
        v_downsell_start,
        v_original_item.id
      ) RETURNING id INTO v_new_item_id;

      v_total_delta := v_total_delta + v_amendment_item.price_delta;

      v_items := v_items || jsonb_build_array(jsonb_build_object(
        'new_item_id', v_new_item_id::text,
        'original_item_id', v_amendment_item.original_item_id::text,
        'price_delta', v_amendment_item.price_delta
      ));

      IF v_downsell_months > 0 THEN
        v_monthly_reduction := ABS(v_amendment_item.price_delta) / v_downsell_months;
      ELSE
        v_monthly_reduction := ABS(v_amendment_item.price_delta);
      END IF;

      v_frequency_months := CASE v_original_item.billing_frequency
        WHEN 'Mensual' THEN 1
        WHEN 'Trimestral' THEN 3
        WHEN 'Semestral' THEN 6
        WHEN 'Anual' THEN 12
        WHEN 'Bianual' THEN 24
        ELSE 1
      END;

      FOR v_invoice IN
        SELECT i.*
        FROM invoices i
        JOIN invoice_items ii ON ii.invoice_id = i.id
        WHERE i.contract_id = v_amend.contract_id
          AND ii.contract_item_id = v_amendment_item.original_item_id
          AND i.status = 'Por Emitir'
          AND i.issue_date >= v_downsell_start
          AND i.issue_date <= v_downsell_end
        ORDER BY i.issue_date
      LOOP
        v_subtotal := v_monthly_reduction * v_frequency_months;
        v_tax_amount := v_subtotal * (v_tax_rate / 100);
        v_total := v_subtotal + v_tax_amount;

        v_period_end := (v_invoice.issue_date + make_interval(months => v_frequency_months) - interval '1 day')::date;

        INSERT INTO public.invoices(
          holding_id, contract_id, company_id, client_id, client_entity_id,
          scheduled_at, original_issue_date, issue_date, due_date, status,
          contract_currency, invoice_currency, amount_contract_currency,
          amount_invoice_currency, vat, total_invoice_currency,
          fx_contract_to_invoice, invoice_type, issuer_tax_id,
          issuer_legal_name, issuer_address, client_tax_id, notes,
          related_invoice_id, document_type
        ) VALUES (
          v_invoice.holding_id, v_invoice.contract_id, v_invoice.company_id,
          v_invoice.client_id, v_invoice.client_entity_id, v_invoice.scheduled_at,
          v_invoice.issue_date, v_invoice.issue_date, v_invoice.due_date, 'Por Emitir',
          v_invoice.contract_currency, v_invoice.invoice_currency, -v_subtotal, -v_subtotal,
          -v_tax_amount, -v_total, 1.0,
          'Automatica',
          v_company.tax_id,
          v_company.legal_name, v_company.legal_address,
          v_client_entity.tax_id, COALESCE(v_amend.reason, 'Downsell'),
          v_invoice.id, 'NC'
        ) RETURNING id INTO v_invoice_id;

        v_unit_price := v_monthly_reduction;
        INSERT INTO public.invoice_items(
          holding_id, invoice_id, contract_item_id, product_id,
          description, quantity,
          unit_price_contract_currency, unit_price_invoice_currency,
          subtotal_contract_currency, subtotal_invoice_currency,
          tax_amount_contract_currency, tax_amount_invoice_currency,
          total_contract_currency, total_invoice_currency,
          contract_currency, invoice_currency,
          fx_contract_to_invoice, discount_pct,
          billing_period_start, billing_period_end
        ) VALUES (
          v_invoice.holding_id, v_invoice_id, v_new_item_id, v_original_item.product_id,
          v_original_item.product_name || CASE WHEN NULLIF(TRIM(v_original_item.account), '') IS NOT NULL THEN ' Cuenta ' || TRIM(v_original_item.account) ELSE '' END || ' (Downsell) - Periodo '
            || TO_CHAR(v_invoice.issue_date, 'DD/MM/YYYY') || ' a '
            || TO_CHAR(v_period_end, 'DD/MM/YYYY'),
          v_frequency_months,
          -v_unit_price, -v_unit_price,
          -v_subtotal, -v_subtotal,
          -v_tax_amount, -v_tax_amount,
          -v_total, -v_total,
          v_invoice.contract_currency, v_invoice.invoice_currency,
          1, 0,
          v_invoice.issue_date, v_period_end
        );
      END LOOP;
    END LOOP;

    PERFORM public.log_lifecycle_event(
      v_amend.contract_id,
      'DOWNSELL_APPLIED',
      'Downsell aplicado',
      v_amend.effective_date,
      v_total_delta,
      COALESCE(v_amend.reason, 'Downsell aplicado'),
      NULL,
      v_items
    );

  ELSIF v_amend.type = 'CROSS_SELL' THEN
    SELECT c.* INTO v_company
    FROM public.companies c
    WHERE c.id = v_contract.company_id;

    SELECT ce.* INTO v_client_entity
    FROM public.client_entities ce
    WHERE ce.id = v_contract.client_entity_id;

    v_tax_rate := COALESCE(v_company.tax_rate, 0);
    v_created_items := ARRAY[]::uuid[];

    FOR v_new_item_id IN
      INSERT INTO public.contract_items(
        product_id, contract_id, end_date, is_recurring, discount_value,
        final_price, price, start_date, quote_item_id, holding_id,
        billing_frequency, billing_method, discount_type, term_months,
        currency, product_name, categoria, unit_price, quantity, unit_of_measure,
        booking_date,
        price_entry_mode, annual_unit_price
      )
      SELECT
        NULLIF(cai.item_metadata->>'product_id','')::uuid,
        v_amend.contract_id,
        NULLIF(cai.item_metadata->>'end_date','')::date,
        COALESCE((cai.item_metadata->>'is_recurring')::boolean, true),
        NULLIF(cai.item_metadata->>'discount_value','')::numeric,
        COALESCE((cai.item_metadata->>'final_price')::numeric, (cai.item_metadata->>'price')::numeric),
        COALESCE((cai.item_metadata->>'final_price')::numeric, (cai.item_metadata->>'price')::numeric),
        COALESCE(NULLIF(cai.item_metadata->>'start_date','')::date, v_amend.effective_date),
        NULLIF(cai.item_metadata->>'quote_item_id','')::uuid,
        v_holding,
        COALESCE(cai.item_metadata->>'billing_frequency','Mensual'),
        COALESCE(cai.item_metadata->>'billing_method','Anticipado'),
        cai.item_metadata->>'discount_type',
        COALESCE((cai.item_metadata->>'term_months')::int, 12),
        COALESCE(cai.item_metadata->>'currency','USD'),
        COALESCE(cai.item_metadata->>'product_name','Item'),
        'CROSS-SELL',
        COALESCE((cai.item_metadata->>'unit_price')::numeric, (cai.item_metadata->>'price')::numeric, 0),
        COALESCE((cai.item_metadata->>'quantity')::numeric, 1),
        COALESCE(cai.item_metadata->>'unit_of_measure','unidad'),
        COALESCE(NULLIF(cai.item_metadata->>'booking_date','')::date, v_amend.effective_date),
        COALESCE(cai.item_metadata->>'price_entry_mode', 'monthly'),
        NULLIF(cai.item_metadata->>'annual_unit_price','')::numeric
      FROM public.contract_amendment_items cai
      WHERE cai.amendment_id = v_amend.id
      RETURNING id
    LOOP
      v_created_items := array_append(v_created_items, v_new_item_id);
      v_items := v_items || jsonb_build_array(jsonb_build_object('new_item_id', v_new_item_id::text));
    END LOOP;

    SELECT COALESCE(SUM(final_price),0) INTO v_total_delta
    FROM public.contract_items
    WHERE id = ANY(v_created_items);

    FOR v_item IN
      SELECT * FROM public.contract_items
      WHERE id = ANY(v_created_items)
    LOOP
      v_start_date := v_item.start_date;
      v_end_date := COALESCE(v_item.end_date, v_start_date + make_interval(months => v_item.term_months));
      v_current_date := v_start_date;

      v_frequency_months := CASE v_item.billing_frequency
        WHEN 'Mensual' THEN 1
        WHEN 'Trimestral' THEN 3
        WHEN 'Semestral' THEN 6
        WHEN 'Anual' THEN 12
        WHEN 'Bianual' THEN 24
        ELSE 1
      END;

      IF v_item.term_months > 0 THEN
        v_monthly_price := v_item.final_price / v_item.term_months;
      ELSE
        v_monthly_price := v_item.final_price;
      END IF;

      WHILE v_current_date <= v_end_date LOOP
        v_subtotal := v_monthly_price * v_frequency_months;
        v_tax_amount := v_subtotal * (v_tax_rate / 100);
        v_total := v_subtotal + v_tax_amount;

        v_period_end := (v_current_date + make_interval(months => v_frequency_months) - interval '1 day')::date;

        SELECT * INTO v_existing_invoice
        FROM public.invoices
        WHERE contract_id = v_amend.contract_id
          AND status = 'Por Emitir'
          AND COALESCE(is_legacy, false) = false
          AND TO_CHAR(issue_date, 'YYYY-MM') = TO_CHAR(v_current_date, 'YYYY-MM')
        LIMIT 1;

        IF v_existing_invoice.id IS NOT NULL THEN
          UPDATE public.invoices SET
            amount_contract_currency = amount_contract_currency + v_subtotal,
            amount_invoice_currency = amount_invoice_currency + v_subtotal,
            vat = vat + v_tax_amount,
            total_invoice_currency = total_invoice_currency + v_total
          WHERE id = v_existing_invoice.id;

          v_invoice_id := v_existing_invoice.id;
        ELSE
          INSERT INTO public.invoices(
            holding_id, contract_id, company_id, client_id, client_entity_id,
            scheduled_at, original_issue_date, issue_date, due_date, status,
            contract_currency, invoice_currency, amount_contract_currency,
            amount_invoice_currency, vat, total_invoice_currency,
            fx_contract_to_invoice, invoice_type, issuer_tax_id,
            issuer_legal_name, issuer_address, client_tax_id, notes
          ) VALUES (
            v_item.holding_id, v_item.contract_id, v_contract.company_id,
            v_contract.client_id, v_contract.client_entity_id, v_current_date,
            v_current_date, v_current_date, v_current_date, 'Por Emitir',
            v_item.currency, v_item.currency, v_subtotal, v_subtotal,
            v_tax_amount, v_total, 1.0,
            'Automatica',
            v_company.tax_id,
            v_company.legal_name, v_company.legal_address,
            v_client_entity.tax_id, COALESCE(v_amend.reason, 'Cross-sell')
          ) RETURNING id INTO v_invoice_id;
        END IF;

        v_unit_price := v_monthly_price;
        INSERT INTO public.invoice_items(
          holding_id, invoice_id, contract_item_id, product_id,
          description, quantity,
          unit_price_contract_currency, unit_price_invoice_currency,
          subtotal_contract_currency, subtotal_invoice_currency,
          tax_amount_contract_currency, tax_amount_invoice_currency,
          total_contract_currency, total_invoice_currency,
          contract_currency, invoice_currency,
          fx_contract_to_invoice, discount_pct,
          billing_period_start, billing_period_end
        ) VALUES (
          v_item.holding_id, v_invoice_id, v_item.id, v_item.product_id,
          v_item.product_name || CASE WHEN NULLIF(TRIM(v_item.account), '') IS NOT NULL THEN ' Cuenta ' || TRIM(v_item.account) ELSE '' END || ' - Periodo '
            || TO_CHAR(v_current_date, 'DD/MM/YYYY') || ' a '
            || TO_CHAR(v_period_end, 'DD/MM/YYYY'),
          COALESCE(v_item.quantity, 1),
          v_unit_price, v_unit_price,
          v_subtotal, v_subtotal,
          v_tax_amount, v_tax_amount,
          v_total, v_total,
          v_item.currency, v_item.currency,
          1, 0,
          v_current_date, v_period_end
        );

        v_current_date := v_current_date + make_interval(months => v_frequency_months);
      END LOOP;
    END LOOP;

    PERFORM public.log_lifecycle_event(
      v_amend.contract_id,
      'CROSS_SELL_APPLIED',
      'Cross-sell aplicado',
      v_amend.effective_date,
      v_total_delta,
      COALESCE(v_amend.reason, 'Cross-sell aplicado'),
      NULL,
      v_items
    );
  END IF;

  PERFORM public.recalc_revenue_for_contract(v_amend.contract_id);
  PERFORM public.reconcile_contract_status(v_amend.contract_id);

  RETURN jsonb_build_object(
    'status','approved',
    'type',v_amend.type,
    'amount_delta',v_total_delta,
    'items',v_items
  );
END;
$function$

