CREATE OR REPLACE FUNCTION public.sync_invoices_for_contract_item(p_item_id uuid, p_action text DEFAULT 'sync'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_holding_id uuid := get_current_user_holding_id();
  v_user_id uuid := auth.uid();
  v_ci record;
  v_contract record;
  v_freq_months int;
  v_method text;
  v_total_periods int;
  v_firm_total numeric := 0;
  v_firm_count int := 0;
  v_anchor_end date;
  v_pending_total numeric;
  v_periods jsonb := '[]'::jsonb;
  v_bp record;
  v_i int;
  v_n int;
  v_per numeric;
  v_amount numeric;
  v_vat numeric;
  v_total numeric;
  v_tax_rate numeric;
  v_existing record;
  v_existing_lines uuid[];
  v_existing_invoices uuid[];
  v_existing_count int;
  v_line_id uuid;
  v_invoice_id uuid;
  v_is_exclusive boolean;
  v_touched_invoices uuid[] := ARRAY[]::uuid[];
  v_updated int := 0;
  v_created int := 0;
  v_deleted int := 0;
  v_cancelled int := 0;
  v_grouped_kept jsonb := '[]'::jsonb;
  v_description text;
  v_sched date;
  v_pstart date;
  v_pend date;
  v_continuity jsonb;
  v_ref record;
  v_company record;
  v_entity record;
BEGIN
  IF NOT user_has_permission('EDIT_FACTURACION') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Sin permiso EDIT_FACTURACION');
  END IF;
  IF p_action NOT IN ('sync', 'delete') THEN
    RETURN jsonb_build_object('success', false, 'error', 'p_action debe ser sync o delete');
  END IF;

  SELECT ci.id, ci.contract_id, ci.product_id, ci.product_name, ci.start_date, ci.end_date,
         ci.term_months, ci.billing_frequency, ci.billing_method, ci.final_price,
         ci.currency, ci.unit_of_measure,
         ci.quantity, ci.unit_price, ci.discount_type, ci.discount_value, ci.account
    INTO v_ci
  FROM contract_items ci
  JOIN contracts c ON c.id = ci.contract_id
  WHERE ci.id = p_item_id AND c.holding_id = v_holding_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Ítem de contrato no encontrado');
  END IF;

  SELECT id, holding_id, client_id, company_id, client_entity_id,
         contract_currency, invoice_currency, status, booking_date
    INTO v_contract
  FROM contracts WHERE id = v_ci.contract_id;

  PERFORM pg_advisory_xact_lock(hashtextextended(v_contract.id::text, 0));

  IF v_contract.status NOT IN ('Activo', 'Cancelado', 'Expirado') THEN
    RETURN jsonb_build_object('success', true, 'skipped', 'contract_not_post_signed',
      'message', 'El contrato aún no está activo: el cronograma se genera al activarlo.');
  END IF;

  IF EXISTS (
    SELECT 1 FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id
    WHERE ii.contract_item_id = p_item_id
      AND COALESCE(i.is_active, true) = true AND i.status = 'Por Emitir'
      AND COALESCE(i.invoice_type, '') IN ('Unificada', 'Consolidada')
  ) THEN
    RETURN jsonb_build_object('success', false, 'blocked', 'unified_document',
      'message', 'El ítem tiene facturas dentro de un documento unificado o consolidado, que no se puede modificar directamente. Orden correcto: 1) revertir la unificación/consolidación (Desconsolidar), 2) corregir el ítem y su cronograma, 3) volver a unificar/consolidar al final.');
  END IF;

  IF p_action = 'sync' AND EXISTS (SELECT 1 FROM quantities q WHERE q.contract_item_id = p_item_id) THEN
    RETURN jsonb_build_object('success', false, 'blocked', 'quantity_overrides',
      'message', 'El ítem tiene cantidades variables registradas: sus facturas reflejan cantidades reales por período. Corrige las cantidades desde la vista de Cantidades (o elimínalas primero) para no pisar esos montos.');
  END IF;

  SELECT COALESCE(SUM(ii.subtotal_contract_currency), 0), COUNT(*), MAX(ii.billing_period_end)
    INTO v_firm_total, v_firm_count, v_anchor_end
  FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id
  WHERE ii.contract_item_id = p_item_id
    AND COALESCE(i.is_active, true) = true AND i.status <> 'Cancelada'
    AND ( i.status IN ('Emitida', 'Enviada', 'Pagada', 'Vencida')
       OR EXISTS (SELECT 1 FROM bank_movements bm WHERE bm.reconciled_invoice_id = i.id)
       OR EXISTS (SELECT 1 FROM invoices nc WHERE nc.related_invoice_id = i.id
                    AND COALESCE(nc.document_type, '') IN ('NC', 'ND')
                    AND COALESCE(nc.is_active, true) = true AND nc.status <> 'Cancelada') );

  IF p_action = 'delete' THEN
    IF v_firm_count > 0 THEN
      RETURN jsonb_build_object('success', false, 'blocked', 'has_firm_invoices',
        'message', 'El ítem tiene facturas emitidas o reconciliadas, por lo que no puede eliminarse directamente (se perdería el respaldo de lo facturado). Usa Modificaciones (downsell/churn) o una nota de crédito según corresponda.');
    END IF;

    WITH del AS (
      DELETE FROM invoice_items ii USING invoices i
      WHERE ii.invoice_id = i.id AND ii.contract_item_id = p_item_id
        AND i.status = 'Por Emitir' AND COALESCE(i.is_active, true) = true
      RETURNING ii.id, ii.invoice_id
    )
    SELECT COALESCE(array_agg(DISTINCT invoice_id), ARRAY[]::uuid[]), COUNT(*)
      INTO v_touched_invoices, v_deleted FROM del;

    WITH marked AS (
      UPDATE invoices SET is_active = false, status = 'Cancelada'
      WHERE id = ANY(v_touched_invoices)
        AND NOT EXISTS (SELECT 1 FROM invoice_items ii WHERE ii.invoice_id = invoices.id)
      RETURNING id
    ) SELECT COUNT(*) INTO v_cancelled FROM marked;

    UPDATE invoices i SET
      amount_contract_currency = COALESCE(sums.subtotal, 0),
      vat = CASE WHEN i.fx_contract_to_invoice IS NULL THEN NULL ELSE COALESCE(sums.vat, 0) END,
      total_invoice_currency = CASE WHEN i.fx_contract_to_invoice IS NULL THEN NULL ELSE COALESCE(sums.total, 0) * i.fx_contract_to_invoice END,
      amount_invoice_currency = CASE WHEN i.fx_contract_to_invoice IS NULL THEN NULL ELSE COALESCE(sums.subtotal, 0) * i.fx_contract_to_invoice END
    FROM (
      SELECT invoice_id, SUM(subtotal_contract_currency) AS subtotal,
             SUM(tax_amount_contract_currency) AS vat, SUM(total_contract_currency) AS total
      FROM invoice_items WHERE invoice_id = ANY(v_touched_invoices) GROUP BY invoice_id
    ) sums WHERE i.id = sums.invoice_id AND COALESCE(i.is_active, true) = true;

    DELETE FROM revenue_schedule_monthly WHERE contract_item_id = p_item_id;
    BEGIN
      DELETE FROM contract_items WHERE id = p_item_id;
    EXCEPTION WHEN foreign_key_violation THEN
      RAISE EXCEPTION 'El ítem está referenciado por el historial del contrato (modificaciones o renovaciones) y no puede eliminarse; ese respaldo debe conservarse. Si corresponde darlo de baja, hazlo por Modificaciones (downsell/churn).'
        USING ERRCODE = 'check_violation';
    END;

    UPDATE contracts c SET
      total_value = agg.total,
      contract_end_date = CASE WHEN c.status = 'Activo' THEN c.contract_end_date ELSE agg.max_end END
    FROM (SELECT MAX(end_date) AS max_end, COALESCE(SUM(final_price), 0) AS total
          FROM contract_items WHERE contract_id = v_contract.id) agg
    WHERE c.id = v_contract.id;

    INSERT INTO invoice_restructure_log(holding_id, contract_id, actor_user_id, action, payload)
    VALUES (v_holding_id, v_contract.id, v_user_id, 'item_delete_sync',
      jsonb_build_object('contract_item_id', p_item_id, 'deleted_lines', v_deleted,
        'cancelled_invoices', v_cancelled));

    RETURN jsonb_build_object('success', true, 'action', 'delete',
      'deleted_lines', v_deleted, 'cancelled_invoices', v_cancelled);
  END IF;

  v_pending_total := COALESCE(v_ci.final_price, 0) - v_firm_total;
  IF v_pending_total < -GREATEST(0.01, 0.01 * v_firm_count) THEN
    RETURN jsonb_build_object('success', false, 'blocked', 'issued_exceeds_total',
      'message', format('Ya se facturaron %s en firme y el nuevo total del ítem es %s: no se puede reducir lo ya emitido desde aquí. Corresponde una nota de crédito (o un downsell por Modificaciones).',
        v_firm_total, COALESCE(v_ci.final_price, 0)),
      'firm_total', v_firm_total, 'item_total', COALESCE(v_ci.final_price, 0));
  END IF;

  v_freq_months := COALESCE(NULLIF(get_frequency_months(v_ci.billing_frequency), 0), 1);
  v_method := COALESCE(v_ci.billing_method, 'anticipado');
  v_total_periods := CEIL(COALESCE(v_ci.term_months, 12)::numeric / v_freq_months);

  FOR v_i IN 0..(v_total_periods - 1) LOOP
    SELECT * INTO v_bp FROM calculate_billing_period(
      COALESCE(v_ci.start_date, v_contract.booking_date, CURRENT_DATE), v_i, v_freq_months, v_method);
    IF v_ci.end_date IS NOT NULL AND v_bp.period_start > v_ci.end_date THEN EXIT; END IF;
    IF v_anchor_end IS NOT NULL AND v_bp.period_start <= v_anchor_end THEN CONTINUE; END IF;
    v_periods := v_periods || jsonb_build_object(
      'period_start', v_bp.period_start, 'period_end', LEAST(v_bp.period_end, COALESCE(v_ci.end_date, v_bp.period_end)),
      'scheduled_date', v_bp.scheduled_date);
  END LOOP;
  v_n := jsonb_array_length(v_periods);

  SELECT COALESCE(array_agg(l.line_id), ARRAY[]::uuid[]),
         COALESCE(array_agg(l.invoice_id), ARRAY[]::uuid[])
    INTO v_existing_lines, v_existing_invoices
  FROM (
    SELECT ii.id AS line_id, ii.invoice_id
    FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id
    WHERE ii.contract_item_id = p_item_id
      AND i.status = 'Por Emitir' AND COALESCE(i.is_active, true) = true
      AND COALESCE(i.invoice_type, '') NOT IN ('Unificada', 'Consolidada')
    ORDER BY ii.billing_period_start NULLS LAST, i.scheduled_at, ii.created_at
  ) l;
  v_existing_count := COALESCE(array_length(v_existing_lines, 1), 0);

  IF v_n = 0 THEN
    IF ABS(v_pending_total) <= GREATEST(0.01, 0.01 * GREATEST(v_firm_count, 1)) THEN
      v_periods := '[]'::jsonb;
    ELSE
      RETURN jsonb_build_object('success', false, 'blocked', 'no_pending_periods',
        'message', 'Las facturas emitidas ya cubren todo el período del ítem, pero el monto pendiente no es cero. Revisa el total del ítem o ajusta por nota de crédito / Reestructurar.',
        'pending_total', v_pending_total);
    END IF;
  END IF;

  IF v_n > 0 THEN
    v_per := ROUND(v_pending_total / v_n, 2);
  END IF;

  FOR v_i IN 0..(v_n - 1) LOOP
    v_pstart := (v_periods->v_i->>'period_start')::date;
    v_pend := (v_periods->v_i->>'period_end')::date;
    v_sched := (v_periods->v_i->>'scheduled_date')::date;
    v_amount := CASE WHEN v_i = v_n - 1 THEN v_pending_total - v_per * (v_n - 1) ELSE v_per END;
    v_description := COALESCE(v_ci.product_name, 'Servicio') || CASE WHEN NULLIF(TRIM(v_ci.account), '') IS NOT NULL THEN ' Cuenta ' || TRIM(v_ci.account) ELSE '' END || ' - Periodo '
      || to_char(v_pstart, 'DD/MM/YYYY') || ' a ' || to_char(v_pend, 'DD/MM/YYYY');

    IF v_i < v_existing_count THEN
      v_line_id := v_existing_lines[v_i + 1];
      v_invoice_id := v_existing_invoices[v_i + 1];
      SELECT COALESCE(tax_rate, 0) INTO v_tax_rate FROM invoices WHERE id = v_invoice_id;
      v_vat := ROUND(v_amount * v_tax_rate / 100.0, 2);
      v_total := v_amount + v_vat;

      UPDATE invoice_items SET
        description = v_description,
        billing_period_start = v_pstart, billing_period_end = v_pend,
        quantity = COALESCE(NULLIF(v_ci.quantity, 0), 1),
        discount_pct = CASE WHEN v_ci.discount_type = 'Porcentaje' AND COALESCE(v_ci.discount_value, 0) > 0
                            THEN v_ci.discount_value ELSE 0 END,
        unit_price_contract_currency = ROUND(v_amount / (COALESCE(NULLIF(v_ci.quantity, 0), 1) *
          CASE WHEN v_ci.discount_type = 'Porcentaje' AND COALESCE(v_ci.discount_value, 0) > 0 AND v_ci.discount_value < 100
               THEN 1 - v_ci.discount_value / 100.0 ELSE 1 END), 6),
        subtotal_contract_currency = v_amount,
        tax_amount_contract_currency = v_vat,
        total_contract_currency = v_total,
        updated_at = now()
      WHERE id = v_line_id;
      v_updated := v_updated + 1;

      SELECT NOT EXISTS (SELECT 1 FROM invoice_items x
        WHERE x.invoice_id = v_invoice_id AND (x.contract_item_id IS DISTINCT FROM p_item_id))
        INTO v_is_exclusive;
      IF v_is_exclusive THEN
        UPDATE invoices SET
          scheduled_at = v_sched, original_issue_date = v_sched, issue_date = v_sched,
          due_date = v_sched + INTERVAL '30 days'
        WHERE id = v_invoice_id;
      ELSE
        v_grouped_kept := v_grouped_kept || jsonb_build_object('invoice_id', v_invoice_id,
          'period_start', v_pstart);
      END IF;
    ELSE
      SELECT * INTO v_ref FROM invoices
      WHERE contract_id = v_contract.id AND holding_id = v_holding_id
        AND COALESCE(invoice_type, '') NOT IN ('Unificada', 'Consolidada')
        AND COALESCE(document_type, 'FACTURA') NOT IN ('NC', 'ND')
      ORDER BY created_at DESC LIMIT 1;

      IF v_ref.id IS NOT NULL THEN
        v_tax_rate := COALESCE(v_ref.tax_rate, 0);
        v_vat := ROUND(v_amount * v_tax_rate / 100.0, 2);
        v_total := v_amount + v_vat;
        INSERT INTO invoices (
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
          v_contract.id, v_holding_id, v_contract.client_id,
          COALESCE(v_ref.company_id, v_contract.company_id),
          COALESCE(v_ref.client_entity_id, v_contract.client_entity_id),
          v_sched, v_sched, v_sched, v_sched + INTERVAL '30 days', 'Por Emitir',
          v_ref.invoice_type, COALESCE(v_ref.document_type, 'FACTURA'),
          COALESCE(v_ref.contract_currency, v_contract.contract_currency),
          COALESCE(v_ref.invoice_currency, v_contract.invoice_currency),
          v_ref.fx_contract_to_invoice, v_ref.tax_rate, v_ref.invoice_terms_and_conditions,
          v_ref.issuer_legal_name, v_ref.issuer_tax_id, v_ref.issuer_address,
          'item_sync', true, COALESCE(v_ref.auto_invoice, false),
          v_ref.client_tax_id, v_ref.payment_method, v_ref.invoice_series, v_ref.fiscal_regime,
          v_ref.export_type, v_ref.requires_references_for_billing,
          v_amount, v_vat
        ) RETURNING id INTO v_invoice_id;
      ELSE
        SELECT * INTO v_company FROM companies WHERE id = v_contract.company_id;
        SELECT * INTO v_entity FROM client_entities WHERE id = v_contract.client_entity_id;
        v_tax_rate := v_company.tax_rate;
        IF v_tax_rate IS NULL THEN
          RAISE EXCEPTION 'La compañía emisora no tiene tasa de impuesto configurada; configúrala antes de generar facturas.' USING ERRCODE = 'P0001';
        END IF;
        v_vat := ROUND(v_amount * v_tax_rate / 100.0, 2);
        v_total := v_amount + v_vat;
        INSERT INTO invoices (
          contract_id, holding_id, client_id, company_id, client_entity_id,
          scheduled_at, original_issue_date, issue_date, due_date, status,
          document_type, contract_currency, invoice_currency,
          tax_rate, issuer_legal_name, issuer_tax_id, client_tax_id,
          split_reason, is_active, auto_invoice, invoice_type,
          amount_contract_currency, vat
        ) VALUES (
          v_contract.id, v_holding_id, v_contract.client_id, v_contract.company_id,
          v_contract.client_entity_id,
          v_sched, v_sched, v_sched, v_sched + INTERVAL '30 days', 'Por Emitir',
          'FACTURA', v_contract.contract_currency, v_contract.invoice_currency,
          v_tax_rate, v_company.legal_name, v_company.tax_id, v_entity.tax_id,
          'item_sync', true, false, 'Manual',
          v_amount, v_vat
        ) RETURNING id INTO v_invoice_id;
      END IF;

      INSERT INTO invoice_items (
        invoice_id, holding_id, contract_id, contract_item_id, product_id,
        description, billing_period_start, billing_period_end,
        quantity, unit_of_measure,
        unit_price_contract_currency, subtotal_contract_currency,
        tax_amount_contract_currency, total_contract_currency,
        contract_currency, invoice_currency, tax_code
      ) VALUES (
        v_invoice_id, v_holding_id, v_contract.id, p_item_id, v_ci.product_id,
        v_description, v_pstart, v_pend,
        1, COALESCE(v_ci.unit_of_measure, 'UND'),
        v_amount, v_amount, v_vat, v_total,
        v_contract.contract_currency, v_contract.invoice_currency,
        COALESCE(v_tax_rate::text, '0')
      ) RETURNING id INTO v_line_id;

      UPDATE invoice_items SET
        quantity = COALESCE(NULLIF(v_ci.quantity, 0), 1),
        discount_pct = CASE WHEN v_ci.discount_type = 'Porcentaje' AND COALESCE(v_ci.discount_value, 0) > 0
                            THEN v_ci.discount_value ELSE 0 END,
        unit_price_contract_currency = ROUND(v_amount / (COALESCE(NULLIF(v_ci.quantity, 0), 1) *
          CASE WHEN v_ci.discount_type = 'Porcentaje' AND COALESCE(v_ci.discount_value, 0) > 0 AND v_ci.discount_value < 100
               THEN 1 - v_ci.discount_value / 100.0 ELSE 1 END), 6),
        subtotal_contract_currency = v_amount,
        tax_amount_contract_currency = v_vat,
        total_contract_currency = v_total,
        unit_price_invoice_currency = ROUND(v_amount / (COALESCE(NULLIF(v_ci.quantity, 0), 1) *
          CASE WHEN v_ci.discount_type = 'Porcentaje' AND COALESCE(v_ci.discount_value, 0) > 0 AND v_ci.discount_value < 100
               THEN 1 - v_ci.discount_value / 100.0 ELSE 1 END), 6),
        subtotal_invoice_currency = v_amount,
        tax_amount_invoice_currency = v_vat,
        total_invoice_currency = v_total,
        description = v_description
      WHERE id = v_line_id;
      v_created := v_created + 1;
    END IF;
    v_touched_invoices := v_touched_invoices || v_invoice_id;
  END LOOP;

  IF v_existing_count > v_n THEN
    WITH del AS (
      DELETE FROM invoice_items WHERE id = ANY(v_existing_lines[(v_n + 1):v_existing_count])
      RETURNING invoice_id
    )
    SELECT v_touched_invoices || COALESCE(array_agg(DISTINCT invoice_id), ARRAY[]::uuid[]),
           COUNT(*)
      INTO v_touched_invoices, v_deleted FROM del;

    WITH marked AS (
      UPDATE invoices SET is_active = false, status = 'Cancelada'
      WHERE id = ANY(v_existing_invoices[(v_n + 1):v_existing_count])
        AND status = 'Por Emitir'
        AND NOT EXISTS (SELECT 1 FROM invoice_items ii WHERE ii.invoice_id = invoices.id)
      RETURNING id
    ) SELECT COUNT(*) INTO v_cancelled FROM marked;
  END IF;

  UPDATE invoices i SET
    amount_contract_currency = COALESCE(sums.subtotal, 0),
    vat = CASE WHEN i.fx_contract_to_invoice IS NULL THEN NULL ELSE COALESCE(sums.vat, 0) END,
    total_invoice_currency = CASE WHEN i.fx_contract_to_invoice IS NULL THEN NULL ELSE COALESCE(sums.total, 0) * i.fx_contract_to_invoice END,
    amount_invoice_currency = CASE WHEN i.fx_contract_to_invoice IS NULL THEN NULL ELSE COALESCE(sums.subtotal, 0) * i.fx_contract_to_invoice END
  FROM (
    SELECT invoice_id, SUM(subtotal_contract_currency) AS subtotal,
           SUM(tax_amount_contract_currency) AS vat, SUM(total_contract_currency) AS total
    FROM invoice_items WHERE invoice_id = ANY(v_touched_invoices) GROUP BY invoice_id
  ) sums WHERE i.id = sums.invoice_id AND COALESCE(i.is_active, true) = true;

  UPDATE invoice_items ii SET
    fx_contract_to_invoice      = inv.fx_contract_to_invoice,
    unit_price_invoice_currency = CASE WHEN inv.fx_contract_to_invoice IS NULL THEN NULL ELSE ii.unit_price_contract_currency * inv.fx_contract_to_invoice END,
    subtotal_invoice_currency   = CASE WHEN inv.fx_contract_to_invoice IS NULL THEN NULL ELSE ii.subtotal_contract_currency * inv.fx_contract_to_invoice END,
    tax_amount_invoice_currency = CASE WHEN inv.fx_contract_to_invoice IS NULL THEN NULL ELSE ii.tax_amount_contract_currency * inv.fx_contract_to_invoice END,
    total_invoice_currency      = CASE WHEN inv.fx_contract_to_invoice IS NULL THEN NULL ELSE ii.total_contract_currency * inv.fx_contract_to_invoice END
  FROM invoices inv
  WHERE ii.invoice_id = inv.id AND inv.id = ANY(v_touched_invoices)
    AND ii.contract_item_id = p_item_id;

  v_continuity := check_contract_item_continuity(p_item_id);
  IF NOT (v_continuity->>'ok')::boolean THEN
    RAISE EXCEPTION 'La sincronización dejó el ítem descuadrado y se revirtió: %', v_continuity::text
      USING ERRCODE = 'check_violation';
  END IF;

  UPDATE contracts c SET
    total_value = agg.total,
    contract_end_date = CASE WHEN c.status = 'Activo' THEN c.contract_end_date ELSE agg.max_end END
  FROM (SELECT MAX(end_date) AS max_end, COALESCE(SUM(final_price), 0) AS total
        FROM contract_items WHERE contract_id = v_contract.id) agg
  WHERE c.id = v_contract.id;

  INSERT INTO invoice_restructure_log(holding_id, contract_id, actor_user_id, action, payload)
  VALUES (v_holding_id, v_contract.id, v_user_id, 'item_sync',
    jsonb_build_object('contract_item_id', p_item_id, 'updated', v_updated,
      'created', v_created, 'deleted_lines', v_deleted, 'cancelled_invoices', v_cancelled,
      'pending_total', v_pending_total, 'firm_total', v_firm_total,
      'grouped_invoices_dates_kept', v_grouped_kept));

  RETURN jsonb_build_object('success', true, 'action', 'sync',
    'updated', v_updated, 'created', v_created,
    'deleted_lines', v_deleted, 'cancelled_invoices', v_cancelled,
    'firm_total', v_firm_total, 'pending_total', v_pending_total,
    'grouped_invoices_dates_kept', v_grouped_kept,
    'validation', v_continuity);
END;
$function$

