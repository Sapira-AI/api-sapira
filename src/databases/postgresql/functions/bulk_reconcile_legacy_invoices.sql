CREATE OR REPLACE FUNCTION public.bulk_reconcile_legacy_invoices(p_contract_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_holding_id uuid;
  v_invoice_record record;
  v_item_record record;
  v_invoice_id uuid;
  v_contract_record record;
  v_reconciled_count integer := 0;
  v_failed_count integer := 0;
  v_errors jsonb := '[]'::jsonb;
  v_new_invoice_id uuid;
  v_subtotal_invoice_currency numeric;
  v_subtotal_contract_currency numeric;
  v_tax_rate numeric;
  v_tax_amount_invoice_currency numeric;
  v_tax_amount_contract_currency numeric;
  v_total_invoice_currency numeric;
  v_system_currency text;
  v_fx_contract_to_system numeric;
  v_fx_contract_to_invoice numeric;
  v_amount_system_currency numeric;
  v_total_system_currency numeric;
  v_company_tax_rate numeric;
  v_total_legacy numeric;
  v_total_pending numeric;
  v_item_subtotal_invoice numeric;
  v_item_unit_price_invoice numeric;
BEGIN
  v_holding_id := get_current_user_holding_id();

  IF v_holding_id IS NULL THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Usuario no tiene holding_id asignado',
      'reconciled_count', 0,
      'failed_count', 0
    );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.user_holdings
    WHERE user_id = auth.uid() AND holding_id = v_holding_id
  ) THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Usuario no tiene permisos para este holding',
      'reconciled_count', 0,
      'failed_count', 0
    );
  END IF;

  SELECT * INTO v_contract_record
  FROM public.contracts
  WHERE id = p_contract_id
    AND holding_id = v_holding_id
    AND is_legacy = true;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Contrato no encontrado, no pertenece al holding o no es legacy',
      'reconciled_count', 0,
      'failed_count', 0
    );
  END IF;

  SELECT
    hs.system_currency,
    COALESCE(
      (SELECT rate FROM public.fx_rates
       WHERE holding_id = v_holding_id
         AND from_currency = v_contract_record.contract_currency
         AND to_currency = hs.system_currency
         AND effective_date <= CURRENT_DATE
       ORDER BY effective_date DESC
       LIMIT 1),
      1.0
    ) as fx_rate
  INTO v_system_currency, v_fx_contract_to_system
  FROM public.holding_settings hs
  WHERE hs.holding_id = v_holding_id;

  v_system_currency := COALESCE(v_system_currency, 'USD');
  v_fx_contract_to_system := COALESCE(v_fx_contract_to_system, 1.0);

  FOR v_invoice_record IN
    SELECT
      il.*,
      c.tax_rate as company_tax_rate
    FROM public.invoices_legacy il
    LEFT JOIN public.companies c ON c.id = il.company_id
    WHERE il.contract_id = p_contract_id
      AND il.holding_id = v_holding_id
      AND il.reconciliation_status != 'confirmed'
    ORDER BY il.issue_date
  LOOP
    BEGIN
      v_invoice_id := v_invoice_record.id;

      v_tax_rate := v_invoice_record.company_tax_rate;
      IF v_tax_rate IS NULL THEN
        v_failed_count := v_failed_count + 1;
        v_errors := v_errors || jsonb_build_object(
          'invoice_id', v_invoice_id,
          'error', 'TAX_RATE_NOT_CONFIGURED: Company sin tax_rate configurado'
        );
        CONTINUE;
      END IF;
      v_tax_rate := v_tax_rate / 100.0;

      IF EXISTS (
        SELECT 1 FROM public.invoices
        WHERE legacy_invoice_id = v_invoice_id
          AND is_legacy = true
      ) THEN
        v_failed_count := v_failed_count + 1;
        v_errors := v_errors || jsonb_build_object(
          'invoice_id', v_invoice_id,
          'error', 'Factura ya reconciliada'
        );
        CONTINUE;
      END IF;

      SELECT
        COALESCE(SUM(COALESCE(m.amount_invoice_currency, il.subtotal)), 0),
        COALESCE(SUM(COALESCE(m.amount_invoice_currency, il.subtotal) * v_tax_rate), 0),
        COALESCE(SUM(COALESCE(m.amount_invoice_currency, il.subtotal) * (1 + v_tax_rate)), 0)
      INTO
        v_subtotal_invoice_currency,
        v_tax_amount_invoice_currency,
        v_total_invoice_currency
      FROM public.invoice_items_legacy il
      LEFT JOIN public.invoice_items_legacy_match m ON m.invoice_item_legacy_id = il.id
      WHERE il.invoices_legacy_id = v_invoice_id;

      SELECT
        COALESCE(SUM(m.amount_contract_currency), 0)
      INTO v_subtotal_contract_currency
      FROM public.invoice_items_legacy il
      LEFT JOIN public.invoice_items_legacy_match m ON m.invoice_item_legacy_id = il.id
      WHERE il.invoices_legacy_id = v_invoice_id;

      IF v_subtotal_contract_currency = 0 THEN
        v_subtotal_contract_currency := v_subtotal_invoice_currency;
      END IF;

      v_tax_amount_contract_currency := v_subtotal_contract_currency * v_tax_rate;

      IF v_subtotal_contract_currency > 0 THEN
        v_fx_contract_to_invoice := v_subtotal_invoice_currency / v_subtotal_contract_currency;
      ELSE
        v_fx_contract_to_invoice := 1.0;
      END IF;

      v_amount_system_currency := v_subtotal_contract_currency * v_fx_contract_to_system;
      v_total_system_currency := v_subtotal_contract_currency * (1 + v_tax_rate) * v_fx_contract_to_system;

        INSERT INTO public.invoices (
          holding_id, contract_id, client_id, client_entity_id, company_id,
          invoice_number, issue_date, original_issue_date, due_date,
          invoice_currency, contract_currency, system_currency,
          subtotal_invoice_currency, tax_amount_invoice_currency, total_invoice_currency,
          amount_invoice_currency, amount_contract_currency, amount_system_currency, total_system_currency,
          vat, tax_rate, fx_contract_to_invoice, fx_contract_to_system,
          status, is_legacy, legacy_invoice_id, legacy_source_system, pdf_url, notes
        )
        VALUES (
          v_holding_id, p_contract_id, v_contract_record.client_id, v_contract_record.client_entity_id, v_invoice_record.company_id,
          v_invoice_record.invoice_number, v_invoice_record.issue_date, v_invoice_record.issue_date, v_invoice_record.due_date,
          v_invoice_record.invoice_currency, v_contract_record.contract_currency, v_system_currency,
          v_subtotal_invoice_currency, v_tax_amount_invoice_currency, v_total_invoice_currency,
          v_subtotal_invoice_currency, v_subtotal_contract_currency, v_amount_system_currency, v_total_system_currency,
          v_tax_amount_invoice_currency, v_tax_rate, v_fx_contract_to_invoice, v_fx_contract_to_system,
          COALESCE(v_invoice_record.status, 'Pagada'), true, v_invoice_id,
          COALESCE(v_invoice_record.source_system, 'Legacy Import'), v_invoice_record.pdf_url,
          'Migrada desde factura legacy mediante reconciliación masiva. ' || COALESCE(v_invoice_record.notes, '')
        )
        RETURNING id INTO v_new_invoice_id;

      FOR v_item_record IN
        SELECT
          il.*,
          m.amount_contract_currency,
          m.amount_invoice_currency as matched_amount_invoice,
          m.contract_item_id,
          ci.product_name,
          ci.unit_price as contract_unit_price,
          ci.currency as contract_currency,
          ci.unit_of_measure,
          ci.quantity as contract_quantity
        FROM public.invoice_items_legacy il
        LEFT JOIN public.invoice_items_legacy_match m ON m.invoice_item_legacy_id = il.id
        LEFT JOIN public.contract_items ci ON ci.id = m.contract_item_id
        WHERE il.invoices_legacy_id = v_invoice_id
      LOOP
        v_item_subtotal_invoice := COALESCE(v_item_record.matched_amount_invoice, v_item_record.subtotal);
        v_item_unit_price_invoice := CASE
          WHEN COALESCE(v_item_record.quantity, 1) > 0
          THEN v_item_subtotal_invoice / v_item_record.quantity
          ELSE v_item_subtotal_invoice
        END;

        INSERT INTO public.invoice_items (
          holding_id, invoice_id, contract_item_id, product_name, quantity, unit_of_measure,
          unit_price_contract_currency, unit_price_invoice_currency,
          subtotal_contract_currency, subtotal_invoice_currency,
          tax_rate, tax_amount_contract_currency, tax_amount_invoice_currency,
          total_contract_currency, total_invoice_currency, notes
        )
        VALUES (
          v_holding_id, v_new_invoice_id, v_item_record.contract_item_id,
          COALESCE(v_item_record.product_name, v_item_record.description),
          COALESCE(v_item_record.quantity, 1), v_item_record.unit_of_measure,
          COALESCE(v_item_record.contract_unit_price, v_item_record.unit_price), v_item_unit_price_invoice,
          COALESCE(v_item_record.amount_contract_currency, v_item_record.subtotal), v_item_subtotal_invoice,
          v_tax_rate,
          COALESCE(v_item_record.amount_contract_currency, v_item_record.subtotal) * v_tax_rate,
          v_item_subtotal_invoice * v_tax_rate,
          COALESCE(v_item_record.amount_contract_currency, v_item_record.subtotal) * (1 + v_tax_rate),
          v_item_subtotal_invoice * (1 + v_tax_rate),
          'Migrado desde item legacy. ' || COALESCE(v_item_record.notes, '')
        );
      END LOOP;

      UPDATE public.invoices_legacy
      SET reconciliation_status = 'confirmed',
          reconciled_invoice_id = v_new_invoice_id
      WHERE id = v_invoice_id;

      v_reconciled_count := v_reconciled_count + 1;

    EXCEPTION WHEN OTHERS THEN
      v_failed_count := v_failed_count + 1;
      v_errors := v_errors || jsonb_build_object(
        'invoice_id', v_invoice_id,
        'error', SQLERRM
      );
    END;
  END LOOP;

  SELECT COALESCE(SUM(amount_contract_currency), 0)
  INTO v_total_legacy
  FROM invoices
  WHERE contract_id = p_contract_id
    AND COALESCE(is_legacy, false) = true;

  v_total_pending := COALESCE(v_contract_record.total_value, 0) - v_total_legacy;

  UPDATE contract_invoices
  SET is_satisfied = true,
      updated_at = NOW()
  WHERE contract_id = p_contract_id;

  RAISE NOTICE '[BULK_RECONCILE] Marked all contract_invoices as satisfied for contract %', p_contract_id;

  IF v_total_pending > 0 THEN
    INSERT INTO contract_invoices (
      contract_id, holding_id, invoice_date, amount, currency, status, is_satisfied, is_editable, contract_item_details
    ) VALUES (
      p_contract_id, v_holding_id,
      COALESCE(v_contract_record.legacy_cutoff_date, CURRENT_DATE) + INTERVAL '1 day',
      v_total_pending, v_contract_record.contract_currency,
      'Programada', false, true, '[]'::jsonb
    );

    RAISE NOTICE '[BULK_RECONCILE] Created pending contract_invoice for % % (difference)',
      v_total_pending, v_contract_record.contract_currency;
  ELSE
    RAISE NOTICE '[BULK_RECONCILE] No pending amount, all invoices covered by legacy';
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'reconciled_count', v_reconciled_count,
    'failed_count', v_failed_count,
    'errors', v_errors,
    'total_legacy', v_total_legacy,
    'total_pending', v_total_pending
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.bulk_reconcile_legacy_invoices(p_invoice_ids uuid[], p_contract_id uuid, p_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_holding_id uuid;
  v_invoice_id uuid;
  v_invoice_record record;
  v_item_record record;
  v_match_record record;
  v_contract_record record;
  v_reconciled_count integer := 0;
  v_failed_count integer := 0;
  v_errors jsonb := '[]'::jsonb;
  v_new_invoice_id uuid;
  v_subtotal_invoice_currency numeric;
  v_subtotal_contract_currency numeric;
  v_tax_rate numeric;
  v_tax_amount_invoice_currency numeric;
  v_tax_amount_contract_currency numeric;
  v_total_invoice_currency numeric;
  v_system_currency text;
  v_fx_contract_to_system numeric;
  v_fx_contract_to_invoice numeric;
  v_amount_system_currency numeric;
  v_total_system_currency numeric;
BEGIN
  v_holding_id := get_current_user_holding_id();

  IF v_holding_id IS NULL THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Usuario no tiene holding_id asignado',
      'reconciled_count', 0,
      'failed_count', 0
    );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.user_holdings
    WHERE user_id = p_user_id
    AND holding_id = v_holding_id
  ) THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Usuario no autorizado',
      'reconciled_count', 0,
      'failed_count', 0
    );
  END IF;

  SELECT
    c.*,
    COALESCE(h.system_currency, 'USD') as system_currency
  INTO v_contract_record
  FROM public.contracts c
  LEFT JOIN public.company_holdings h ON h.id = c.holding_id
  WHERE c.id = p_contract_id
    AND c.holding_id = v_holding_id
    AND c.is_legacy = true;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Contrato no encontrado o no es legacy',
      'reconciled_count', 0,
      'failed_count', 0
    );
  END IF;

  v_system_currency := v_contract_record.system_currency;

  SELECT COALESCE(
    (SELECT rate FROM public.exchange_rates
     WHERE from_currency = v_contract_record.contract_currency
     AND to_currency = v_system_currency
     ORDER BY rate_date DESC LIMIT 1),
    1.0
  ) INTO v_fx_contract_to_system;

  FOREACH v_invoice_id IN ARRAY p_invoice_ids
  LOOP
    BEGIN
      SELECT * INTO v_invoice_record
      FROM public.invoices_legacy
      WHERE id = v_invoice_id
        AND holding_id = v_holding_id;

      IF NOT FOUND THEN
        v_failed_count := v_failed_count + 1;
        v_errors := v_errors || jsonb_build_object(
          'invoice_id', v_invoice_id,
          'error', 'Factura no encontrada'
        );
        CONTINUE;
      END IF;

      IF v_invoice_record.reconciliation_status = 'migrated' THEN
        v_failed_count := v_failed_count + 1;
        v_errors := v_errors || jsonb_build_object(
          'invoice_id', v_invoice_id,
          'error', 'Factura ya reconciliada'
        );
        CONTINUE;
      END IF;

      SELECT tax_rate INTO v_tax_rate
      FROM public.companies
      WHERE id = v_invoice_record.company_id;
      IF v_tax_rate IS NULL THEN
        v_failed_count := v_failed_count + 1;
        v_errors := v_errors || jsonb_build_object(
          'invoice_id', v_invoice_id,
          'error', 'TAX_RATE_NOT_CONFIGURED: Company sin tax_rate configurado'
        );
        CONTINUE;
      END IF;
      v_tax_rate := v_tax_rate / 100.0;

      SELECT
        COALESCE(SUM(subtotal), 0),
        COALESCE(SUM(subtotal * v_tax_rate), 0),
        COALESCE(SUM(subtotal * (1 + v_tax_rate)), 0)
      INTO
        v_subtotal_invoice_currency,
        v_tax_amount_invoice_currency,
        v_total_invoice_currency
      FROM public.invoice_items_legacy
      WHERE invoices_legacy_id = v_invoice_id;

      SELECT
        COALESCE(SUM(m.amount_contract_currency), 0)
      INTO v_subtotal_contract_currency
      FROM public.invoice_items_legacy il
      LEFT JOIN public.invoice_items_legacy_match m ON m.invoice_item_legacy_id = il.id
      WHERE il.invoices_legacy_id = v_invoice_id;

      IF v_subtotal_contract_currency = 0 THEN
        v_subtotal_contract_currency := v_subtotal_invoice_currency;
      END IF;

      v_tax_amount_contract_currency := (v_tax_amount_invoice_currency / NULLIF(v_subtotal_invoice_currency / NULLIF(v_subtotal_contract_currency, 0), 0));

      IF v_tax_amount_contract_currency IS NULL OR v_tax_amount_contract_currency = 0 THEN
        v_tax_amount_contract_currency := v_subtotal_contract_currency * v_tax_rate;
      END IF;

      IF v_subtotal_contract_currency > 0 THEN
        v_fx_contract_to_invoice := v_subtotal_invoice_currency / v_subtotal_contract_currency;
      ELSE
        v_fx_contract_to_invoice := 1.0;
      END IF;

      v_amount_system_currency := v_subtotal_contract_currency * v_fx_contract_to_system;
      v_total_system_currency := (v_subtotal_contract_currency + v_tax_amount_contract_currency) * v_fx_contract_to_system;

        INSERT INTO public.invoices (
          holding_id, contract_id, client_id, client_entity_id,
          invoice_number, issue_date, original_issue_date, due_date,
          invoice_currency, contract_currency, system_currency,
          subtotal_invoice_currency, tax_amount_invoice_currency, total_invoice_currency,
          amount_invoice_currency, amount_contract_currency, amount_system_currency, total_system_currency,
          vat, fx_contract_to_invoice, fx_contract_to_system,
          status, is_legacy, legacy_invoice_id, legacy_source_system, pdf_url, notes
        )
        VALUES (
          v_holding_id, p_contract_id, v_contract_record.client_id, v_contract_record.client_entity_id,
          v_invoice_record.invoice_number, v_invoice_record.issue_date, v_invoice_record.issue_date, v_invoice_record.due_date,
          v_invoice_record.currency, v_contract_record.contract_currency, v_system_currency,
          v_subtotal_invoice_currency, v_tax_amount_invoice_currency, v_total_invoice_currency,
          v_subtotal_invoice_currency, v_subtotal_contract_currency, v_amount_system_currency, v_total_system_currency,
          v_tax_amount_invoice_currency, v_fx_contract_to_invoice, v_fx_contract_to_system,
          COALESCE(v_invoice_record.status, 'Pagada'), true, v_invoice_id,
          COALESCE(v_invoice_record.source_system, 'Legacy Import'), v_invoice_record.pdf_url,
          'Migrada desde factura legacy mediante reconciliación masiva. ' || COALESCE(v_invoice_record.notes, '')
        )
        RETURNING id INTO v_new_invoice_id;

      FOR v_item_record IN
        SELECT
          il.*,
          m.amount_contract_currency,
          m.amount_invoice_currency as matched_amount_invoice,
          m.fx_contract_to_invoice as matched_fx,
          m.contract_item_id,
          m.quantity as matched_quantity,
          m.unit_of_measure as matched_unit_of_measure,
          ci.unit_price as contract_unit_price,
          ci.discount_value as contract_discount_pct
        FROM public.invoice_items_legacy il
        LEFT JOIN public.invoice_items_legacy_match m ON m.invoice_item_legacy_id = il.id
        LEFT JOIN public.contract_items ci ON ci.id = m.contract_item_id
        WHERE il.invoices_legacy_id = v_invoice_id
      LOOP
        DECLARE
          v_item_quantity numeric;
          v_item_unit_of_measure text;
          v_item_unit_price_contract numeric;
          v_item_unit_price_invoice numeric;
          v_item_discount_pct numeric;
          v_item_subtotal_contract numeric;
          v_item_subtotal_invoice numeric;
          v_item_tax_contract numeric;
          v_item_tax_invoice numeric;
          v_item_total_contract numeric;
          v_item_total_invoice numeric;
          v_item_fx numeric;
        BEGIN
          v_item_quantity := COALESCE(v_item_record.matched_quantity, v_item_record.quantity, 1);
          v_item_unit_of_measure := COALESCE(v_item_record.matched_unit_of_measure, v_item_record.unit_of_measure, 'UNIDAD');

          IF v_item_record.amount_contract_currency IS NOT NULL THEN
            v_item_subtotal_contract := v_item_record.amount_contract_currency;
            v_item_subtotal_invoice := COALESCE(v_item_record.matched_amount_invoice, v_item_record.subtotal);

            IF v_item_record.contract_unit_price IS NOT NULL THEN
              v_item_unit_price_contract := v_item_record.contract_unit_price;
              v_item_discount_pct := COALESCE(v_item_record.contract_discount_pct, 0);
            ELSE
              IF v_item_quantity > 0 THEN
                v_item_unit_price_contract := v_item_subtotal_contract / v_item_quantity;
              ELSE
                v_item_unit_price_contract := v_item_subtotal_contract;
              END IF;
              v_item_discount_pct := 0;
            END IF;

            v_item_unit_price_invoice := v_item_unit_price_contract * v_fx_contract_to_invoice;
            v_item_fx := v_fx_contract_to_invoice;
          ELSE
            v_item_subtotal_contract := COALESCE(v_item_record.subtotal, 0);
            v_item_subtotal_invoice := COALESCE(v_item_record.subtotal, 0);
            v_item_fx := 1.0;
            v_item_discount_pct := 0;

            IF v_item_quantity > 0 THEN
              v_item_unit_price_contract := v_item_subtotal_contract / v_item_quantity;
              v_item_unit_price_invoice := v_item_subtotal_invoice / v_item_quantity;
            ELSE
              v_item_unit_price_contract := v_item_subtotal_contract;
              v_item_unit_price_invoice := v_item_subtotal_invoice;
            END IF;
          END IF;

          v_item_tax_contract := v_item_subtotal_contract * v_tax_rate;
          v_item_tax_invoice := v_item_subtotal_invoice * v_tax_rate;
          v_item_total_contract := v_item_subtotal_contract + v_item_tax_contract;
          v_item_total_invoice := v_item_subtotal_invoice + v_item_tax_invoice;

          INSERT INTO public.invoice_items (
            invoice_id, holding_id, contract_id, contract_item_id, description,
            quantity, unit_of_measure, discount_pct, issue_date, status,
            invoice_currency, contract_currency,
            unit_price_invoice_currency, subtotal_invoice_currency, tax_amount_invoice_currency, total_invoice_currency,
            unit_price_contract_currency, subtotal_contract_currency, tax_amount_contract_currency, total_contract_currency,
            fx_contract_to_invoice, legacy_item_id
          )
          VALUES (
            v_new_invoice_id, v_holding_id, p_contract_id, v_item_record.contract_item_id, v_item_record.description,
            v_item_quantity, v_item_unit_of_measure, v_item_discount_pct, v_invoice_record.issue_date,
            COALESCE(v_invoice_record.status, 'Pagada'),
            v_invoice_record.currency, v_contract_record.contract_currency,
            v_item_unit_price_invoice, v_item_subtotal_invoice, v_item_tax_invoice, v_item_total_invoice,
            v_item_unit_price_contract, v_item_subtotal_contract, v_item_tax_contract, v_item_total_contract,
            v_item_fx, v_item_record.id
          );
        END;

        INSERT INTO public.invoice_items_legacy_match (
          invoice_item_legacy_id, contract_id, contract_item_id, contract_currency,
          fx_contract_to_invoice, amount_contract_currency, amount_invoice_currency,
          quantity, unit_of_measure, status, notes,
          created_by, confirmed_by, confirmed_at, holding_id
        )
        VALUES (
          v_item_record.id, p_contract_id, v_item_record.contract_item_id,
          v_contract_record.contract_currency,
          COALESCE(v_item_record.matched_fx, 1.0),
          COALESCE(v_item_record.amount_contract_currency, v_item_record.subtotal, 0),
          COALESCE(v_item_record.matched_amount_invoice, v_item_record.subtotal, 0),
          v_item_quantity, v_item_unit_of_measure, 'confirmed', 'Reconciliación masiva',
          p_user_id, p_user_id, NOW(), v_holding_id
        )
        ON CONFLICT (invoice_item_legacy_id)
        DO UPDATE SET
          status = 'confirmed',
          confirmed_by = p_user_id,
          confirmed_at = NOW();
      END LOOP;

      UPDATE public.invoices_legacy
      SET reconciliation_status = 'migrated',
          contract_id = p_contract_id
      WHERE id = v_invoice_id;

      PERFORM public.update_legacy_reconciliation_pct(p_contract_id);

      v_reconciled_count := v_reconciled_count + 1;

    EXCEPTION WHEN OTHERS THEN
      v_failed_count := v_failed_count + 1;
      v_errors := v_errors || jsonb_build_object(
        'invoice_id', v_invoice_id,
        'error', SQLERRM
      );
    END;
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'reconciled_count', v_reconciled_count,
    'failed_count', v_failed_count,
    'errors', v_errors
  );
END;
$function$
