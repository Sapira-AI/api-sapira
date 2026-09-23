CREATE OR REPLACE FUNCTION public.derive_contract_items_from_legacy(p_contract_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_holding_id uuid;
  v_contract_currency text;
  v_items_to_update jsonb := '[]'::jsonb;
  v_items_to_create jsonb := '[]'::jsonb;
  v_orphan_mrr jsonb := '[]'::jsonb;
  v_billed_summary jsonb := '[]'::jsonb;
  v_match_record record;
  v_contract_item record;
  v_product_summary record;
BEGIN
  -- Validar permisos RLS: obtener holding_id del contrato
  SELECT holding_id, contract_currency
  INTO v_holding_id, v_contract_currency
  FROM contracts
  WHERE id = p_contract_id;

  IF v_holding_id IS NULL THEN
    RAISE EXCEPTION 'Contract not found or access denied';
  END IF;

  -- Verificar que el usuario tiene acceso al holding
  IF v_holding_id != public.get_user_holding_id() THEN
    RAISE EXCEPTION 'Access denied to this contract';
  END IF;

  -- =====================================================
  -- 1. BILLED SUMMARY: Resumen de facturación por producto
  -- =====================================================
  -- Agrupa matches confirmados por producto y calcula:
  -- - MRR total facturado (en moneda de contrato)
  -- - Períodos únicos (YYYY-MM)
  -- - Cantidad de facturas
  
  FOR v_product_summary IN
    SELECT 
      COALESCE(p.name, iil.description, 'Unknown Product') as product_name,
      m.contract_currency as currency,
      SUM(m.amount_contract_currency) as mrr_invoiced,
      COUNT(DISTINCT il.id) as invoice_count,
      jsonb_agg(DISTINCT to_char(il.issue_date, 'YYYY-MM') ORDER BY to_char(il.issue_date, 'YYYY-MM')) as periods
    FROM invoice_items_legacy_match m
    INNER JOIN invoice_items_legacy iil ON iil.id = m.invoice_item_legacy_id
    INNER JOIN invoices_legacy il ON il.id = iil.invoices_legacy_id
    LEFT JOIN products p ON p.id = m.product_id
    WHERE m.contract_id = p_contract_id
      AND m.status = 'confirmed'
      AND m.holding_id = v_holding_id
    GROUP BY COALESCE(p.name, iil.description, 'Unknown Product'), m.contract_currency
  LOOP
    v_billed_summary := v_billed_summary || jsonb_build_object(
      'product_name', v_product_summary.product_name,
      'currency', v_product_summary.currency,
      'mrr_invoiced', v_product_summary.mrr_invoiced,
      'periods', v_product_summary.periods,
      'invoice_count', v_product_summary.invoice_count
    );
  END LOOP;

  -- =====================================================
  -- 2. ITEMS TO UPDATE: Comparar precios facturados vs contract_items
  -- =====================================================
  -- Para cada contract_item existente, verificar si hay matches confirmados
  -- y si el precio promedio facturado difiere del final_price actual
  
  FOR v_contract_item IN
    SELECT 
      ci.id as item_id,
      ci.product_name,
      ci.final_price as current_price,
      ci.currency
    FROM contract_items ci
    WHERE ci.contract_id = p_contract_id
      AND ci.holding_id = v_holding_id
  LOOP
    -- Calcular precio promedio de matches confirmados para este item
    DECLARE
      v_avg_billed_price numeric;
      v_match_count integer;
    BEGIN
      SELECT 
        AVG(m.amount_contract_currency) as avg_price,
        COUNT(*) as match_count
      INTO v_avg_billed_price, v_match_count
      FROM invoice_items_legacy_match m
      WHERE m.contract_id = p_contract_id
        AND m.contract_item_id = v_contract_item.item_id
        AND m.status = 'confirmed'
        AND m.holding_id = v_holding_id;

      -- Si hay matches y el precio difiere significativamente (>5%), sugerir actualización
      IF v_match_count > 0 AND v_avg_billed_price IS NOT NULL THEN
        IF ABS(v_avg_billed_price - v_contract_item.current_price) > (v_contract_item.current_price * 0.05) THEN
          v_items_to_update := v_items_to_update || jsonb_build_object(
            'item_id', v_contract_item.item_id,
            'product_name', v_contract_item.product_name,
            'current_price', v_contract_item.current_price,
            'suggested_final_price', ROUND(v_avg_billed_price, 2),
            'currency', v_contract_item.currency,
            'reason', format('Average billed price (%s) differs from current price (%s) based on %s confirmed matches',
              ROUND(v_avg_billed_price, 2),
              v_contract_item.current_price,
              v_match_count
            )
          );
        END IF;
      END IF;
    END;
  END LOOP;

  -- =====================================================
  -- 3. ORPHAN MRR: Matches sin contract_item asignado
  -- =====================================================
  -- Identificar matches confirmados que no tienen contract_item_id
  -- (facturación que no se pudo mapear a un item existente)
  
  FOR v_match_record IN
    SELECT 
      m.id as match_id,
      COALESCE(p.name, iil.description) as product_name,
      m.amount_contract_currency as amount,
      m.contract_currency as currency,
      il.invoice_number,
      il.issue_date
    FROM invoice_items_legacy_match m
    INNER JOIN invoice_items_legacy iil ON iil.id = m.invoice_item_legacy_id
    INNER JOIN invoices_legacy il ON il.id = iil.invoices_legacy_id
    LEFT JOIN products p ON p.id = m.product_id
    WHERE m.contract_id = p_contract_id
      AND m.contract_item_id IS NULL
      AND m.status = 'confirmed'
      AND m.holding_id = v_holding_id
    ORDER BY il.issue_date DESC
  LOOP
    v_orphan_mrr := v_orphan_mrr || jsonb_build_object(
      'match_id', v_match_record.match_id,
      'product_name', v_match_record.product_name,
      'amount', v_match_record.amount,
      'currency', v_match_record.currency,
      'invoice_number', v_match_record.invoice_number,
      'issue_date', v_match_record.issue_date,
      'reason', 'Confirmed match without assigned contract_item_id'
    );
  END LOOP;

  -- =====================================================
  -- 4. ITEMS TO CREATE: Productos facturados sin contract_item
  -- =====================================================
  -- Para cada producto único en orphan_mrr, sugerir crear un contract_item
  -- usando el precio promedio facturado
  
  FOR v_product_summary IN
    SELECT 
      COALESCE(p.name, iil.description) as product_name,
      m.contract_currency as currency,
      AVG(m.amount_contract_currency) as avg_price,
      COUNT(*) as occurrence_count
    FROM invoice_items_legacy_match m
    INNER JOIN invoice_items_legacy iil ON iil.id = m.invoice_item_legacy_id
    LEFT JOIN products p ON p.id = m.product_id
    WHERE m.contract_id = p_contract_id
      AND m.contract_item_id IS NULL
      AND m.status = 'confirmed'
      AND m.holding_id = v_holding_id
    GROUP BY COALESCE(p.name, iil.description), m.contract_currency
  LOOP
    -- Verificar que no exista ya un contract_item con nombre similar
    IF NOT EXISTS (
      SELECT 1 FROM contract_items ci
      WHERE ci.contract_id = p_contract_id
        AND ci.holding_id = v_holding_id
        AND LOWER(ci.product_name) = LOWER(v_product_summary.product_name)
    ) THEN
      v_items_to_create := v_items_to_create || jsonb_build_object(
        'product_name', v_product_summary.product_name,
        'final_price', ROUND(v_product_summary.avg_price, 2),
        'currency', v_product_summary.currency,
        'reason', format('Product billed %s times without matching contract_item (avg price: %s)',
          v_product_summary.occurrence_count,
          ROUND(v_product_summary.avg_price, 2)
        )
      );
    END IF;
  END LOOP;

  -- =====================================================
  -- Retornar resultado completo
  -- =====================================================
  RETURN jsonb_build_object(
    'items_to_update', v_items_to_update,
    'items_to_create', v_items_to_create,
    'orphan_mrr', v_orphan_mrr,
    'billed_summary', v_billed_summary
  );
END;
$function$;

COMMENT ON FUNCTION public."derive_contract_items_from_legacy"(p_contract_id uuid) IS 'Analiza facturación legacy reconciliada y retorna sugerencias determinísticas para actualizar/crear contract_items. No modifica datos, solo analiza y sugiere.';
