CREATE OR REPLACE FUNCTION public.unify_invoices_multi_contract(p_invoice_ids uuid[], p_notes text DEFAULT NULL::text, p_fx_policy text DEFAULT NULL::text, p_fx_rates jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_ids uuid[];
  v_count int;
  v_found int;
  v_holding_count int;
  v_company_count int;
  v_entity_count int;
  v_client_count int;
  v_ccy_count int;
  v_month_count int;
  v_contract_count int;
  v_doc_count int;
  v_export_count int;
  v_all_eligible boolean;
  v_holding_id uuid;
  v_user_holding uuid;
  v_first_invoice RECORD;
  v_primary_contract_id uuid;
  v_currency text;
  v_ctr_ccy_count int;
  v_contract_currency text;
  v_total_subtotal_ctr numeric;
  v_total_subtotal numeric;
  v_total_vat numeric;
  v_total_amount numeric;
  v_invoice_amounts_null boolean;
  v_fx_mode_count int;
  v_earliest_scheduled date;
  v_latest_due date;
  v_group_id uuid;
  v_new_invoice_id uuid;
  v_src RECORD;
  v_new_item_id uuid;
  v_new_description text;
  v_contract RECORD;
  v_pair RECORD;
  v_pair_key text;
  v_pair_rate numeric;
  v_doc_fx numeric;
BEGIN
  v_ids := ARRAY(SELECT DISTINCT unnest(p_invoice_ids));
  v_count := COALESCE(array_length(v_ids, 1), 0);
  IF v_count < 2 THEN
    RAISE EXCEPTION 'Se requieren al menos 2 facturas para unificar';
  END IF;

  SELECT count(*),
         count(DISTINCT holding_id),
         count(DISTINCT company_id),
         count(DISTINCT client_entity_id),
         count(DISTINCT client_id),
         count(DISTINCT invoice_currency),
         count(DISTINCT date_trunc('month', scheduled_at)),
         count(DISTINCT contract_id),
         count(DISTINCT COALESCE(document_type, 'FACTURA')),
         count(DISTINCT COALESCE(export_type, 0)),
         bool_and(status = 'Por Emitir' AND is_active = true
                  AND consolidated_into_invoice_id IS NULL
                  AND COALESCE(document_type, 'FACTURA') NOT IN ('NC', 'ND')
                  AND COALESCE(invoice_type, '') NOT IN ('Consolidada', 'Unificada')
                  AND contract_id IS NOT NULL)
  INTO v_found, v_holding_count, v_company_count, v_entity_count, v_client_count,
       v_ccy_count, v_month_count, v_contract_count, v_doc_count, v_export_count, v_all_eligible
  FROM invoices
  WHERE id = ANY(v_ids);

  IF v_found <> v_count THEN
    RAISE EXCEPTION 'Una o más facturas no existen';
  END IF;
  IF NOT COALESCE(v_all_eligible, false) THEN
    RAISE EXCEPTION 'Todas las facturas deben estar en estado Por Emitir, activas, sin consolidación previa (si una ya es un documento consolidado o unificado, desconsolídalo primero) y no ser notas de crédito o débito';
  END IF;
  IF v_holding_count <> 1 THEN
    RAISE EXCEPTION 'No se pueden unificar facturas de distintos holdings';
  END IF;
  IF v_company_count <> 1 THEN
    RAISE EXCEPTION 'Todas las facturas deben tener la misma compañía emisora';
  END IF;
  IF v_entity_count <> 1 OR v_client_count <> 1 THEN
    RAISE EXCEPTION 'Todas las facturas deben tener la misma razón social receptora';
  END IF;
  IF v_ccy_count <> 1 THEN
    RAISE EXCEPTION 'Todas las facturas deben tener la misma moneda de facturación';
  END IF;
  IF v_month_count <> 1 THEN
    RAISE EXCEPTION 'Todas las facturas deben tener el mismo mes de emisión programada';
  END IF;
  IF v_doc_count <> 1 OR v_export_count <> 1 THEN
    RAISE EXCEPTION 'Todas las facturas deben tener el mismo tipo de documento y de exportación';
  END IF;
  IF v_contract_count < 2 THEN
    RAISE EXCEPTION 'Las facturas pertenecen a un solo contrato: usa la consolidación de facturas del contrato';
  END IF;

  SELECT holding_id INTO v_holding_id FROM invoices WHERE id = v_ids[1];

  BEGIN
    v_user_holding := get_current_user_holding_id();
  EXCEPTION WHEN OTHERS THEN
    v_user_holding := NULL;
  END;
  IF v_user_holding IS NOT NULL AND v_user_holding <> v_holding_id THEN
    RAISE EXCEPTION 'No se pueden unificar facturas de otro holding';
  END IF;

  IF p_fx_policy IS NOT NULL THEN
    IF p_fx_policy NOT IN ('spot', 'fixed') THEN
      RAISE EXCEPTION 'Política de tipo de cambio inválida: usa "spot" (tasa del día) o "fixed" (tasa fija).';
    END IF;

    IF p_fx_policy = 'spot' THEN
      -- (Opción A, 2026-08-28) Spot ya NO deja montos NULL "para el emisor":
      -- el documento queda SIEMPRE valorizado al unificar con la tasa del
      -- día por par (la manda el modal; si falta, se usa la última tasa
      -- registrada en exchange_rates). Un documento a medias llegaba al ERP
      -- con los montos en cero (Reutter, Nestlé): el envío no resuelve
      -- unificadas multi-contrato con monedas de contrato distintas.
      FOR v_pair IN
        SELECT DISTINCT ii.contract_currency AS from_ccy, ii.invoice_currency AS to_ccy
        FROM invoice_items ii
        WHERE ii.invoice_id = ANY(v_ids)
          AND ii.contract_currency IS DISTINCT FROM ii.invoice_currency
      LOOP
        v_pair_key  := v_pair.from_ccy || '>' || v_pair.to_ccy;
        v_pair_rate := NULLIF(p_fx_rates ->> v_pair_key, '')::numeric;
        IF v_pair_rate IS NULL OR v_pair_rate <= 0 THEN
          SELECT er.rate INTO v_pair_rate
          FROM exchange_rates er
          WHERE er.from_currency = v_pair.from_ccy AND er.to_currency = v_pair.to_ccy
            AND er.rate_date <= CURRENT_DATE
          ORDER BY er.rate_date DESC
          LIMIT 1;
        END IF;
        IF v_pair_rate IS NULL OR v_pair_rate <= 0 THEN
          RAISE EXCEPTION 'No hay tasa de cambio disponible para % - %. Ingresa la tasa en el modal de unificación (modo Fijo) y vuelve a intentar.',
            v_pair.from_ccy, v_pair.to_ccy;
        END IF;

        UPDATE invoice_items ii SET
          fx_contract_to_invoice      = v_pair_rate,
          fx_rate_source              = 'spot_unify',
          fx_rate_date                = CURRENT_DATE,
          unit_price_invoice_currency = ii.unit_price_contract_currency * v_pair_rate,
          subtotal_invoice_currency   = ii.subtotal_contract_currency   * v_pair_rate,
          tax_amount_invoice_currency = ii.tax_amount_contract_currency * v_pair_rate,
          total_invoice_currency      = ii.total_contract_currency      * v_pair_rate
        WHERE ii.invoice_id = ANY(v_ids)
          AND ii.contract_currency = v_pair.from_ccy
          AND ii.invoice_currency  = v_pair.to_ccy;
      END LOOP;

      UPDATE invoices i SET
        fx_contract_to_invoice  = s.fx,
        amount_invoice_currency = s.subtotal,
        vat                     = s.vat,
        total_invoice_currency  = s.total
      FROM (
        SELECT ii.invoice_id,
               MAX(ii.fx_contract_to_invoice)     AS fx,
               SUM(ii.subtotal_invoice_currency)   AS subtotal,
               SUM(ii.tax_amount_invoice_currency) AS vat,
               SUM(ii.total_invoice_currency)      AS total
        FROM invoice_items ii
        WHERE ii.invoice_id = ANY(v_ids)
        GROUP BY ii.invoice_id
      ) s
      WHERE i.id = s.invoice_id
        AND i.invoice_currency IS DISTINCT FROM i.contract_currency;
    ELSE
      FOR v_pair IN
        SELECT DISTINCT ii.contract_currency AS from_ccy, ii.invoice_currency AS to_ccy
        FROM invoice_items ii
        WHERE ii.invoice_id = ANY(v_ids)
          AND ii.contract_currency IS DISTINCT FROM ii.invoice_currency
      LOOP
        v_pair_key  := v_pair.from_ccy || '>' || v_pair.to_ccy;
        v_pair_rate := NULLIF(p_fx_rates ->> v_pair_key, '')::numeric;
        IF v_pair_rate IS NULL OR v_pair_rate <= 0 THEN
          RAISE EXCEPTION 'Falta la tasa de cambio para % → %: indícala en el modal de unificación antes de continuar.',
            v_pair.from_ccy, v_pair.to_ccy;
        END IF;

        UPDATE invoice_items ii SET
          fx_contract_to_invoice      = v_pair_rate,
          fx_rate_source              = 'manual_unify',
          fx_rate_date                = CURRENT_DATE,
          unit_price_invoice_currency = ii.unit_price_contract_currency * v_pair_rate,
          subtotal_invoice_currency   = ii.subtotal_contract_currency   * v_pair_rate,
          tax_amount_invoice_currency = ii.tax_amount_contract_currency * v_pair_rate,
          total_invoice_currency      = ii.total_contract_currency      * v_pair_rate
        WHERE ii.invoice_id = ANY(v_ids)
          AND ii.contract_currency = v_pair.from_ccy
          AND ii.invoice_currency  = v_pair.to_ccy;
      END LOOP;

      UPDATE invoices i SET
        fx_contract_to_invoice  = s.fx,
        amount_invoice_currency = s.subtotal,
        vat                     = s.vat,
        total_invoice_currency  = s.total
      FROM (
        SELECT ii.invoice_id,
               MAX(ii.fx_contract_to_invoice)     AS fx,
               SUM(ii.subtotal_invoice_currency)   AS subtotal,
               SUM(ii.tax_amount_invoice_currency) AS vat,
               SUM(ii.total_invoice_currency)      AS total
        FROM invoice_items ii
        WHERE ii.invoice_id = ANY(v_ids)
        GROUP BY ii.invoice_id
      ) s
      WHERE i.id = s.invoice_id
        AND i.invoice_currency IS DISTINCT FROM i.contract_currency;
    END IF;
  END IF;

  -- (Opción A, 2026-08-28) Garantía dura: NINGÚN documento unificado puede
  -- crearse con líneas convertidoras sin valorizar — el ERP recibiría los
  -- montos en cero. Aplica también a llamadas sin p_fx_policy.
  IF EXISTS (
    SELECT 1 FROM invoice_items ii
    WHERE ii.invoice_id = ANY(v_ids)
      AND ii.contract_currency IS DISTINCT FROM ii.invoice_currency
      AND ii.subtotal_invoice_currency IS NULL
  ) THEN
    RAISE EXCEPTION 'Hay líneas que convierten moneda sin tipo de cambio definido. Define el tipo de cambio del documento en el modal de unificación (Spot con la tasa del día, o Fijo con la tasa por par) y vuelve a intentar.';
  END IF;

  SELECT count(*) INTO v_fx_mode_count
  FROM (
    SELECT ii.contract_currency, ii.invoice_currency
    FROM invoice_items ii
    WHERE ii.invoice_id = ANY(v_ids)
      AND ii.contract_currency IS DISTINCT FROM ii.invoice_currency
    GROUP BY ii.contract_currency, ii.invoice_currency
    HAVING count(DISTINCT CASE
             WHEN ii.subtotal_invoice_currency IS NULL THEN 'spot'
             ELSE 'fijo:' || COALESCE(ii.fx_contract_to_invoice::text, '?')
           END) > 1
  ) mixed_pairs;

  IF COALESCE(v_fx_mode_count, 0) > 0 THEN
    RAISE EXCEPTION 'Entre las facturas que convierten moneda hay tratamientos de tipo de cambio distintos para un mismo par de monedas (spot vs fijo, o tasas fijas diferentes). Define el tipo de cambio del documento en el modal de unificación para alinearlas.';
  END IF;

  SELECT count(DISTINCT CASE WHEN ii.subtotal_invoice_currency IS NULL THEN 'spot' ELSE 'fijo' END)
  INTO v_fx_mode_count
  FROM invoice_items ii
  WHERE ii.invoice_id = ANY(v_ids)
    AND ii.contract_currency IS DISTINCT FROM ii.invoice_currency;

  IF COALESCE(v_fx_mode_count, 0) > 1 THEN
    RAISE EXCEPTION 'Las líneas que convierten moneda mezclan política spot y fija entre pares de monedas; un documento lleva una sola política. Elige spot o fijo para todo el documento en el modal de unificación.';
  END IF;

  SELECT i.contract_id INTO v_primary_contract_id
  FROM invoices i
  JOIN invoice_items ii ON ii.invoice_id = i.id
  JOIN contracts c ON c.id = i.contract_id
  WHERE i.id = ANY(v_ids)
  GROUP BY i.contract_id, c.contract_number
  ORDER BY SUM(COALESCE(ii.subtotal_invoice_currency, ii.subtotal_contract_currency, 0)) DESC, c.contract_number
  LIMIT 1;

  IF v_primary_contract_id IS NULL THEN
    SELECT contract_id INTO v_primary_contract_id FROM invoices WHERE id = v_ids[1];
  END IF;

  SELECT * INTO v_first_invoice
  FROM invoices
  WHERE id = ANY(v_ids) AND contract_id = v_primary_contract_id
  ORDER BY scheduled_at, created_at
  LIMIT 1;

  SELECT MIN(scheduled_at), MAX(due_date), MAX(invoice_currency)
  INTO v_earliest_scheduled, v_latest_due, v_currency
  FROM invoices
  WHERE id = ANY(v_ids);

  SELECT count(DISTINCT ii.contract_currency),
         COALESCE(SUM(ii.subtotal_contract_currency), 0),
         COALESCE(SUM(ii.subtotal_invoice_currency), 0),
         COALESCE(SUM(ii.tax_amount_invoice_currency), 0),
         COALESCE(SUM(ii.total_invoice_currency), 0),
         bool_and(ii.subtotal_invoice_currency IS NULL)
  INTO v_ctr_ccy_count, v_total_subtotal_ctr, v_total_subtotal, v_total_vat, v_total_amount, v_invoice_amounts_null
  FROM invoice_items ii
  WHERE ii.invoice_id = ANY(v_ids);

  IF COALESCE(v_ctr_ccy_count, 0) <= 1 THEN
    SELECT MAX(ii.contract_currency) INTO v_contract_currency
    FROM invoice_items ii WHERE ii.invoice_id = ANY(v_ids);
    v_contract_currency := COALESCE(v_contract_currency, v_currency);
  ELSE
    v_contract_currency := v_currency;
    v_total_subtotal_ctr := CASE WHEN v_invoice_amounts_null THEN NULL ELSE v_total_subtotal END;
  END IF;

  v_group_id := gen_random_uuid();

  SELECT CASE WHEN count(DISTINCT ii.fx_contract_to_invoice) = 1 THEN MAX(ii.fx_contract_to_invoice) ELSE NULL END
  INTO v_doc_fx
  FROM invoice_items ii
  WHERE ii.invoice_id = ANY(v_ids)
    AND ii.contract_currency IS DISTINCT FROM ii.invoice_currency
    AND ii.subtotal_invoice_currency IS NOT NULL;

  INSERT INTO invoices(
    holding_id, fx_contract_to_invoice, contract_id, company_id, client_id, client_entity_id,
    scheduled_at, issue_date, due_date, original_issue_date,
    contract_currency, invoice_currency,
    amount_contract_currency, amount_invoice_currency, vat, total_invoice_currency,
    status, document_type, invoice_type, invoice_group_id,
    issuer_tax_id, issuer_legal_name, issuer_address, client_tax_id,
    payment_method, fiscal_regime, export_type, notes, is_active, consolidated_into_invoice_id
  )
  SELECT
    v_holding_id, v_doc_fx, v_primary_contract_id, v_first_invoice.company_id, v_first_invoice.client_id, v_first_invoice.client_entity_id,
    v_earliest_scheduled, v_earliest_scheduled, v_latest_due, v_earliest_scheduled,
    v_contract_currency, v_currency,
    v_total_subtotal_ctr,
    CASE WHEN v_invoice_amounts_null THEN NULL ELSE v_total_subtotal END,
    CASE WHEN v_invoice_amounts_null THEN NULL ELSE v_total_vat END,
    CASE WHEN v_invoice_amounts_null THEN NULL ELSE v_total_amount END,
    'Por Emitir', v_first_invoice.document_type, 'Unificada', v_group_id,
    v_first_invoice.issuer_tax_id, v_first_invoice.issuer_legal_name, v_first_invoice.issuer_address, v_first_invoice.client_tax_id,
    v_first_invoice.payment_method, v_first_invoice.fiscal_regime, v_first_invoice.export_type, p_notes, true, NULL
  RETURNING id INTO v_new_invoice_id;

  FOR v_src IN
    SELECT ii.*,
           COALESCE(c2.contract_number, c3.contract_number) AS src_contract_number
    FROM invoice_items ii
    JOIN invoices inv ON inv.id = ii.invoice_id
    LEFT JOIN contract_items ci ON ci.id = ii.contract_item_id
    LEFT JOIN contracts c2 ON c2.id = ci.contract_id
    LEFT JOIN contracts c3 ON c3.id = inv.contract_id
    WHERE ii.invoice_id = ANY(v_ids)
    ORDER BY COALESCE(c2.contract_number, c3.contract_number), ii.billing_period_start NULLS LAST, ii.created_at
  LOOP
    v_new_description := CASE
      WHEN v_src.src_contract_number IS NOT NULL
        THEN v_src.src_contract_number || ' - ' || COALESCE(v_src.description, '')
      ELSE v_src.description
    END;

    INSERT INTO invoice_items(
      invoice_id, holding_id, contract_item_id, product_id, description, quantity, unit_of_measure,
      discount_pct, tax_code, odoo_tax_id, custom_fields, subscription_item_id,
      unit_price_contract_currency, unit_price_invoice_currency,
      subtotal_contract_currency, subtotal_invoice_currency,
      tax_amount_contract_currency, tax_amount_invoice_currency,
      total_contract_currency, total_invoice_currency,
      contract_currency, invoice_currency, fx_contract_to_invoice, fx_rate_source, fx_rate_date,
      billing_period_start, billing_period_end
    )
    VALUES (
      v_new_invoice_id, v_holding_id, v_src.contract_item_id, v_src.product_id, v_new_description, v_src.quantity, v_src.unit_of_measure,
      v_src.discount_pct, v_src.tax_code, v_src.odoo_tax_id, v_src.custom_fields, v_src.subscription_item_id,
      v_src.unit_price_contract_currency, v_src.unit_price_invoice_currency,
      v_src.subtotal_contract_currency, v_src.subtotal_invoice_currency,
      v_src.tax_amount_contract_currency, v_src.tax_amount_invoice_currency,
      v_src.total_contract_currency, v_src.total_invoice_currency,
      v_src.contract_currency, v_src.invoice_currency, v_src.fx_contract_to_invoice, v_src.fx_rate_source, v_src.fx_rate_date,
      v_src.billing_period_start, v_src.billing_period_end
    )
    RETURNING id INTO v_new_item_id;

    UPDATE invoice_items SET
      description                  = v_new_description,
      quantity                     = v_src.quantity,
      unit_of_measure              = v_src.unit_of_measure,
      unit_price_contract_currency = v_src.unit_price_contract_currency,
      unit_price_invoice_currency  = v_src.unit_price_invoice_currency,
      subtotal_contract_currency   = v_src.subtotal_contract_currency,
      subtotal_invoice_currency    = v_src.subtotal_invoice_currency,
      tax_amount_contract_currency = v_src.tax_amount_contract_currency,
      tax_amount_invoice_currency  = v_src.tax_amount_invoice_currency,
      total_contract_currency      = v_src.total_contract_currency,
      total_invoice_currency       = v_src.total_invoice_currency,
      contract_currency            = v_src.contract_currency,
      invoice_currency             = v_src.invoice_currency
    WHERE id = v_new_item_id;
  END LOOP;

  UPDATE invoices
  SET is_active = false,
      consolidated_into_invoice_id = v_new_invoice_id
  WHERE id = ANY(v_ids);

  FOR v_contract IN
    SELECT DISTINCT i.contract_id
    FROM invoices i
    WHERE i.id = ANY(v_ids)
  LOOP
    BEGIN
      PERFORM log_lifecycle_event(
        v_contract.contract_id,
        'INVOICE_UNIFICATION',
        'Unificación de Facturas',
        CURRENT_DATE,
        NULL,
        format('%s facturas de %s contratos unificadas en un solo documento', v_count, v_contract_count),
        COALESCE(p_notes, 'Facturación unificada multi-contrato'),
        jsonb_build_object(
          'unified_invoice_id', v_new_invoice_id,
          'source_invoice_ids', v_ids,
          'primary_contract_id', v_primary_contract_id,
          'contract_count', v_contract_count
        ),
        'consolidation',
        'Completed'
      );
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'unified_invoice_id', v_new_invoice_id,
    'original_invoice_count', v_count,
    'contract_count', v_contract_count,
    'primary_contract_id', v_primary_contract_id,
    'total_amount', v_total_amount,
    'scheduled_at', v_earliest_scheduled,
    'due_date', v_latest_due,
    'fx_policy', p_fx_policy,
    'fx_rates', p_fx_rates
  );

EXCEPTION
  WHEN OTHERS THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', SQLERRM
    );
END;
$function$

