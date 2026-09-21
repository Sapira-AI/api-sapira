CREATE OR REPLACE FUNCTION public.detect_similar_invoices(p_invoice_ids uuid[], p_holding_id uuid)
 RETURNS TABLE(fingerprint_hash text, invoice_ids uuid[], item_count integer, sample_invoice_id uuid, sample_invoice_number text, sample_issue_date date, client_tax_id text, currency text, has_template boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
BEGIN
  RETURN QUERY
  WITH invoice_items_sorted AS (
    -- Para cada factura, obtener sus items ordenados por subtotal
    SELECT 
      il.id as invoice_id,
      il.invoice_number,
      il.issue_date,
      il.client_tax_id,
      il.invoice_currency,
      COUNT(iil.id) as item_count,
      -- Montos ordenados de menor a mayor (para comparar independiente del orden)
      -- Cast explícito a NUMERIC para evitar problemas de tipo en UNNEST
      ARRAY_AGG(COALESCE(iil.subtotal, 0)::NUMERIC ORDER BY COALESCE(iil.subtotal, 0)) as sorted_amounts,
      EXISTS(
        SELECT 1 FROM public.invoice_items_legacy_match m
        WHERE m.invoice_item_legacy_id IN (
          SELECT id FROM public.invoice_items_legacy 
          WHERE invoices_legacy_id = il.id
        )
      ) as has_reconciliation
    FROM public.invoices_legacy il
    INNER JOIN public.invoice_items_legacy iil ON iil.invoices_legacy_id = il.id
    WHERE il.id = ANY(p_invoice_ids)
      AND il.holding_id = p_holding_id
      AND il.reconciliation_status != 'migrated'
    GROUP BY il.id, il.invoice_number, il.issue_date, il.client_tax_id, il.invoice_currency
  ),
  -- Agrupar facturas candidatas por client + item_count + currency
  candidate_groups AS (
    SELECT 
      iis.client_tax_id,
      iis.invoice_currency,
      iis.item_count,
      ARRAY_AGG(iis.invoice_id ORDER BY iis.issue_date) as all_invoice_ids,
      ARRAY_AGG(iis.sorted_amounts ORDER BY iis.issue_date) as all_sorted_amounts,
      ARRAY_AGG(iis.invoice_number ORDER BY iis.issue_date) as all_invoice_numbers,
      ARRAY_AGG(iis.issue_date ORDER BY iis.issue_date) as all_issue_dates,
      ARRAY_AGG(iis.has_reconciliation ORDER BY iis.issue_date) as all_has_reconciliation
    FROM invoice_items_sorted iis
    GROUP BY iis.client_tax_id, iis.invoice_currency, iis.item_count
    HAVING COUNT(*) > 1  -- Solo grupos con más de 1 factura
  ),
  -- Comparar montos dentro de cada grupo para detectar similitud
  similar_groups AS (
    SELECT 
      cg.client_tax_id,
      cg.invoice_currency,
      cg.item_count,
      cg.all_invoice_ids,
      cg.all_sorted_amounts,
      cg.all_invoice_numbers,
      cg.all_issue_dates,
      cg.all_has_reconciliation,
      -- Generar un hash único para este grupo basado en montos promedio
      MD5(
        cg.client_tax_id || '|' || 
        cg.invoice_currency || '|' || 
        cg.item_count::text || '|' ||
        -- Usar promedio de montos como referencia (con protección NULL)
        COALESCE(
          (
            SELECT STRING_AGG(ROUND(avg_amt)::text, '|' ORDER BY avg_amt)
            FROM (
              SELECT AVG(amt) as avg_amt
              FROM UNNEST(cg.all_sorted_amounts[1]) as amt
            ) avg_calc
            WHERE avg_amt IS NOT NULL
          ),
          'empty'
        )
      ) as group_hash
    FROM candidate_groups cg
    WHERE (
      -- Verificar que los montos son similares entre todas las facturas del grupo
      -- Comparar cada factura (desde la 2da) con la primera del grupo
      SELECT BOOL_AND(
        -- Para cada posición de item, verificar que el monto está dentro del rango
        (
          SELECT BOOL_AND(
            -- Tolerancia: ±15% respecto al monto de referencia (primera factura)
            -- Protección contra división por cero: si ref_amt = 0, ambos deben ser 0
            CASE 
              WHEN ref_amt = 0 THEN compare_amt = 0
              ELSE ABS(compare_amt - ref_amt) <= (ref_amt * 0.15)
            END
          )
          FROM UNNEST(cg.all_sorted_amounts[1]) WITH ORDINALITY AS ref(ref_amt, pos)
          INNER JOIN UNNEST(amounts) WITH ORDINALITY AS comp(compare_amt, comp_pos) 
            ON ref.pos = comp.comp_pos
        )
      )
      -- Iterar desde índice 2 en adelante (saltar el primero que es la referencia)
      FROM UNNEST(cg.all_sorted_amounts[2:array_length(cg.all_sorted_amounts, 1)]) as amounts
    )
  )
  -- Retornar grupos similares detectados
  SELECT 
    sg.group_hash as fingerprint_hash,
    sg.all_invoice_ids as invoice_ids,
    sg.item_count,
    -- Sample: preferir factura con reconciliación, sino la más antigua
    (
      SELECT sg.all_invoice_ids[idx]
      FROM UNNEST(sg.all_has_reconciliation) WITH ORDINALITY AS h(has_rec, idx)
      ORDER BY h.has_rec DESC, sg.all_issue_dates[idx]
      LIMIT 1
    ) as sample_invoice_id,
    (
      SELECT sg.all_invoice_numbers[idx]
      FROM UNNEST(sg.all_has_reconciliation) WITH ORDINALITY AS h(has_rec, idx)
      ORDER BY h.has_rec DESC, sg.all_issue_dates[idx]
      LIMIT 1
    ) as sample_invoice_number,
    (
      SELECT sg.all_issue_dates[idx]
      FROM UNNEST(sg.all_has_reconciliation) WITH ORDINALITY AS h(has_rec, idx)
      ORDER BY h.has_rec DESC, sg.all_issue_dates[idx]
      LIMIT 1
    ) as sample_issue_date,
    sg.client_tax_id,
    sg.invoice_currency as currency,
    (
      SELECT BOOL_OR(h)
      FROM UNNEST(sg.all_has_reconciliation) as h
    ) as has_template
  FROM similar_groups sg
  ORDER BY ARRAY_LENGTH(sg.all_invoice_ids, 1) DESC;
END;
$function$

