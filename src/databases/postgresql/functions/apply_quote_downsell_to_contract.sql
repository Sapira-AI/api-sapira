CREATE OR REPLACE FUNCTION public.apply_quote_downsell_to_contract(p_contract_id uuid, p_quote_id uuid, p_items jsonb, p_effective_date date, p_reason text DEFAULT NULL::text, p_notes text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_user_id            uuid;
  v_holding_id         uuid;
  v_contract           record;
  v_spec               jsonb;
  v_orig               record;
  v_quote_item_ids     uuid[] := ARRAY[]::uuid[];
  v_already            int;
  v_ds_qty             numeric;
  v_ds_unit            numeric;
  v_ds_term            int;
  v_ds_start           date;
  v_ds_end             date;
  v_ds_freq            text;
  v_ds_freq_months     int;
  v_ds_monthly         numeric;
  v_ds_final           numeric;
  v_new_monthly        numeric;
  v_orig_monthly       numeric;
  v_ds_item_id         uuid;
  v_inv                record;
  v_line               record;
  v_net_qty            numeric;
  v_ratio              numeric;
  v_repl_id            uuid;
  v_total_monthly_delta numeric := 0;
  v_value_delta        numeric := 0;
  v_affected_orig_ids  uuid[] := ARRAY[]::uuid[];
  v_ds_item_ids        uuid[] := ARRAY[]::uuid[];
  v_stage_id           uuid;
  v_n_items            int := 0;
  v_currency           text;
  v_rn_qty             numeric;
  v_rn_unit            numeric;
  v_rn_freq            text;
  v_rn_freq_months     int;
  v_rn_method          text;
  v_rn_start           date;
  v_rn_end             date;
  v_rn_term            int;
  v_rn_periods         int;
  v_rn_monthly         numeric;
  v_rn_period_amt      numeric;
  v_rn_final           numeric;
  v_rn_disc_type       text;
  v_rn_disc_val        numeric;
  v_rn_disc_factor     numeric;
  v_rn_item_id         uuid;
  v_rn_delta_monthly   numeric;
  v_rn_delta_final     numeric;
  v_old_term           int;
  v_old_monthly        numeric;
  v_old_final          numeric;
  v_firm_end           date;
  v_firm_count         int;
  v_months_off         int;
  v_candidate          date;
  v_freq_or_term_change boolean;
  v_touched            uuid[];
  v_i                  int;
  v_pstart             date;
  v_pend               date;
  v_sched              date;
  v_amount             numeric;
  v_vat                numeric;
  v_tax_rate           numeric;
  v_ref                record;
  v_new_inv_id         uuid;
  v_has_renegotiation  boolean := false;
  v_max_rn_end         date := NULL;
  v_rn_dq              numeric;
  v_rn_item_qty        numeric;
  v_rn_item_unit       numeric;
BEGIN
  v_user_id := public.get_current_user_id();
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'Usuario no autenticado'; END IF;
  v_holding_id := public.get_contract_holding(p_contract_id);
  IF v_holding_id IS NULL THEN RAISE EXCEPTION 'Contrato no encontrado o sin permisos'; END IF;

  IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'p_items no puede estar vacío';
  END IF;

  SELECT c.* INTO v_contract FROM public.contracts c WHERE c.id = p_contract_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Contrato % no encontrado', p_contract_id; END IF;
  v_currency := COALESCE(v_contract.contract_currency, 'USD');

  SELECT array_agg((s->>'quote_item_id')::uuid)
    INTO v_quote_item_ids
  FROM jsonb_array_elements(p_items) s
  WHERE NULLIF(s->>'quote_item_id','') IS NOT NULL;

  IF v_quote_item_ids IS NOT NULL AND array_length(v_quote_item_ids,1) > 0 THEN
    SELECT count(*) INTO v_already
    FROM public.contract_items
    WHERE quote_item_id = ANY(v_quote_item_ids);
    IF v_already > 0 THEN
      RAISE EXCEPTION 'Esta cotización ya fue procesada en un contrato (ítems enlazados). Revísalo antes de reintentar.';
    END IF;
  END IF;

  FOR v_spec IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    SELECT * INTO v_orig FROM public.contract_items
    WHERE id = (v_spec->>'related_item_id')::uuid
      AND contract_id = p_contract_id AND holding_id = v_holding_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Item relacionado % no encontrado en el contrato', v_spec->>'related_item_id';
    END IF;

    v_rn_qty  := NULLIF(v_spec->>'new_quantity','')::numeric;
    v_rn_unit := NULLIF(v_spec->>'new_unit_price','')::numeric;

    IF v_rn_qty IS NOT NULL AND v_rn_unit IS NOT NULL THEN
      IF v_rn_qty <= 0 OR v_rn_unit <= 0 THEN
        RAISE EXCEPTION 'La renegociación requiere cantidad y precio unitario nuevos mayores a 0 (item %). Para dejar el servicio en cero usa churn/cancelación.', v_orig.product_name;
      END IF;

      IF EXISTS (SELECT 1 FROM public.quantities q WHERE q.contract_item_id = v_orig.id) THEN
        RAISE EXCEPTION 'El item % tiene cantidades variables registradas: sus montos reales se manejan por período desde Cantidades Variables, no por renegociación. Corrige ahí o elimina los overrides primero.', v_orig.product_name;
      END IF;

      v_rn_freq := COALESCE(NULLIF(v_spec->>'new_billing_frequency',''), v_orig.billing_frequency, 'Mensual');
      v_rn_freq_months := COALESCE(NULLIF(public.get_frequency_months(v_rn_freq), 0), 1);
      v_rn_method := COALESCE(NULLIF(v_spec->>'billing_method',''), v_orig.billing_method, 'Anticipado');
      v_rn_start := COALESCE(NULLIF(v_spec->>'start_date','')::date, p_effective_date);
      v_rn_end   := COALESCE(NULLIF(v_spec->>'new_end_date','')::date, v_orig.end_date);

      IF v_rn_start <= v_orig.start_date THEN
        RAISE EXCEPTION 'La renegociación de % parte el % pero el item inicia el %: renegociar desde el inicio equivale a editar el item directamente (Editar Items).',
          v_orig.product_name, v_rn_start, v_orig.start_date;
      END IF;

      SELECT MAX(ii.billing_period_end), COUNT(*)
        INTO v_firm_end, v_firm_count
      FROM public.invoice_items ii
      JOIN public.invoices i ON i.id = ii.invoice_id
      WHERE ii.contract_item_id = v_orig.id
        AND COALESCE(i.is_active, true) = true
        AND i.status IN ('Emitida','Enviada','Vencida','Pagada');
      IF v_firm_end IS NOT NULL AND v_rn_start <= v_firm_end THEN
        RAISE EXCEPTION 'El item % ya tiene facturado en firme hasta el %: la renegociación debe partir el % o después. Para cambiar lo ya emitido corresponde nota de crédito.',
          v_orig.product_name, v_firm_end, v_firm_end + 1;
      END IF;

      v_months_off := ((EXTRACT(YEAR FROM v_rn_start) - EXTRACT(YEAR FROM v_orig.start_date)) * 12
                      + EXTRACT(MONTH FROM v_rn_start) - EXTRACT(MONTH FROM v_orig.start_date))::int;
      v_candidate := (v_orig.start_date + (v_months_off || ' months')::interval)::date;
      IF v_candidate <> v_rn_start THEN
        RAISE EXCEPTION 'La renegociación de % debe partir en un inicio de ciclo del item (día % de cada mes). La fecha % no calza; el inicio de ciclo más cercano es %.',
          v_orig.product_name, EXTRACT(DAY FROM v_orig.start_date), v_rn_start, v_candidate;
      END IF;

      v_rn_term := GREATEST(1, (
                    (EXTRACT(YEAR FROM (v_rn_end + 1)) - EXTRACT(YEAR FROM v_rn_start)) * 12
                    + EXTRACT(MONTH FROM (v_rn_end + 1)) - EXTRACT(MONTH FROM v_rn_start))::int);
      IF ((v_rn_start + (v_rn_term || ' months')::interval) - interval '1 day')::date <> v_rn_end THEN
        RAISE EXCEPTION 'El término renegociado de % (% al %) no es un número entero de meses. Ajusta la fecha de fin (ej: %).',
          v_orig.product_name, v_rn_start, v_rn_end,
          ((v_rn_start + (v_rn_term || ' months')::interval) - interval '1 day')::date;
      END IF;
      IF v_rn_term % v_rn_freq_months <> 0 THEN
        RAISE EXCEPTION 'El término renegociado de % (% meses) no es múltiplo de la frecuencia % (% meses por período). Ajusta término o frecuencia.',
          v_orig.product_name, v_rn_term, v_rn_freq, v_rn_freq_months;
      END IF;
      v_rn_periods := v_rn_term / v_rn_freq_months;

      v_rn_disc_type := COALESCE(NULLIF(v_spec->>'discount_type',''), v_orig.discount_type);
      v_rn_disc_val  := COALESCE(NULLIF(v_spec->>'discount_value','')::numeric, v_orig.discount_value, 0);
      v_rn_disc_factor := CASE WHEN v_rn_disc_type = 'Porcentaje' AND v_rn_disc_val > 0 AND v_rn_disc_val < 100
                               THEN 1 - v_rn_disc_val / 100.0 ELSE 1 END;
      v_rn_monthly := ROUND(v_rn_qty * v_rn_unit * v_rn_disc_factor, 2);
      v_rn_period_amt := ROUND(v_rn_monthly * v_rn_freq_months, 2);
      v_rn_final := ROUND(v_rn_monthly * v_rn_term, 2);

      v_orig_monthly := COALESCE(v_orig.monthly_price,
        CASE WHEN COALESCE(v_orig.term_months,0) > 0 THEN v_orig.final_price / v_orig.term_months ELSE 0 END);
      v_freq_or_term_change := (v_rn_freq_months <> COALESCE(NULLIF(public.get_frequency_months(v_orig.billing_frequency),0),1))
                               OR (v_rn_end IS DISTINCT FROM v_orig.end_date);
      IF NOT v_freq_or_term_change
         AND v_rn_qty = COALESCE(v_orig.quantity, 0)
         AND v_rn_unit = COALESCE(v_orig.unit_price, 0) THEN
        RAISE EXCEPTION 'La renegociación de % no cambia nada (misma cantidad, precio, frecuencia y término).', v_orig.product_name;
      END IF;

      v_touched := ARRAY[]::uuid[];

      IF NOT v_freq_or_term_change THEN
        v_rn_delta_monthly := ROUND(v_rn_monthly - v_orig_monthly, 2);
        IF v_rn_delta_monthly = 0 THEN
          RAISE EXCEPTION 'La renegociación de % no cambia el mensual (p×q − descuento queda igual). Si solo cambia el detalle cantidad/precio manteniendo el monto, edítalo por Editar Items.', v_orig.product_name;
        END IF;
        v_rn_delta_final := ROUND(v_rn_delta_monthly * v_rn_term, 2);
        v_rn_dq := v_rn_qty - COALESCE(v_orig.quantity, 0);
        IF v_rn_dq <> 0 THEN
          v_rn_item_qty := CASE WHEN v_rn_delta_monthly < 0 THEN -v_rn_dq ELSE v_rn_dq END;
        ELSE
          v_rn_item_qty := COALESCE(v_orig.quantity, 1);
        END IF;
        v_rn_item_unit := ROUND(v_rn_delta_monthly / NULLIF(v_rn_item_qty, 0), 6);

        INSERT INTO public.contract_items(
          contract_id, holding_id, product_id, product_name, categoria,
          related_item_id, quote_item_id, quote_item_number,
          quantity, unit_price, final_price, price,
          term_months, billing_method, billing_frequency, currency,
          start_date, end_date, is_recurring, item_type, unit_of_measure,
          discount_type, discount_value, custom_fields, booking_date, account
        ) VALUES (
          p_contract_id, v_holding_id,
          COALESCE(NULLIF(v_spec->>'product_id','')::uuid, v_orig.product_id),
          COALESCE(NULLIF(v_spec->>'product_name',''), v_orig.product_name),
          CASE WHEN v_rn_delta_monthly < 0 THEN 'DOWNSELL' ELSE 'UPSELL' END,
          v_orig.id, NULLIF(v_spec->>'quote_item_id','')::uuid, NULLIF(v_spec->>'quote_item_number',''),
          v_rn_item_qty, v_rn_item_unit,
          v_rn_delta_final, v_rn_delta_final,
          v_rn_term, v_rn_method, v_rn_freq,
          COALESCE(NULLIF(v_spec->>'currency',''), v_orig.currency, v_currency),
          v_rn_start, v_rn_end, true,
          COALESCE(NULLIF(v_spec->>'item_type',''), v_orig.item_type),
          COALESCE(NULLIF(v_spec->>'unit_of_measure',''), v_orig.unit_of_measure),
          NULL, NULL,
          COALESCE(v_spec->'custom_fields', NULL), p_effective_date, v_orig.account
        ) RETURNING id INTO v_rn_item_id;

        FOR v_line IN
          SELECT ii.*, i.tax_rate AS inv_tax_rate
          FROM public.invoice_items ii
          JOIN public.invoices i ON i.id = ii.invoice_id
          WHERE ii.contract_item_id = v_orig.id
            AND i.contract_id = p_contract_id
            AND i.status = 'Por Emitir'
            AND COALESCE(i.is_active, true) = true
            AND COALESCE(i.invoice_type, '') NOT IN ('Unificada','Consolidada')
            AND ii.billing_period_start IS NOT NULL
            AND ii.billing_period_start >= v_rn_start
        LOOP
          v_vat := ROUND(v_rn_period_amt * COALESCE(v_line.inv_tax_rate, 0) / 100.0, 2);
          UPDATE public.invoice_items SET
            quantity = v_rn_qty,
            discount_pct = CASE WHEN v_rn_disc_type = 'Porcentaje' AND v_rn_disc_val > 0 THEN v_rn_disc_val ELSE 0 END,
            unit_price_contract_currency = ROUND(v_rn_unit * v_rn_freq_months, 6),
            subtotal_contract_currency = v_rn_period_amt,
            tax_amount_contract_currency = v_vat,
            total_contract_currency = v_rn_period_amt + v_vat,
            description = COALESCE(v_orig.product_name, 'Servicio')
              || CASE WHEN NULLIF(TRIM(v_orig.account), '') IS NOT NULL THEN ' Cuenta ' || TRIM(v_orig.account) ELSE '' END
              || ' - Periodo ' || to_char(v_line.billing_period_start, 'DD/MM/YYYY')
              || ' a ' || to_char(v_line.billing_period_end, 'DD/MM/YYYY'),
            updated_at = now()
          WHERE id = v_line.id;
          v_touched := array_append(v_touched, v_line.invoice_id);
        END LOOP;

        v_total_monthly_delta := v_total_monthly_delta + (v_orig_monthly - v_rn_monthly);
        v_value_delta := v_value_delta + v_rn_delta_final;
      ELSE
        v_old_term := v_months_off;
        v_old_monthly := v_orig_monthly;
        v_old_final := ROUND(v_old_monthly * v_old_term, 2);
        UPDATE public.contract_items SET
          end_date = v_rn_start - 1,
          term_months = v_old_term,
          final_price = v_old_final,
          price = v_old_final
        WHERE id = v_orig.id;

        INSERT INTO public.contract_items(
          contract_id, holding_id, product_id, product_name, categoria,
          renews_item_id, quote_item_id, quote_item_number,
          quantity, unit_price, final_price, price,
          term_months, billing_method, billing_frequency, currency,
          start_date, end_date, is_recurring, item_type, unit_of_measure,
          discount_type, discount_value, custom_fields, booking_date, account
        ) VALUES (
          p_contract_id, v_holding_id,
          COALESCE(NULLIF(v_spec->>'product_id','')::uuid, v_orig.product_id),
          COALESCE(NULLIF(v_spec->>'product_name',''), v_orig.product_name), 'RENEWAL',
          v_orig.id, NULLIF(v_spec->>'quote_item_id','')::uuid, NULLIF(v_spec->>'quote_item_number',''),
          COALESCE(v_orig.quantity, 1), COALESCE(v_orig.unit_price, 0),
          ROUND(v_old_monthly * v_rn_term, 2), ROUND(v_old_monthly * v_rn_term, 2),
          v_rn_term, v_rn_method, v_rn_freq,
          COALESCE(NULLIF(v_spec->>'currency',''), v_orig.currency, v_currency),
          v_rn_start, v_rn_end, true,
          COALESCE(NULLIF(v_spec->>'item_type',''), v_orig.item_type),
          COALESCE(NULLIF(v_spec->>'unit_of_measure',''), v_orig.unit_of_measure),
          v_orig.discount_type, v_orig.discount_value,
          COALESCE(v_spec->'custom_fields', NULL), p_effective_date, v_orig.account
        ) RETURNING id INTO v_rn_item_id;

        -- Relacion de renovacion en el item cortado: la alerta de expiracion
        -- excluye items con renewed_by_item_id (feedback Domi 14-09, QA Cooprinsem).
        UPDATE public.contract_items SET renewed_by_item_id = v_rn_item_id WHERE id = v_orig.id;

        v_rn_delta_monthly := ROUND(v_rn_monthly - v_orig_monthly, 2);
        v_rn_delta_final := ROUND(v_rn_delta_monthly * v_rn_term, 2);
        v_rn_dq := v_rn_qty - COALESCE(v_orig.quantity, 0);
        IF v_rn_dq <> 0 THEN
          v_rn_item_qty := CASE WHEN v_rn_delta_monthly < 0 THEN -v_rn_dq ELSE v_rn_dq END;
        ELSE
          v_rn_item_qty := COALESCE(v_orig.quantity, 1);
        END IF;
        v_rn_item_unit := ROUND(v_rn_delta_monthly / NULLIF(v_rn_item_qty, 0), 6);
        IF v_rn_delta_monthly <> 0 THEN
          INSERT INTO public.contract_items(
            contract_id, holding_id, product_id, product_name, categoria,
            related_item_id, quantity, unit_price, final_price, price,
            term_months, billing_method, billing_frequency, currency,
            start_date, end_date, is_recurring, item_type, unit_of_measure,
            booking_date, account
          ) VALUES (
            p_contract_id, v_holding_id,
            COALESCE(NULLIF(v_spec->>'product_id','')::uuid, v_orig.product_id),
            COALESCE(NULLIF(v_spec->>'product_name',''), v_orig.product_name),
            CASE WHEN v_rn_delta_monthly < 0 THEN 'DOWNSELL' ELSE 'UPSELL' END,
            v_rn_item_id, v_rn_item_qty, v_rn_item_unit,
            v_rn_delta_final, v_rn_delta_final,
            v_rn_term, v_rn_method, v_rn_freq,
            COALESCE(NULLIF(v_spec->>'currency',''), v_orig.currency, v_currency),
            v_rn_start, v_rn_end, true,
            COALESCE(NULLIF(v_spec->>'item_type',''), v_orig.item_type),
            COALESCE(NULLIF(v_spec->>'unit_of_measure',''), v_orig.unit_of_measure),
            p_effective_date, v_orig.account
          );
        END IF;

        WITH del AS (
          DELETE FROM public.invoice_items ii
          USING public.invoices i
          WHERE ii.invoice_id = i.id
            AND ii.contract_item_id = v_orig.id
            AND i.contract_id = p_contract_id
            AND i.status = 'Por Emitir'
            AND COALESCE(i.is_active, true) = true
            AND COALESCE(i.invoice_type, '') NOT IN ('Unificada','Consolidada')
            AND ii.billing_period_start IS NOT NULL
            AND ii.billing_period_start >= v_rn_start
          RETURNING ii.invoice_id
        )
        SELECT COALESCE(array_agg(DISTINCT invoice_id), ARRAY[]::uuid[]) INTO v_touched FROM del;

        UPDATE public.invoices SET status = 'Cancelada', is_active = false
        WHERE id = ANY(v_touched) AND status = 'Por Emitir'
          AND NOT EXISTS (SELECT 1 FROM public.invoice_items ii WHERE ii.invoice_id = invoices.id);

        SELECT * INTO v_ref FROM public.invoices
        WHERE contract_id = p_contract_id AND holding_id = v_holding_id
          AND COALESCE(invoice_type, '') NOT IN ('Unificada','Consolidada')
          AND COALESCE(document_type, 'FACTURA') NOT IN ('NC','ND')
        ORDER BY created_at DESC LIMIT 1;
        v_tax_rate := COALESCE(v_ref.tax_rate, 0);

        FOR v_i IN 0..(v_rn_periods - 1) LOOP
          v_pstart := (v_rn_start + ((v_i * v_rn_freq_months) || ' months')::interval)::date;
          v_pend   := ((v_rn_start + (((v_i + 1) * v_rn_freq_months) || ' months')::interval) - interval '1 day')::date;
          IF LOWER(v_rn_method) LIKE '%vencid%' OR LOWER(v_rn_method) LIKE '%arrear%' THEN
            v_sched := v_pend + 1;
          ELSE
            v_sched := v_pstart;
          END IF;
          v_amount := CASE WHEN v_i = v_rn_periods - 1
                           THEN ROUND(v_rn_final - v_rn_period_amt * (v_rn_periods - 1), 2)
                           ELSE v_rn_period_amt END;
          v_vat := ROUND(v_amount * v_tax_rate / 100.0, 2);

          INSERT INTO public.invoices (
            contract_id, holding_id, client_id, company_id, client_entity_id,
            scheduled_at, original_issue_date, issue_date, due_date, status,
            invoice_type, document_type, contract_currency, invoice_currency,
            fx_contract_to_invoice, tax_rate, invoice_terms_and_conditions,
            issuer_legal_name, issuer_tax_id, issuer_address,
            split_reason, is_active, auto_invoice,
            client_tax_id, payment_method, invoice_series, fiscal_regime,
            export_type, requires_references_for_billing,
            amount_contract_currency, vat
          ) VALUES (
            p_contract_id, v_holding_id, v_contract.client_id,
            COALESCE(v_ref.company_id, v_contract.company_id),
            COALESCE(v_ref.client_entity_id, v_contract.client_entity_id),
            v_sched, v_sched, v_sched, v_sched + INTERVAL '30 days', 'Por Emitir',
            COALESCE(v_ref.invoice_type, 'Manual'), COALESCE(v_ref.document_type, 'FACTURA'),
            COALESCE(v_ref.contract_currency, v_contract.contract_currency),
            COALESCE(v_ref.invoice_currency, v_contract.invoice_currency),
            v_ref.fx_contract_to_invoice, v_ref.tax_rate, v_ref.invoice_terms_and_conditions,
            v_ref.issuer_legal_name, v_ref.issuer_tax_id, v_ref.issuer_address,
            'item_renegotiation', true, COALESCE(v_ref.auto_invoice, false),
            v_ref.client_tax_id, v_ref.payment_method, v_ref.invoice_series, v_ref.fiscal_regime,
            v_ref.export_type, v_ref.requires_references_for_billing,
            v_amount, v_vat
          ) RETURNING id INTO v_new_inv_id;

          INSERT INTO public.invoice_items (
            invoice_id, holding_id, contract_id, contract_item_id, product_id,
            description, billing_period_start, billing_period_end,
            quantity, unit_of_measure, discount_pct,
            unit_price_contract_currency, subtotal_contract_currency,
            tax_amount_contract_currency, total_contract_currency,
            contract_currency, invoice_currency, tax_code
          ) VALUES (
            v_new_inv_id, v_holding_id, p_contract_id, v_rn_item_id, COALESCE(NULLIF(v_spec->>'product_id','')::uuid, v_orig.product_id),
            COALESCE(v_orig.product_name, 'Servicio')
              || CASE WHEN NULLIF(TRIM(v_orig.account), '') IS NOT NULL THEN ' Cuenta ' || TRIM(v_orig.account) ELSE '' END
              || ' - Periodo ' || to_char(v_pstart, 'DD/MM/YYYY') || ' a ' || to_char(v_pend, 'DD/MM/YYYY'),
            v_pstart, v_pend,
            v_rn_qty, COALESCE(v_orig.unit_of_measure, 'UND'),
            CASE WHEN v_rn_disc_type = 'Porcentaje' AND v_rn_disc_val > 0 THEN v_rn_disc_val ELSE 0 END,
            ROUND(v_rn_unit * v_rn_freq_months, 6), v_amount,
            v_vat, v_amount + v_vat,
            COALESCE(v_ref.contract_currency, v_contract.contract_currency),
            COALESCE(v_ref.invoice_currency, v_contract.invoice_currency),
            COALESCE(v_tax_rate::text, '0')
          );
          UPDATE public.invoice_items SET
            quantity = v_rn_qty,
            unit_price_contract_currency = ROUND(v_rn_unit * v_rn_freq_months, 6),
            subtotal_contract_currency = v_amount,
            tax_amount_contract_currency = v_vat,
            total_contract_currency = v_amount + v_vat
          WHERE invoice_id = v_new_inv_id AND contract_item_id = v_rn_item_id;
          v_touched := array_append(v_touched, v_new_inv_id);
        END LOOP;

        v_total_monthly_delta := v_total_monthly_delta + (v_old_monthly - v_rn_monthly);
        v_value_delta := v_value_delta + (v_old_final + v_rn_final - COALESCE(v_orig.final_price, 0));
        IF v_rn_end IS NOT NULL AND (v_max_rn_end IS NULL OR v_rn_end > v_max_rn_end) THEN
          v_max_rn_end := v_rn_end;
        END IF;
      END IF;

      UPDATE public.invoices i SET
        amount_contract_currency = COALESCE(sums.subtotal, 0),
        vat = CASE WHEN i.fx_contract_to_invoice IS NULL THEN NULL ELSE COALESCE(sums.vat, 0) END,
        total_invoice_currency = CASE WHEN i.fx_contract_to_invoice IS NULL THEN NULL ELSE COALESCE(sums.total, 0) * i.fx_contract_to_invoice END,
        amount_invoice_currency = CASE WHEN i.fx_contract_to_invoice IS NULL THEN NULL ELSE COALESCE(sums.subtotal, 0) * i.fx_contract_to_invoice END
      FROM (
        SELECT invoice_id, SUM(subtotal_contract_currency) AS subtotal,
               SUM(tax_amount_contract_currency) AS vat, SUM(total_contract_currency) AS total
        FROM public.invoice_items WHERE invoice_id = ANY(v_touched) GROUP BY invoice_id
      ) sums WHERE i.id = sums.invoice_id AND COALESCE(i.is_active, true) = true;

      UPDATE public.invoice_items ii SET
        fx_contract_to_invoice      = inv.fx_contract_to_invoice,
        unit_price_invoice_currency = CASE WHEN inv.fx_contract_to_invoice IS NULL THEN NULL ELSE ii.unit_price_contract_currency * inv.fx_contract_to_invoice END,
        subtotal_invoice_currency   = CASE WHEN inv.fx_contract_to_invoice IS NULL THEN NULL ELSE ii.subtotal_contract_currency * inv.fx_contract_to_invoice END,
        tax_amount_invoice_currency = CASE WHEN inv.fx_contract_to_invoice IS NULL THEN NULL ELSE ii.tax_amount_contract_currency * inv.fx_contract_to_invoice END,
        total_invoice_currency      = CASE WHEN inv.fx_contract_to_invoice IS NULL THEN NULL ELSE ii.total_contract_currency * inv.fx_contract_to_invoice END
      FROM public.invoices inv
      WHERE ii.invoice_id = inv.id AND inv.id = ANY(v_touched)
        AND ii.contract_item_id IN (v_rn_item_id, v_orig.id);

      v_has_renegotiation := true;
      v_ds_item_ids       := array_append(v_ds_item_ids, v_rn_item_id);
      v_affected_orig_ids := array_append(v_affected_orig_ids, v_orig.id);
      v_n_items := v_n_items + 1;
      CONTINUE;
    END IF;

    v_ds_qty  := (v_spec->>'quantity')::numeric;
    v_new_monthly := NULLIF(v_spec->>'new_monthly','')::numeric;
    v_ds_unit := ABS(COALESCE(NULLIF(v_spec->>'unit_price','')::numeric, v_orig.unit_price, 0));
    v_ds_start := COALESCE(NULLIF(v_spec->>'start_date','')::date, p_effective_date);
    v_ds_end   := LEAST(COALESCE(NULLIF(v_spec->>'end_date','')::date, v_orig.end_date), v_orig.end_date);
    v_ds_term  := GREATEST(1, (
                    (EXTRACT(YEAR FROM (v_ds_end + 1)) - EXTRACT(YEAR FROM v_ds_start)) * 12
                    + EXTRACT(MONTH FROM (v_ds_end + 1)) - EXTRACT(MONTH FROM v_ds_start))::int);
    v_ds_freq := COALESCE(NULLIF(v_spec->>'billing_frequency',''), v_orig.billing_frequency, 'Mensual');
    v_ds_freq_months := COALESCE(NULLIF(public.get_frequency_months(v_ds_freq), 0), 1);

    IF v_new_monthly IS NOT NULL THEN
      v_orig_monthly := COALESCE(v_orig.monthly_price, 0);
      IF v_orig_monthly <= 0 THEN
        RAISE EXCEPTION 'El item % no tiene mensual (monthly_price) válido para rebajar por precio', v_orig.product_name;
      END IF;
      IF v_new_monthly <= 0 THEN
        RAISE EXCEPTION 'El nuevo mensual debe ser > 0 — rebajar a 0 es cancelación total, no rebaja parcial. Usa churn/cancelar item (item %).',
          v_orig.product_name;
      END IF;
      IF v_new_monthly >= v_orig_monthly THEN
        RAISE EXCEPTION 'El nuevo mensual (%) debe ser menor al actual (%) para representar una reducción (item %)',
          v_new_monthly, v_orig_monthly, v_orig.product_name;
      END IF;
      v_ds_monthly := ROUND(v_orig_monthly - v_new_monthly, 2);
      v_ds_qty  := COALESCE(v_orig.quantity, 1);
      v_ds_unit := ROUND(v_ds_monthly / NULLIF(v_ds_qty, 0), 6);
    ELSE
      IF v_ds_qty IS NULL OR v_ds_qty <= 0 THEN
        RAISE EXCEPTION 'La cantidad del downsell debe ser > 0 (item %)', v_orig.product_name;
      END IF;
      IF v_ds_qty > COALESCE(v_orig.quantity, 0) THEN
        RAISE EXCEPTION 'El downsell quita % unidades pero el item tiene % - no se puede quitar mas de lo existente (item %).',
          v_ds_qty, v_orig.quantity, v_orig.product_name;
      END IF;

      IF COALESCE(v_orig.monthly_price, 0) <> 0 AND COALESCE(v_orig.quantity, 0) <> 0 THEN
        v_ds_monthly := ROUND((v_orig.monthly_price / v_orig.quantity) * v_ds_qty, 2);
      ELSE
        v_ds_monthly := ROUND(v_ds_unit * v_ds_qty, 2);
      END IF;
    END IF;
    v_ds_final   := -(v_ds_monthly * v_ds_term);

    INSERT INTO public.contract_items(
      contract_id, holding_id, product_id, product_name, categoria,
      related_item_id, quote_item_id, quote_item_number,
      quantity, unit_price, final_price, price,
      term_months, billing_method, billing_frequency, currency,
      start_date, end_date, is_recurring, item_type, unit_of_measure,
      discount_type, discount_value, custom_fields, booking_date
    ) VALUES (
      p_contract_id, v_holding_id,
      COALESCE(NULLIF(v_spec->>'product_id','')::uuid, v_orig.product_id),
      COALESCE(NULLIF(v_spec->>'product_name',''), v_orig.product_name), 'DOWNSELL',
      v_orig.id, NULLIF(v_spec->>'quote_item_id','')::uuid, NULLIF(v_spec->>'quote_item_number',''),
      v_ds_qty, -v_ds_unit, v_ds_final, v_ds_final,
      v_ds_term, COALESCE(NULLIF(v_spec->>'billing_method',''), v_orig.billing_method),
      v_ds_freq, COALESCE(NULLIF(v_spec->>'currency',''), v_orig.currency, v_currency),
      v_ds_start,
      v_ds_end,
      true,
      COALESCE(NULLIF(v_spec->>'item_type',''), v_orig.item_type),
      COALESCE(NULLIF(v_spec->>'unit_of_measure',''), v_orig.unit_of_measure),
      COALESCE(NULLIF(v_spec->>'discount_type',''), v_orig.discount_type),
      COALESCE(NULLIF(v_spec->>'discount_value','')::numeric, v_orig.discount_value),
      COALESCE(v_spec->'custom_fields', NULL), p_effective_date
    ) RETURNING id INTO v_ds_item_id;

    v_ds_item_ids       := array_append(v_ds_item_ids, v_ds_item_id);
    v_affected_orig_ids := array_append(v_affected_orig_ids, v_orig.id);
    v_total_monthly_delta := v_total_monthly_delta + v_ds_monthly;
    v_value_delta := v_value_delta + v_ds_final;
    v_n_items := v_n_items + 1;

    FOR v_inv IN
      SELECT DISTINCT i.id, i.status
      FROM public.invoices i
      JOIN public.invoice_items ii ON ii.invoice_id = i.id
      WHERE i.contract_id = p_contract_id
        AND i.holding_id = v_holding_id
        AND i.is_active = true
        AND ii.contract_item_id = v_orig.id
        AND ii.billing_period_start IS NOT NULL
        AND ii.billing_period_start >= v_ds_start
        AND i.status <> 'Cancelada'
    LOOP
      IF v_inv.status = 'Por Emitir' THEN
        FOR v_line IN
          SELECT * FROM public.invoice_items
          WHERE invoice_id = v_inv.id AND contract_item_id = v_orig.id
        LOOP
          IF v_new_monthly IS NOT NULL THEN
            v_ratio := v_new_monthly / v_orig_monthly;
            UPDATE public.invoice_items SET
              unit_price_contract_currency = ROUND(v_line.unit_price_contract_currency * v_ratio, 6),
              unit_price_invoice_currency  = ROUND(v_line.unit_price_invoice_currency  * v_ratio, 6),
              subtotal_contract_currency   = ROUND(COALESCE(v_line.subtotal_contract_currency,0) * v_ratio, 2),
              subtotal_invoice_currency    = ROUND(COALESCE(v_line.subtotal_invoice_currency,0)  * v_ratio, 2),
              tax_amount_contract_currency = ROUND(COALESCE(v_line.tax_amount_contract_currency,0)* v_ratio, 2),
              tax_amount_invoice_currency  = ROUND(COALESCE(v_line.tax_amount_invoice_currency,0) * v_ratio, 2),
              total_contract_currency      = ROUND(COALESCE(v_line.total_contract_currency,0)     * v_ratio, 2),
              total_invoice_currency       = ROUND(COALESCE(v_line.total_invoice_currency,0)      * v_ratio, 2)
            WHERE id = v_line.id;
          ELSE
            v_net_qty := COALESCE(v_line.quantity, 0) - v_ds_qty;
            IF v_net_qty <= 0 THEN
              DELETE FROM public.invoice_items WHERE id = v_line.id;
              CONTINUE;
            END IF;
            v_ratio := v_net_qty / NULLIF(v_line.quantity, 0);
            UPDATE public.invoice_items SET
              quantity                     = v_net_qty,
              subtotal_contract_currency   = ROUND(COALESCE(v_line.subtotal_contract_currency,0) * v_ratio, 2),
              subtotal_invoice_currency    = ROUND(COALESCE(v_line.subtotal_invoice_currency,0)  * v_ratio, 2),
              tax_amount_contract_currency = ROUND(COALESCE(v_line.tax_amount_contract_currency,0)* v_ratio, 2),
              tax_amount_invoice_currency  = ROUND(COALESCE(v_line.tax_amount_invoice_currency,0) * v_ratio, 2),
              total_contract_currency      = ROUND(COALESCE(v_line.total_contract_currency,0)     * v_ratio, 2),
              total_invoice_currency       = ROUND(COALESCE(v_line.total_invoice_currency,0)      * v_ratio, 2)
            WHERE id = v_line.id;
          END IF;
        END LOOP;
        PERFORM public._recalc_invoice_header_from_items(v_inv.id);
        IF NOT EXISTS (SELECT 1 FROM public.invoice_items WHERE invoice_id = v_inv.id) THEN
          UPDATE public.invoices SET status = 'Cancelada' WHERE id = v_inv.id AND status = 'Por Emitir';
        END IF;

      ELSIF v_inv.status IN ('Emitida','Enviada','Vencida','Pagada') THEN
        SELECT new_invoice_id INTO v_repl_id
        FROM public.create_credit_note_safe(
          v_inv.id, 'cancellation'::public.credit_note_type, 'downsell'::public.credit_note_reason,
          NULL, COALESCE(p_notes, 'Downsell'), CURRENT_DATE, NULL, NULL, NULL
        );

        IF v_repl_id IS NOT NULL THEN
          FOR v_line IN
            SELECT * FROM public.invoice_items
            WHERE invoice_id = v_repl_id AND contract_item_id = v_orig.id
          LOOP
            IF v_new_monthly IS NOT NULL THEN
              v_ratio := v_new_monthly / v_orig_monthly;
              UPDATE public.invoice_items SET
                unit_price_contract_currency = ROUND(v_line.unit_price_contract_currency * v_ratio, 6),
                unit_price_invoice_currency  = ROUND(v_line.unit_price_invoice_currency  * v_ratio, 6),
                subtotal_contract_currency   = ROUND(COALESCE(v_line.subtotal_contract_currency,0) * v_ratio, 2),
                subtotal_invoice_currency    = ROUND(COALESCE(v_line.subtotal_invoice_currency,0)  * v_ratio, 2),
                tax_amount_contract_currency = ROUND(COALESCE(v_line.tax_amount_contract_currency,0)* v_ratio, 2),
                tax_amount_invoice_currency  = ROUND(COALESCE(v_line.tax_amount_invoice_currency,0) * v_ratio, 2),
                total_contract_currency      = ROUND(COALESCE(v_line.total_contract_currency,0)     * v_ratio, 2),
                total_invoice_currency       = ROUND(COALESCE(v_line.total_invoice_currency,0)      * v_ratio, 2)
              WHERE id = v_line.id;
            ELSE
              v_net_qty := COALESCE(v_line.quantity, 0) - v_ds_qty;
              IF v_net_qty <= 0 THEN
                DELETE FROM public.invoice_items WHERE id = v_line.id;
                CONTINUE;
              END IF;
              v_ratio := v_net_qty / NULLIF(v_line.quantity, 0);
              UPDATE public.invoice_items SET
                quantity                     = v_net_qty,
                subtotal_contract_currency   = ROUND(COALESCE(v_line.subtotal_contract_currency,0) * v_ratio, 2),
                subtotal_invoice_currency    = ROUND(COALESCE(v_line.subtotal_invoice_currency,0)  * v_ratio, 2),
                tax_amount_contract_currency = ROUND(COALESCE(v_line.tax_amount_contract_currency,0)* v_ratio, 2),
                tax_amount_invoice_currency  = ROUND(COALESCE(v_line.tax_amount_invoice_currency,0) * v_ratio, 2),
                total_contract_currency      = ROUND(COALESCE(v_line.total_contract_currency,0)     * v_ratio, 2),
                total_invoice_currency       = ROUND(COALESCE(v_line.total_invoice_currency,0)      * v_ratio, 2)
              WHERE id = v_line.id;
            END IF;
          END LOOP;
          PERFORM public._recalc_invoice_header_from_items(v_repl_id);
          IF NOT EXISTS (SELECT 1 FROM public.invoice_items WHERE invoice_id = v_repl_id) THEN
            UPDATE public.invoices SET status = 'Cancelada' WHERE id = v_repl_id AND status = 'Por Emitir';
          END IF;
        END IF;
      END IF;
    END LOOP;
  END LOOP;

  IF v_max_rn_end IS NOT NULL AND v_max_rn_end > COALESCE(v_contract.contract_end_date, v_max_rn_end - 1) THEN
    PERFORM set_config('sapira.bypass_end_date_guard', 'on', true);
    UPDATE public.contracts SET contract_end_date = v_max_rn_end WHERE id = p_contract_id;
    PERFORM set_config('sapira.bypass_end_date_guard', 'off', true);
  END IF;

  PERFORM public.log_lifecycle_event(
    p_contract_id,
    CASE WHEN v_has_renegotiation AND v_total_monthly_delta < 0 THEN 'UPSELL' ELSE 'DOWNSELL' END,
    CASE WHEN v_has_renegotiation THEN 'Renegociación de ítem(s)' ELSE 'Reducción parcial (downsell)' END,
    p_effective_date, -v_total_monthly_delta,
    'Items afectados: ' || v_n_items::text
      || '. Delta mensual: ' || v_currency || ' ' || ROUND(-v_total_monthly_delta, 2)::text,
    COALESCE(NULLIF(p_reason,''), CASE WHEN v_has_renegotiation THEN 'Renegociación' ELSE 'Downsell parcial' END),
    jsonb_build_object(
      'timing', 'early',
      'item_ids', to_jsonb(v_affected_orig_ids),
      'downsell_item_ids', to_jsonb(v_ds_item_ids),
      'total_mrr_delta', v_total_monthly_delta,
      'renegotiation', v_has_renegotiation,
      'source_quote_id', p_quote_id
    ),
    'early', 'Recorded'
  );

  IF v_value_delta <> 0 THEN
    UPDATE public.contracts
    SET total_value = ROUND(COALESCE(total_value,0) + v_value_delta, 2)
    WHERE id = p_contract_id;
  END IF;

  SELECT id INTO v_stage_id FROM public.quote_stages
  WHERE name = 'Contrato creado' AND holding_id = v_holding_id;
  IF v_stage_id IS NOT NULL AND p_quote_id IS NOT NULL THEN
    UPDATE public.quotes SET quote_stage_id = v_stage_id WHERE id = p_quote_id;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'downsell_items', v_n_items,
    'downsell_item_ids', to_jsonb(v_ds_item_ids),
    'total_mrr_delta', ROUND(v_total_monthly_delta, 2),
    'renegotiation', v_has_renegotiation,
    'currency', v_currency,
    'effective_date', p_effective_date
  );
END;
$function$

