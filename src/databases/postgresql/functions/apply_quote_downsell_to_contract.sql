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

    v_ds_qty  := (v_spec->>'quantity')::numeric;
    v_new_monthly := NULLIF(v_spec->>'new_monthly','')::numeric;
    v_ds_unit := ABS(COALESCE(NULLIF(v_spec->>'unit_price','')::numeric, v_orig.unit_price, 0));
    -- El downsell se acota SIEMPRE al fin del item original (no extiende su vida);
    -- term y final_price se derivan de [start_efectivo -> fin_acotado].
    v_ds_start := COALESCE(NULLIF(v_spec->>'start_date','')::date, p_effective_date);
    v_ds_end   := LEAST(COALESCE(NULLIF(v_spec->>'end_date','')::date, v_orig.end_date), v_orig.end_date);
    -- term = nº de períodos completos = meses entre start y (fin + 1 día). Usar (fin+1)
    -- en vez de sumar +1 evita el sobreconteo cuando el período arranca a mitad de mes
    -- (día de fin = día de inicio − 1), que dejaba el item extendido 1 mes de más.
    v_ds_term  := GREATEST(1, (
                    (EXTRACT(YEAR FROM (v_ds_end + 1)) - EXTRACT(YEAR FROM v_ds_start)) * 12
                    + EXTRACT(MONTH FROM (v_ds_end + 1)) - EXTRACT(MONTH FROM v_ds_start))::int);
    v_ds_freq := COALESCE(NULLIF(v_spec->>'billing_frequency',''), v_orig.billing_frequency, 'Mensual');
    v_ds_freq_months := COALESCE(NULLIF(public.get_frequency_months(v_ds_freq), 0), 1);

    IF v_new_monthly IS NOT NULL THEN
      -- ===== RAMA PRECIO: misma cantidad, menor precio =====
      -- El spec trae `new_monthly` = nuevo valor mensual TOTAL del item.
      -- El downsell es la diferencia mensual; la cantidad no cambia.
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
      -- Item downsell: cantidad = la del original; unitario = diferencia mensual
      -- por unidad (informativo — el trigger deriva monthly desde final/term).
      v_ds_qty  := COALESCE(v_orig.quantity, 1);
      v_ds_unit := ROUND(v_ds_monthly / NULLIF(v_ds_qty, 0), 6);
    ELSE
      -- ===== RAMA CANTIDAD: quitar unidades manteniendo el precio =====
      IF v_ds_qty IS NULL OR v_ds_qty <= 0 THEN
        RAISE EXCEPTION 'La cantidad del downsell debe ser > 0 (item %)', v_orig.product_name;
      END IF;
      -- FIX 2026-09-04: se permite quitar la cantidad COMPLETA del item (downsell de
      -- item completo: el item queda neteado a 0 desde la fecha efectiva y el contrato
      -- sigue con sus otros items). Solo se bloquea quitar MÁS de lo existente.
      IF v_ds_qty > COALESCE(v_orig.quantity, 0) THEN
        RAISE EXCEPTION 'El downsell quita % unidades pero el item tiene % - no se puede quitar mas de lo existente (item %).',
          v_ds_qty, v_orig.quantity, v_orig.product_name;
      END IF;

      -- FIX P1 (discount-aware): mensual del downsell = mensual real por unidad del
      -- item original × unidades a quitar. Respeta descuentos (monthly_price ya viene
      -- con descuento aplicado). Fallback a unit×qty si faltara monthly_price/quantity.
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
            -- RAMA PRECIO: cantidad intacta; precios unitarios y montos escalados
            -- por el factor de rebaja (nuevo mensual / mensual actual).
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
            -- RAMA CANTIDAD: restar unidades; precio unitario intacto.
            v_net_qty := COALESCE(v_line.quantity, 0) - v_ds_qty;
            IF v_net_qty <= 0 THEN
              -- FIX 2026-09-04: downsell de item completo -> la línea sale de la
              -- factura del período (antes quedaba viva y seguía cobrando).
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
        -- FIX 2026-09-04: si la factura quedó sin líneas (el item era su única línea),
        -- se cancela en vez de quedar Por Emitir en cero.
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
              -- RAMA PRECIO: cantidad intacta; precios unitarios y montos escalados.
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
              -- RAMA CANTIDAD: restar unidades; precio unitario intacto.
              v_net_qty := COALESCE(v_line.quantity, 0) - v_ds_qty;
              IF v_net_qty <= 0 THEN
                -- FIX 2026-09-04: downsell de item completo -> la línea no va en la refactura.
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
          -- FIX 2026-09-04: refactura sin líneas (item era su única línea) -> cancelarla
          -- (la NC ya cubrió la original; no queda nada por refacturar).
          IF NOT EXISTS (SELECT 1 FROM public.invoice_items WHERE invoice_id = v_repl_id) THEN
            UPDATE public.invoices SET status = 'Cancelada' WHERE id = v_repl_id AND status = 'Por Emitir';
          END IF;
        END IF;
      END IF;
    END LOOP;
  END LOOP;

  PERFORM public.log_lifecycle_event(
    p_contract_id, 'DOWNSELL', 'Reducción parcial (downsell)',
    p_effective_date, -v_total_monthly_delta,
    'Items afectados: ' || v_n_items::text
      || '. MRR mensual reducido: ' || v_currency || ' ' || ROUND(v_total_monthly_delta, 2)::text,
    COALESCE(NULLIF(p_reason,''), 'Downsell parcial'),
    jsonb_build_object(
      'timing', 'early',
      'item_ids', to_jsonb(v_affected_orig_ids),
      'downsell_item_ids', to_jsonb(v_ds_item_ids),
      'total_mrr_delta', v_total_monthly_delta,
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
    'currency', v_currency,
    'effective_date', p_effective_date
  );
END;
$function$

