CREATE OR REPLACE FUNCTION public.validate_legacy_activation(p_contract_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_holding_id uuid;
  v_contract record;
  v_can_activate boolean := true;
  v_reconciliation_pct numeric := 0;
  v_blockers jsonb := '[]'::jsonb;
  v_warnings jsonb := '[]'::jsonb;
  v_total_contract_mrr numeric := 0;
  v_total_billed_mrr numeric := 0;
  v_confirmed_matches_count integer := 0;
  v_contract_items_count integer := 0;
  v_orphan_mrr_data jsonb;
BEGIN
  -- =====================================================
  -- 1. Validar que el contrato existe y es legacy
  -- =====================================================
  SELECT 
    c.holding_id,
    c.is_legacy,
    c.start_date,
    c.end_date,
    c.contract_currency
  INTO v_contract
  FROM contracts c
  WHERE c.id = p_contract_id;

  IF NOT FOUND THEN
    v_blockers := v_blockers || jsonb_build_object(
      'type', 'contract_not_found',
      'message', 'Contract does not exist or access denied'
    );
    v_can_activate := false;
    
    RETURN jsonb_build_object(
      'can_activate', v_can_activate,
      'reconciliation_pct', 0,
      'blockers', v_blockers,
      'warnings', v_warnings
    );
  END IF;

  v_holding_id := v_contract.holding_id;

  -- Verificar permisos RLS
  IF v_holding_id != public.get_user_holding_id() THEN
    v_blockers := v_blockers || jsonb_build_object(
      'type', 'access_denied',
      'message', 'Access denied to this contract'
    );
    v_can_activate := false;
    
    RETURN jsonb_build_object(
      'can_activate', v_can_activate,
      'reconciliation_pct', 0,
      'blockers', v_blockers,
      'warnings', v_warnings
    );
  END IF;

  -- BLOCKER: Debe estar marcado como legacy
  IF v_contract.is_legacy = false THEN
    v_blockers := v_blockers || jsonb_build_object(
      'type', 'not_legacy',
      'message', 'Contract is not marked as legacy'
    );
    v_can_activate := false;
  END IF;

  -- =====================================================
  -- 2. Validar contract_items
  -- =====================================================
  SELECT 
    COUNT(*),
    COALESCE(SUM(final_price), 0)
  INTO v_contract_items_count, v_total_contract_mrr
  FROM contract_items
  WHERE contract_id = p_contract_id
    AND holding_id = v_holding_id;

  -- BLOCKER: Debe tener al menos un contract_item
  IF v_contract_items_count = 0 THEN
    v_blockers := v_blockers || jsonb_build_object(
      'type', 'no_contract_items',
      'message', 'Contract must have at least one contract_item defined'
    );
    v_can_activate := false;
  END IF;

  -- =====================================================
  -- 3. Validar matches confirmados
  -- =====================================================
  SELECT 
    COUNT(*),
    COALESCE(SUM(amount_contract_currency), 0)
  INTO v_confirmed_matches_count, v_total_billed_mrr
  FROM invoice_items_legacy_match
  WHERE contract_id = p_contract_id
    AND status = 'confirmed'
    AND holding_id = v_holding_id;

  -- BLOCKER: Debe tener al menos un match confirmado
  IF v_confirmed_matches_count = 0 THEN
    v_blockers := v_blockers || jsonb_build_object(
      'type', 'no_confirmed_matches',
      'message', 'Contract must have at least one confirmed legacy invoice match'
    );
    v_can_activate := false;
  END IF;

  -- =====================================================
  -- 4. Validar FX en matches
  -- =====================================================
  DECLARE
    v_missing_fx_count integer;
  BEGIN
    SELECT COUNT(*)
    INTO v_missing_fx_count
    FROM invoice_items_legacy_match m
    WHERE m.contract_id = p_contract_id
      AND m.status = 'confirmed'
      AND m.holding_id = v_holding_id
      AND (m.fx_contract_to_invoice IS NULL OR m.fx_contract_to_invoice <= 0);

    IF v_missing_fx_count > 0 THEN
      v_blockers := v_blockers || jsonb_build_object(
        'type', 'missing_fx_rate',
        'message', format('%s confirmed matches are missing valid fx_contract_to_invoice rate', v_missing_fx_count)
      );
      v_can_activate := false;
    END IF;
  END;

  -- =====================================================
  -- 5. Validar fechas de facturas dentro del rango contractual
  -- =====================================================
  IF v_contract.start_date IS NOT NULL OR v_contract.end_date IS NOT NULL THEN
    DECLARE
      v_out_of_range_count integer;
      v_min_date date;
      v_max_date date;
    BEGIN
      SELECT COUNT(*), MIN(il.issue_date), MAX(il.issue_date)
      INTO v_out_of_range_count, v_min_date, v_max_date
      FROM invoice_items_legacy_match m
      INNER JOIN invoice_items_legacy iil ON iil.id = m.invoice_item_legacy_id
      INNER JOIN invoices_legacy il ON il.id = iil.invoices_legacy_id
      WHERE m.contract_id = p_contract_id
        AND m.status = 'confirmed'
        AND m.holding_id = v_holding_id
        AND (
          (v_contract.start_date IS NOT NULL AND il.issue_date < v_contract.start_date)
          OR
          (v_contract.end_date IS NOT NULL AND il.issue_date > v_contract.end_date)
        );

      IF v_out_of_range_count > 0 THEN
        v_blockers := v_blockers || jsonb_build_object(
          'type', 'invoices_out_of_range',
          'message', format('%s invoices have issue_date outside contract date range (%s to %s). Found dates from %s to %s',
            v_out_of_range_count,
            COALESCE(v_contract.start_date::text, 'N/A'),
            COALESCE(v_contract.end_date::text, 'N/A'),
            v_min_date,
            v_max_date
          )
        );
        v_can_activate := false;
      END IF;
    END;
  END IF;

  -- =====================================================
  -- 6. Calcular reconciliation_pct
  -- =====================================================
  IF v_total_contract_mrr > 0 THEN
    v_reconciliation_pct := ROUND((v_total_billed_mrr / NULLIF(v_total_contract_mrr, 0)) * 100, 2);
  ELSE
    v_reconciliation_pct := 0;
  END IF;

  -- =====================================================
  -- 7. WARNINGS: Orphan MRR
  -- =====================================================
  -- Detectar matches confirmados sin contract_item_id asignado
  DECLARE
    v_orphan_count integer;
    v_orphan_amount numeric;
  BEGIN
    SELECT 
      COUNT(*),
      COALESCE(SUM(m.amount_contract_currency), 0)
    INTO v_orphan_count, v_orphan_amount
    FROM invoice_items_legacy_match m
    WHERE m.contract_id = p_contract_id
      AND m.contract_item_id IS NULL
      AND m.status = 'confirmed'
      AND m.holding_id = v_holding_id;

    IF v_orphan_count > 0 THEN
      v_warnings := v_warnings || jsonb_build_object(
        'type', 'orphan_mrr',
        'message', format('%s confirmed matches (%s %s) are not assigned to any contract_item',
          v_orphan_count,
          ROUND(v_orphan_amount, 2),
          v_contract.contract_currency
        )
      );
    END IF;
  END;

  -- =====================================================
  -- 8. WARNINGS: Discrepancia MRR >20%
  -- =====================================================
  IF v_total_contract_mrr > 0 THEN
    DECLARE
      v_discrepancy_pct numeric;
    BEGIN
      v_discrepancy_pct := ABS(((v_total_billed_mrr - v_total_contract_mrr) / NULLIF(v_total_contract_mrr, 0)) * 100);
      
      IF v_discrepancy_pct > 20 THEN
        v_warnings := v_warnings || jsonb_build_object(
          'type', 'mrr_discrepancy',
          'message', format('MRR discrepancy of %s%%. Contract MRR: %s, Billed MRR: %s (%s)',
            ROUND(v_discrepancy_pct, 1),
            ROUND(v_total_contract_mrr, 2),
            ROUND(v_total_billed_mrr, 2),
            v_contract.contract_currency
          )
        );
      END IF;
    END;
  END IF;

  -- =====================================================
  -- 9. WARNINGS: Items sin facturas (CMRR risk)
  -- =====================================================
  FOR v_orphan_mrr_data IN
    SELECT 
      ci.id as item_id,
      ci.product_name,
      ci.final_price
    FROM contract_items ci
    WHERE ci.contract_id = p_contract_id
      AND ci.holding_id = v_holding_id
      AND NOT EXISTS (
        SELECT 1 
        FROM invoice_items_legacy_match m
        WHERE m.contract_id = p_contract_id
          AND m.contract_item_id = ci.id
          AND m.status = 'confirmed'
          AND m.holding_id = v_holding_id
      )
  LOOP
    v_warnings := v_warnings || jsonb_build_object(
      'type', 'cmrr_risk',
      'item_id', v_orphan_mrr_data->>'item_id',
      'message', format('Contract item "%s" (%s %s) has no confirmed invoices',
        v_orphan_mrr_data->>'product_name',
        v_orphan_mrr_data->>'final_price',
        v_contract.contract_currency
      )
    );
  END LOOP;

  -- =====================================================
  -- Retornar resultado completo
  -- =====================================================
  RETURN jsonb_build_object(
    'can_activate', v_can_activate,
    'reconciliation_pct', v_reconciliation_pct,
    'blockers', v_blockers,
    'warnings', v_warnings
  );
END;
$function$

