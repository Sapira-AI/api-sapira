CREATE OR REPLACE FUNCTION public.apply_contract_contraction(p_contract_id uuid, p_type text, p_items jsonb, p_effective_date date, p_reason_id uuid DEFAULT NULL::uuid, p_notes text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_user_id uuid; v_holding_id uuid; v_contract record; v_item record; v_item_spec jsonb;
  v_monthly_orig numeric; v_monthly_new numeric; v_delta_monthly numeric;
  v_timing text; v_period_month date; v_reason_name text;
  v_affected_item_ids uuid[] := ARRAY[]::uuid[]; v_total_delta numeric := 0;
  v_company_currency text; v_contract_currency text; v_system_currency text; v_item_currency text;
  v_fantasma_id uuid; v_fantasma_start date; v_fantasma_end date; v_fantasma_term int;
  v_fantasma_annual_unit_price numeric;
  v_remaining_active int; v_auto_cancel boolean := false; v_has_direct_row boolean := false;
  v_original_status text;
  -- FIX 2.11: variables para generación de NCs en timing=early
  v_early_item_ids uuid[] := ARRAY[]::uuid[];
  v_emitted_invoice RECORD;
  v_emitted_item RECORD;
  v_nc_invoice_id uuid;
  v_nc_ratio numeric;
  v_nc_subtotal numeric;
  v_nc_tax numeric;
  v_nc_total_subtotal numeric;
  v_nc_total_tax numeric;
  v_ncs_generated_count int := 0;
  v_ncs_total_amount numeric := 0;
  v_ncs_created_ids uuid[] := ARRAY[]::uuid[];
  -- F3: prorrateo por días + bypass standardize + PE parcial + rebuild garantizado
  v_total_days int;
  v_canceled_days int;
  v_canceled_from date;
  v_served_days int;
  v_pe_ratio numeric;
  v_nc_items_count int;
  v_new_item_id uuid;
  v_fx_system_ratio numeric;
  v_pe_item RECORD;
  v_pe_adjusted_invoice_ids uuid[] := ARRAY[]::uuid[];
  v_pe_adjusted_count int := 0;
  v_pe_inv_id uuid;
  -- IVA: SIEMPRE neto × tax_rate de la factura (regla de negocio 2026-07-27),
  -- nunca prorratear/escalar el IVA almacenado.
  v_new_sub_c numeric;
  v_new_sub_i numeric;
  v_new_tax_c numeric;
  v_new_tax_i numeric;
BEGIN
  v_user_id := public.get_current_user_id();
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'Usuario no autenticado'; END IF;
  v_holding_id := public.get_contract_holding(p_contract_id);
  IF v_holding_id IS NULL THEN RAISE EXCEPTION 'Contrato no encontrado o sin permisos'; END IF;
  IF p_type NOT IN ('CHURN', 'DOWNSELL') THEN
    RAISE EXCEPTION 'p_type inválido: debe ser CHURN o DOWNSELL (recibido: %)', p_type;
  END IF;
  IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'p_items no puede estar vacío';
  END IF;

  SELECT c.*, co.currency AS company_currency_resolved,
         COALESCE(hs.system_currency, 'USD') AS system_currency_resolved
  INTO v_contract
  FROM public.contracts c
  LEFT JOIN public.companies co ON co.id = c.company_id
  LEFT JOIN public.holding_settings hs ON hs.holding_id = c.holding_id
  WHERE c.id = p_contract_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Contrato % no encontrado', p_contract_id; END IF;

  v_contract_currency := COALESCE(v_contract.contract_currency, 'USD');
  v_company_currency := COALESCE(v_contract.company_currency_resolved, v_contract_currency);
  v_system_currency := v_contract.system_currency_resolved;
  v_original_status := v_contract.status;

  IF p_reason_id IS NOT NULL THEN
    SELECT name INTO v_reason_name FROM public.churn_reasons
    WHERE id = p_reason_id AND holding_id = v_holding_id AND is_active;
    IF NOT FOUND THEN RAISE EXCEPTION 'Razón % no encontrada o inactiva en el holding', p_reason_id; END IF;
  END IF;

  FOR v_item_spec IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    SELECT * INTO v_item FROM public.contract_items
    WHERE id = (v_item_spec->>'item_id')::uuid
      AND contract_id = p_contract_id AND holding_id = v_holding_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Item % no encontrado en el contrato', v_item_spec->>'item_id'; END IF;
    IF v_item.churn_date IS NOT NULL THEN
      RAISE EXCEPTION 'Item % (%) ya fue contraído previamente (churn_date=%)',
        v_item.id, v_item.product_name, v_item.churn_date;
    END IF;

    v_monthly_orig := COALESCE(
      v_item.monthly_price,
      CASE WHEN COALESCE(v_item.term_months, 0) > 0
        THEN COALESCE(v_item.final_price, v_item.price, 0) / v_item.term_months
        ELSE COALESCE(v_item.final_price, v_item.price, 0)
      END
    );

    IF v_item_spec ? 'new_monthly_amount' THEN
      v_monthly_new := (v_item_spec->>'new_monthly_amount')::numeric;
    ELSE v_monthly_new := 0; END IF;

    v_delta_monthly := v_monthly_orig - v_monthly_new;
    -- Ítems con mensual 0 (informativos, ej. TMS 1×$0) no aportan a la
    -- reducción: no deben bloquear el churn/downsell completo del contrato
    -- (caso CTR-2026-147 Porvenir, 2026-08-21). En CHURN se marcan
    -- churneados directo (sin NC/delta) para que el conteo de ítems
    -- activos y el auto-cancel del contrato funcionen; en DOWNSELL
    -- simplemente se saltan.
    IF v_monthly_orig = 0 AND v_monthly_new = 0 THEN
      IF p_type = 'CHURN' THEN
        UPDATE public.contract_items SET churn_date = p_effective_date
        WHERE id = v_item.id;
        v_affected_item_ids := array_append(v_affected_item_ids, v_item.id);
      END IF;
      CONTINUE;
    END IF;
    IF v_delta_monthly <= 0 THEN
      RAISE EXCEPTION 'Item %: el nuevo monto (%) debe ser menor al actual (%) para representar una reducción',
        v_item.product_name, v_monthly_new, v_monthly_orig;
    END IF;

    v_item_currency := COALESCE(v_item.currency, v_contract_currency);

    IF v_item.end_date IS NOT NULL AND (p_effective_date = v_item.end_date + INTERVAL '1 day')::boolean THEN
      v_timing := 'non_renewal';
      v_period_month := DATE_TRUNC('month', p_effective_date)::date;
    ELSIF v_item.end_date IS NOT NULL AND p_effective_date > v_item.end_date THEN
      v_timing := 'non_renewal';
      v_period_month := DATE_TRUNC('month', v_item.end_date + INTERVAL '1 day')::date;
    ELSE
      v_timing := 'early';
      v_period_month := DATE_TRUNC('month', p_effective_date)::date;
    END IF;

    IF v_timing = 'early' THEN
      v_fantasma_start := DATE_TRUNC('month', p_effective_date)::date;
      -- F3: end del ítem espejo SIEMPRE = end_date del ítem que descuenta
      v_fantasma_end := v_item.end_date;
      v_fantasma_term := GREATEST(1,
        ((EXTRACT(YEAR FROM v_fantasma_end) - EXTRACT(YEAR FROM v_fantasma_start)) * 12
         + EXTRACT(MONTH FROM v_fantasma_end) - EXTRACT(MONTH FROM v_fantasma_start) + 1)::int);

      v_fantasma_annual_unit_price := CASE
        WHEN v_item.price_entry_mode = 'annual' THEN -v_delta_monthly * 12
        ELSE NULL
      END;

      INSERT INTO public.contract_items(
        id, contract_id, holding_id, product_id, product_name, categoria,
        start_date, end_date, term_months,
        quantity, unit_price, annual_unit_price, price_entry_mode,
        final_price, price,
        currency, billing_frequency, billing_method,
        is_recurring, related_item_id,
        item_type, unit_of_measure, booking_date
      ) VALUES (
        gen_random_uuid(), p_contract_id, v_holding_id, v_item.product_id,
        v_item.product_name, p_type,
        v_fantasma_start, v_fantasma_end, v_fantasma_term,
        COALESCE(v_item.quantity, 1),
        -v_delta_monthly, v_fantasma_annual_unit_price,
        COALESCE(v_item.price_entry_mode, 'monthly'),
        -v_delta_monthly * v_fantasma_term, -v_delta_monthly * v_fantasma_term,
        v_item_currency, COALESCE(v_item.billing_frequency, 'Mensual'), v_item.billing_method,
        true, v_item.id, v_item.item_type, v_item.unit_of_measure,
        p_effective_date
      ) RETURNING id INTO v_fantasma_id;

      UPDATE public.contract_items SET end_date = v_fantasma_end
      WHERE id = v_fantasma_id AND end_date <> v_fantasma_end;
    END IF;

    UPDATE public.contract_items
    SET churn_date = p_effective_date, churn_monthly_amount = v_delta_monthly
    WHERE id = v_item.id;

    -- FIX 2.11: trackear items con timing='early' para generación de NCs posterior
    IF v_timing = 'early' THEN
      v_early_item_ids := array_append(v_early_item_ids, v_item.id);
    END IF;

    IF v_timing = 'non_renewal' THEN
      INSERT INTO public.revenue_schedule_monthly(
        contract_id, contract_item_id, holding_id, company_id, period_month,
        momentum,
        mrr_period_contract_ccy, mrr_period_contracted_contract_ccy, cmrr_period_contract_ccy,
        mrr_period_system_ccy, mrr_period_contracted_system_ccy, cmrr_period_system_ccy,
        mrr_period_ccy, mrr_period_contracted_ccy, cmrr_period_ccy,
        company_currency, contract_currency, system_currency
      ) VALUES (
        p_contract_id, v_item.id, v_holding_id, v_contract.company_id, v_period_month, p_type,
        -v_delta_monthly, -v_delta_monthly, -v_delta_monthly,
        0, 0, 0, 0, 0, 0,
        v_company_currency, v_contract_currency, v_system_currency
      )
      ON CONFLICT (contract_id, contract_item_id, period_month, momentum) DO UPDATE SET
        mrr_period_contract_ccy            = EXCLUDED.mrr_period_contract_ccy,
        mrr_period_contracted_contract_ccy = EXCLUDED.mrr_period_contracted_contract_ccy,
        cmrr_period_contract_ccy           = EXCLUDED.cmrr_period_contract_ccy,
        mrr_period_system_ccy              = EXCLUDED.mrr_period_system_ccy,
        mrr_period_contracted_system_ccy   = EXCLUDED.mrr_period_contracted_system_ccy,
        cmrr_period_system_ccy             = EXCLUDED.cmrr_period_system_ccy,
        mrr_period_ccy                     = EXCLUDED.mrr_period_ccy,
        mrr_period_contracted_ccy          = EXCLUDED.mrr_period_contracted_ccy,
        cmrr_period_ccy                    = EXCLUDED.cmrr_period_ccy,
        company_currency                   = EXCLUDED.company_currency,
        contract_currency                  = EXCLUDED.contract_currency,
        system_currency                    = EXCLUDED.system_currency,
        updated_at                         = now();
      v_has_direct_row := true;
    END IF;

    v_affected_item_ids := array_append(v_affected_item_ids, v_item.id);
    v_total_delta := v_total_delta + v_delta_monthly;
  END LOOP;

  -- (F3) El rebuild de RSM se ejecuta SIEMPRE al final de la función.

  UPDATE public.invoices i
  SET status = 'Cancelada',
      notes = COALESCE(notes || E'\n', '')
              || 'Cancelada por ' || p_type || ' del contrato'
              || COALESCE(' — ' || v_reason_name, '')
  WHERE i.contract_id = p_contract_id AND i.holding_id = v_holding_id
    AND i.status IN ('Por Emitir', 'Programada')
    AND EXISTS (
      SELECT 1 FROM public.invoice_items ii
      WHERE ii.invoice_id = i.id AND ii.contract_item_id = ANY(v_affected_item_ids)
        AND ((ii.billing_period_start IS NOT NULL AND ii.billing_period_start >= p_effective_date)
          OR (ii.billing_period_start IS NULL AND i.scheduled_at > p_effective_date))
    );

  -- F3 (bug PE colgada): ajustar proporcionalmente por días servidos la PE cuyo
  -- período contiene la fecha efectiva.
  IF array_length(v_early_item_ids, 1) > 0 THEN
    FOR v_pe_item IN
      SELECT ii.id AS item_id, ii.invoice_id, ii.billing_period_start, ii.billing_period_end,
             ii.subtotal_contract_currency, ii.subtotal_invoice_currency,
             i.tax_rate AS inv_tax_rate
      FROM public.invoices i
      JOIN public.invoice_items ii ON ii.invoice_id = i.id
      WHERE i.contract_id = p_contract_id AND i.holding_id = v_holding_id
        AND i.status IN ('Por Emitir', 'Programada')
        AND ii.contract_item_id = ANY(v_early_item_ids)
        AND ii.billing_period_start IS NOT NULL AND ii.billing_period_end IS NOT NULL
        AND ii.billing_period_start < p_effective_date
        AND ii.billing_period_end >= p_effective_date
    LOOP
      v_total_days := (v_pe_item.billing_period_end - v_pe_item.billing_period_start) + 1;
      v_served_days := (p_effective_date - v_pe_item.billing_period_start);
      IF v_total_days <= 0 OR v_served_days <= 0 THEN CONTINUE; END IF;
      v_pe_ratio := v_served_days::numeric / v_total_days::numeric;

      -- Neto nuevo = neto × ratio de días; IVA nuevo = neto nuevo × tax_rate
      -- (nunca se escala el IVA almacenado); total = neto + IVA.
      v_new_sub_c := ROUND(COALESCE(v_pe_item.subtotal_contract_currency, 0) * v_pe_ratio, 2);
      v_new_sub_i := ROUND(COALESCE(v_pe_item.subtotal_invoice_currency, 0) * v_pe_ratio, 2);
      v_new_tax_c := ROUND(v_new_sub_c * COALESCE(v_pe_item.inv_tax_rate, 0) / 100, 2);
      v_new_tax_i := ROUND(v_new_sub_i * COALESCE(v_pe_item.inv_tax_rate, 0) / 100, 2);

      UPDATE public.invoice_items SET
        unit_price_contract_currency = ROUND(COALESCE(unit_price_contract_currency, 0) * v_pe_ratio, 2),
        unit_price_invoice_currency  = ROUND(COALESCE(unit_price_invoice_currency, 0) * v_pe_ratio, 2),
        subtotal_contract_currency   = v_new_sub_c,
        subtotal_invoice_currency    = v_new_sub_i,
        tax_amount_contract_currency = v_new_tax_c,
        tax_amount_invoice_currency  = v_new_tax_i,
        total_contract_currency      = v_new_sub_c + v_new_tax_c,
        total_invoice_currency       = v_new_sub_i + v_new_tax_i,
        billing_period_end           = p_effective_date - 1,
        description = COALESCE(description, '')
          || ' (ajustada por ' || p_type || ': ' || v_served_days::text || '/' || v_total_days::text
          || ' días, hasta ' || to_char(p_effective_date - 1, 'DD/MM/YYYY') || ')'
      WHERE id = v_pe_item.item_id;

      v_pe_adjusted_invoice_ids := array_append(v_pe_adjusted_invoice_ids, v_pe_item.invoice_id);
      v_pe_adjusted_count := v_pe_adjusted_count + 1;
    END LOOP;

    FOR v_pe_inv_id IN SELECT DISTINCT unnest(v_pe_adjusted_invoice_ids) LOOP
      UPDATE public.invoices i SET
        amount_contract_currency = s.sub_c,
        amount_invoice_currency  = s.sub_i,
        vat                      = s.tax_c,
        total_invoice_currency   = s.sub_i + s.tax_i,
        amount_system_currency   = CASE WHEN COALESCE(i.fx_contract_to_invoice, 0) > 0
          THEN s.sub_i * (COALESCE(i.fx_contract_to_system, i.fx_contract_to_invoice) / i.fx_contract_to_invoice)
          ELSE s.sub_i END,
        total_system_currency    = CASE WHEN COALESCE(i.fx_contract_to_invoice, 0) > 0
          THEN (s.sub_i + s.tax_i) * (COALESCE(i.fx_contract_to_system, i.fx_contract_to_invoice) / i.fx_contract_to_invoice)
          ELSE (s.sub_i + s.tax_i) END,
        notes = COALESCE(i.notes || E'\n', '')
          || 'Ajustada proporcionalmente por ' || p_type || ' (período hasta '
          || to_char(p_effective_date - 1, 'DD/MM/YYYY') || ')'
      FROM (
        SELECT COALESCE(SUM(subtotal_contract_currency), 0) AS sub_c,
               COALESCE(SUM(subtotal_invoice_currency), 0) AS sub_i,
               COALESCE(SUM(tax_amount_contract_currency), 0) AS tax_c,
               COALESCE(SUM(tax_amount_invoice_currency), 0) AS tax_i
        FROM public.invoice_items WHERE invoice_id = v_pe_inv_id
      ) s
      WHERE i.id = v_pe_inv_id;
    END LOOP;
  END IF;

  -- F3: NCs sobre facturas YA EMITIDAS para items con timing='early'.
  IF array_length(v_early_item_ids, 1) > 0 THEN
    FOR v_emitted_invoice IN
      SELECT DISTINCT i.id, i.holding_id, i.contract_id, i.company_id,
             i.client_id, i.client_entity_id,
             i.contract_currency, i.invoice_currency, i.system_currency,
             i.fx_contract_to_invoice, i.fx_contract_to_system,
             i.issuer_tax_id, i.issuer_legal_name, i.issuer_address, i.client_tax_id,
             i.payment_method, i.fiscal_regime, i.export_type, i.tax_rate
      FROM public.invoices i
      JOIN public.invoice_items ii ON ii.invoice_id = i.id
      WHERE i.contract_id = p_contract_id
        AND i.holding_id = v_holding_id
        AND i.status IN ('Emitida', 'Enviada', 'Pagada', 'Vencida')
        AND COALESCE(i.document_type, 'FACTURA') <> 'NC'
        AND ii.contract_item_id = ANY(v_early_item_ids)
        AND ii.billing_period_end IS NOT NULL
        AND ii.billing_period_end >= p_effective_date
    LOOP
      INSERT INTO public.invoices(
        holding_id, contract_id, company_id, client_id, client_entity_id,
        scheduled_at, original_issue_date, issue_date, due_date, status,
        contract_currency, invoice_currency, system_currency,
        amount_contract_currency, amount_invoice_currency,
        vat, total_invoice_currency, amount_system_currency, total_system_currency,
        fx_contract_to_invoice, fx_contract_to_system,
        invoice_type, document_type, related_invoice_id,
        credit_type, credit_reason, nc_revenue_treatment,
        issuer_tax_id, issuer_legal_name, issuer_address, client_tax_id,
        payment_method, fiscal_regime, export_type, tax_rate, notes
      ) VALUES (
        v_emitted_invoice.holding_id, v_emitted_invoice.contract_id, v_emitted_invoice.company_id,
        v_emitted_invoice.client_id, v_emitted_invoice.client_entity_id,
        p_effective_date, p_effective_date, p_effective_date, p_effective_date,
        'Emitida',
        v_emitted_invoice.contract_currency, v_emitted_invoice.invoice_currency, v_emitted_invoice.system_currency,
        0, 0, 0, 0, 0, 0,
        COALESCE(v_emitted_invoice.fx_contract_to_invoice, 1.0),
        COALESCE(v_emitted_invoice.fx_contract_to_system, 1.0),
        'Automatica', 'NC', v_emitted_invoice.id,
        'discount', lower(p_type), NULL,
        v_emitted_invoice.issuer_tax_id,
        v_emitted_invoice.issuer_legal_name, v_emitted_invoice.issuer_address,
        v_emitted_invoice.client_tax_id,
        v_emitted_invoice.payment_method, v_emitted_invoice.fiscal_regime,
        v_emitted_invoice.export_type, v_emitted_invoice.tax_rate,
        'NC por ' || p_type || ' del contrato. '
          || 'Factura original: ' || v_emitted_invoice.id::text
          || COALESCE(' — ' || v_reason_name, '')
      ) RETURNING id INTO v_nc_invoice_id;

      v_nc_total_subtotal := 0;
      v_nc_total_tax := 0;
      v_nc_items_count := 0;

      FOR v_emitted_item IN
        SELECT ii.*
        FROM public.invoice_items ii
        WHERE ii.invoice_id = v_emitted_invoice.id
          AND ii.contract_item_id = ANY(v_early_item_ids)
          AND ii.billing_period_end IS NOT NULL
          AND ii.billing_period_end >= p_effective_date
      LOOP
        v_canceled_from := GREATEST(v_emitted_item.billing_period_start, p_effective_date);
        v_total_days := (v_emitted_item.billing_period_end - v_emitted_item.billing_period_start) + 1;
        v_canceled_days := (v_emitted_item.billing_period_end - v_canceled_from) + 1;

        IF v_canceled_days <= 0 OR v_total_days <= 0 THEN CONTINUE; END IF;

        v_nc_ratio := v_canceled_days::numeric / v_total_days::numeric;
        v_nc_subtotal := ROUND(COALESCE(v_emitted_item.subtotal_contract_currency, 0) * v_nc_ratio, 2);
        -- IVA de la NC: neto acreditado × tax_rate de la factura original
        -- (nunca prorratear el IVA almacenado).
        v_nc_tax := ROUND(v_nc_subtotal * COALESCE(v_emitted_invoice.tax_rate, 0) / 100, 2);

        INSERT INTO public.invoice_items(
          holding_id, invoice_id, product_id,
          description, quantity, unit_of_measure,
          unit_price_contract_currency, unit_price_invoice_currency,
          discount_pct,
          subtotal_contract_currency, subtotal_invoice_currency,
          tax_amount_contract_currency, tax_amount_invoice_currency,
          total_contract_currency, total_invoice_currency,
          contract_currency, invoice_currency, fx_contract_to_invoice,
          contract_id, billing_period_start, billing_period_end
        ) VALUES (
          v_holding_id, v_nc_invoice_id, v_emitted_item.product_id,
          COALESCE(v_emitted_item.description, '') || ' (NC por ' || p_type || ' — '
            || v_canceled_days::text || '/' || v_total_days::text || ' días)',
          v_emitted_item.quantity, v_emitted_item.unit_of_measure,
          -COALESCE(v_emitted_item.unit_price_contract_currency, 0),
          -COALESCE(v_emitted_item.unit_price_invoice_currency, 0),
          COALESCE(v_emitted_item.discount_pct, 0),
          -v_nc_subtotal, -v_nc_subtotal,
          -v_nc_tax, -v_nc_tax,
          -(v_nc_subtotal + v_nc_tax), -(v_nc_subtotal + v_nc_tax),
          v_emitted_item.contract_currency, v_emitted_item.invoice_currency,
          COALESCE(v_emitted_item.fx_contract_to_invoice, 1),
          p_contract_id,
          v_canceled_from, v_emitted_item.billing_period_end
        ) RETURNING id INTO v_new_item_id;

        UPDATE public.invoice_items SET contract_item_id = v_emitted_item.contract_item_id
        WHERE id = v_new_item_id;

        v_nc_total_subtotal := v_nc_total_subtotal + v_nc_subtotal;
        v_nc_total_tax := v_nc_total_tax + v_nc_tax;
        v_nc_items_count := v_nc_items_count + 1;
      END LOOP;

      IF v_nc_items_count = 0 THEN
        DELETE FROM public.invoices WHERE id = v_nc_invoice_id;
        CONTINUE;
      END IF;

      IF COALESCE(v_emitted_invoice.fx_contract_to_invoice, 0) > 0 THEN
        v_fx_system_ratio := COALESCE(v_emitted_invoice.fx_contract_to_system, v_emitted_invoice.fx_contract_to_invoice)
                             / v_emitted_invoice.fx_contract_to_invoice;
      ELSE
        v_fx_system_ratio := 1;
      END IF;

      UPDATE public.invoices SET
        amount_contract_currency = -v_nc_total_subtotal,
        amount_invoice_currency = -v_nc_total_subtotal,
        vat = -v_nc_total_tax,
        total_invoice_currency = -(v_nc_total_subtotal + v_nc_total_tax),
        amount_system_currency = -v_nc_total_subtotal * v_fx_system_ratio,
        total_system_currency = -(v_nc_total_subtotal + v_nc_total_tax) * v_fx_system_ratio
      WHERE id = v_nc_invoice_id;

      v_ncs_generated_count := v_ncs_generated_count + 1;
      v_ncs_total_amount := v_ncs_total_amount + v_nc_total_subtotal + v_nc_total_tax;
      v_ncs_created_ids := array_append(v_ncs_created_ids, v_nc_invoice_id);
    END LOOP;
  END IF;

  -- F3 (bug TV): recalcular el total del contrato desde sus ítems.
  UPDATE public.contracts
  SET total_value = (
    SELECT COALESCE(SUM(final_price), 0) FROM public.contract_items
    WHERE contract_id = p_contract_id
  )
  WHERE id = p_contract_id;

  BEGIN
    PERFORM public.calculate_contract_fx_amounts(p_contract_id);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'calculate_contract_fx_amounts falló para contrato %: %', p_contract_id, SQLERRM;
  END;

  PERFORM public.log_lifecycle_event(
    p_contract_id, p_type,
    CASE WHEN p_type='CHURN' THEN 'Cancelación de contrato (churn)' ELSE 'Reducción parcial (downsell)' END,
    p_effective_date, -v_total_delta,
    'Items afectados: ' || array_length(v_affected_item_ids, 1)::text
      || '. MRR mensual reducido: ' || COALESCE(v_item_currency, v_contract_currency) || ' ' || ROUND(v_total_delta, 2)::text
      || CASE WHEN v_ncs_generated_count > 0
              THEN '. NCs generadas (Emitida): ' || v_ncs_generated_count::text
                || ' por total ' || ROUND(v_ncs_total_amount, 2)::text
              ELSE '' END
      || CASE WHEN v_pe_adjusted_count > 0
              THEN '. Facturas Por Emitir ajustadas proporcionalmente: ' || v_pe_adjusted_count::text
              ELSE '' END,
    COALESCE(v_reason_name, '')
      || CASE WHEN p_notes IS NOT NULL AND p_notes <> '' THEN ' — ' || p_notes ELSE '' END,
    jsonb_build_object(
      'item_ids', to_jsonb(v_affected_item_ids),
      'reason_id', p_reason_id,
      'total_mrr_delta', v_total_delta,
      'timing', v_timing,
      'ncs_generated_count', v_ncs_generated_count,
      'ncs_total_amount', v_ncs_total_amount,
      'ncs_invoice_ids', to_jsonb(v_ncs_created_ids),
      'nc_status', 'Emitida',
      'proration', 'days',
      'pe_adjusted_count', v_pe_adjusted_count
    ),
    v_timing, 'Recorded'
  );

  IF p_type = 'CHURN' THEN
    SELECT COUNT(*) INTO v_remaining_active FROM public.contract_items
    WHERE contract_id = p_contract_id AND holding_id = v_holding_id
      AND COALESCE(is_recurring, false) = true AND churn_date IS NULL
      AND COALESCE(categoria, '') NOT IN ('CHURN', 'DOWNSELL');

    IF v_remaining_active = 0 THEN
      UPDATE public.contracts
      SET status = 'Cancelado', churn_date = p_effective_date,
          churn_reason_id = p_reason_id, churn_reason = COALESCE(v_reason_name, p_notes)
      WHERE id = p_contract_id;
      v_auto_cancel := true;
    END IF;
  END IF;

  -- F3 (bug RSM): rebuild SIEMPRE, al final, desde el mes más temprano afectado.
  BEGIN
    PERFORM public.revenue_schedule_rebuild(
      p_contract_id,
      LEAST(COALESCE(v_period_month, DATE_TRUNC('month', p_effective_date)::date),
            DATE_TRUNC('month', p_effective_date)::date)
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'RSM rebuild falló para contrato % (apply_contract_contraction): %', p_contract_id, SQLERRM;
  END;

  RETURN jsonb_build_object(
    'success', true, 'type', p_type,
    'items_affected', array_length(v_affected_item_ids, 1),
    'total_mrr_delta', ROUND(v_total_delta, 2),
    'currency', COALESCE(v_item_currency, v_contract_currency),
    'effective_date', p_effective_date,
    'contract_auto_cancelled', v_auto_cancel,
    'timing', v_timing,
    'ncs_generated_count', v_ncs_generated_count,
    'ncs_total_amount', ROUND(v_ncs_total_amount, 2),
    'ncs_invoice_ids', to_jsonb(v_ncs_created_ids),
    'pe_adjusted_count', v_pe_adjusted_count
  );
END;
$function$;

COMMENT ON FUNCTION public."apply_contract_contraction"(p_contract_id uuid, p_type text, p_items jsonb, p_effective_date date, p_reason_id uuid, p_notes text) IS 'RPC unificada de contracción (CHURN/DOWNSELL). Reemplaza register_item_non_renewal + create_contract_churn. Ver docs/contratos/contraccion-unificada.md';
