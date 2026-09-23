CREATE OR REPLACE FUNCTION public.generate_missing_invoices_for_contract(p_contract_id uuid)
 RETURNS TABLE(success boolean, message text, generated_count integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_contract_record RECORD;
    v_holding_id uuid;
    v_invoice_count integer := 0;
    v_scheduled_invoice RECORD;
    v_new_invoice_id uuid;
    v_item JSONB;
    v_subtotal numeric := 0;
    v_tax_amount numeric := 0;
    v_total numeric := 0;
    v_company_tax_rate numeric;
    v_item_subtotal numeric;
    v_item_tax numeric;
    v_item_total numeric;
    v_contract_item_id uuid;
    v_contract_item RECORD;
    v_product_id uuid;
    v_unit_of_measure text;
    v_quantity numeric;
    v_unit_price numeric;
    v_existing_invoices_count integer := 0;
    v_bp_start date;
    v_bp_end date;
    v_ci_freq_months int;
    v_item_description text;
    v_discount_pct numeric := 0;   -- FIX descuento: descuento efectivo del ítem (antes hardcodeado en 0)
    v_billing_method text;         -- FIX billing_period: método de facturación del ítem
BEGIN
    SELECT c.*, comp.tax_rate, comp.holding_id
    INTO v_contract_record
    FROM contracts c
    JOIN companies comp ON c.company_id = comp.id
    WHERE c.id = p_contract_id;
    IF NOT FOUND THEN
        RETURN QUERY SELECT false, 'Contract not found', 0;
        RETURN;
    END IF;
    v_holding_id := v_contract_record.holding_id;
    v_company_tax_rate := v_contract_record.tax_rate;
    IF v_company_tax_rate IS NULL THEN
        RAISE EXCEPTION 'TAX_RATE_NOT_CONFIGURED: La empresa % no tiene configurada una tasa de impuesto (tax_rate). Configure el impuesto en la empresa antes de generar facturas.', v_contract_record.company_id
            USING ERRCODE = 'P0001';
    END IF;
    IF v_contract_record.status != 'Activo' THEN
        RETURN QUERY SELECT false, 'Contract must be in Activo status', 0;
        RETURN;
    END IF;
    SELECT COUNT(*) INTO v_existing_invoices_count
    FROM invoices
    WHERE contract_id = p_contract_id
      AND COALESCE(is_legacy, false) = false;
    IF v_existing_invoices_count > 0 THEN
        RETURN QUERY SELECT false, 'Real invoices already exist (non-legacy)', 0;
        RETURN;
    END IF;
    FOR v_scheduled_invoice IN
        SELECT * FROM contract_invoices
        WHERE contract_id = p_contract_id
        AND status = 'Programada'
        AND COALESCE(is_satisfied, false) = false
        ORDER BY invoice_date
    LOOP
        v_subtotal := v_scheduled_invoice.amount;
        v_tax_amount := ROUND(v_subtotal * (v_company_tax_rate / 100), 2);
        v_total := v_subtotal + v_tax_amount;
        INSERT INTO invoices (
            company_id, client_id, client_entity_id, contract_id,
            scheduled_at, original_issue_date, issue_date, due_date,
            vat, amount_contract_currency, amount_invoice_currency, amount_system_currency,
            total_invoice_currency, total_system_currency,
            contract_currency, invoice_currency, fx_contract_to_invoice,
            status, invoice_type, document_type, export_type, invoice_series,
            holding_id, issuer_legal_name, issuer_tax_id, issuer_address, client_tax_id,
            requires_references_for_billing, auto_invoice
        ) VALUES (
            v_contract_record.company_id, v_contract_record.client_id, v_contract_record.client_entity_id, p_contract_id,
            v_scheduled_invoice.invoice_date, v_scheduled_invoice.invoice_date, v_scheduled_invoice.invoice_date,
            v_scheduled_invoice.invoice_date + INTERVAL '30 days',
            v_tax_amount, v_scheduled_invoice.amount,
            CASE WHEN COALESCE(NULLIF(v_contract_record.invoice_currency, ''), v_scheduled_invoice.currency) <> v_scheduled_invoice.currency THEN NULL ELSE v_scheduled_invoice.amount END,
            v_scheduled_invoice.amount,
            CASE WHEN COALESCE(NULLIF(v_contract_record.invoice_currency, ''), v_scheduled_invoice.currency) <> v_scheduled_invoice.currency THEN NULL ELSE v_total END,
            v_total,
            v_scheduled_invoice.currency,
            COALESCE(NULLIF(v_contract_record.invoice_currency, ''), v_scheduled_invoice.currency),
            CASE WHEN COALESCE(NULLIF(v_contract_record.invoice_currency, ''), v_scheduled_invoice.currency) <> v_scheduled_invoice.currency THEN NULL ELSE 1.0 END,
            'Por Emitir', 'Automatica', 'FACTURA', 0, 'FAC',
            v_holding_id,
            (SELECT legal_name FROM companies WHERE id = v_contract_record.company_id),
            (SELECT tax_id FROM companies WHERE id = v_contract_record.company_id),
            (SELECT legal_address FROM companies WHERE id = v_contract_record.company_id),
            (SELECT ce.tax_id FROM client_entities ce WHERE ce.id = v_contract_record.client_entity_id),
            COALESCE(v_contract_record.requires_references_for_billing, false),
            COALESCE(v_contract_record.auto_invoice, false)
        ) RETURNING id INTO v_new_invoice_id;
        IF v_scheduled_invoice.contract_item_details IS NOT NULL THEN
            FOR v_item IN SELECT * FROM jsonb_array_elements(v_scheduled_invoice.contract_item_details)
            LOOP
                v_contract_item_id := NULLIF((v_item->>'contract_item_id'), '')::uuid;
                v_item_subtotal := COALESCE((v_item->>'amount')::numeric, 0);
                v_item_tax := ROUND(v_item_subtotal * (v_company_tax_rate / 100), 2);
                v_item_total := v_item_subtotal + v_item_tax;
                v_product_id := NULL;
                v_unit_of_measure := 'UND';
                v_quantity := 1;
                v_unit_price := v_item_subtotal;
                v_discount_pct := 0;        -- FIX descuento: reset por ítem
                v_billing_method := NULL;   -- FIX billing_period: reset por ítem
                v_bp_start := NULL;
                v_bp_end := NULL;
                v_item_description := COALESCE(v_item->>'product_name', 'Product/Service') || COALESCE((SELECT ' Cuenta ' || TRIM(ci2.account) FROM public.contract_items ci2 WHERE ci2.id = NULLIF((v_item->>'contract_item_id'), '')::uuid AND NULLIF(TRIM(ci2.account), '') IS NOT NULL), '');
                IF v_contract_item_id IS NOT NULL THEN
                    SELECT
                        product_id,
                        COALESCE(quantity, 1) as quantity,
                        COALESCE(unit_of_measure, 'UND') as unit_of_measure,
                        COALESCE(unit_price, 0) as unit_price,
                        price as price,
                        final_price as final_price
                    INTO v_contract_item
                    FROM contract_items
                    WHERE id = v_contract_item_id;
                    IF FOUND THEN
                        v_product_id := v_contract_item.product_id;
                        v_quantity := v_contract_item.quantity;
                        v_unit_of_measure := v_contract_item.unit_of_measure;
                        v_unit_price := v_contract_item.unit_price;
                        -- FIX descuento: descuento efectivo del ítem (Porcentaje o Monto fijo). El
                        -- trigger standardize_invoice_items usa este discount_pct para recalcular el
                        -- subtotal CON descuento (antes recibía 0 y perdía el descuento).
                        IF COALESCE(v_contract_item.price, 0) > 0 THEN
                            v_discount_pct := ROUND((1 - COALESCE(v_contract_item.final_price, v_contract_item.price) / v_contract_item.price) * 100, 4);
                        END IF;
                    END IF;
                    -- Frecuencia (meses por período) y método de facturación del ítem
                    SELECT
                        CASE
                            WHEN lower(ci.billing_frequency) LIKE '%trimest%' OR lower(ci.billing_frequency) LIKE '%quarter%' THEN 3
                            WHEN lower(ci.billing_frequency) LIKE '%semest%' OR lower(ci.billing_frequency) LIKE '%half%' THEN 6
                            WHEN lower(ci.billing_frequency) LIKE '%anual%' OR lower(ci.billing_frequency) LIKE '%year%' THEN 12
                            ELSE 1
                        END,
                        ci.billing_method
                    INTO v_ci_freq_months, v_billing_method
                    FROM contract_items ci WHERE ci.id = v_contract_item_id;

                    -- FIX billing_period según método de facturación. Respeta el override del JSON si
                    -- viniera; si no, lo calcula:
                    --   Anticipado: factura al INICIO del período -> [fecha, fecha + freq - 1]
                    --   Vencido:    factura al FIN del período     -> [fecha - freq, fecha - 1]
                    v_bp_start := (v_item->>'billing_period_start')::date;
                    v_bp_end := (v_item->>'billing_period_end')::date;
                    IF v_bp_start IS NULL OR v_bp_end IS NULL THEN
                        IF LOWER(COALESCE(v_billing_method, 'anticipado')) LIKE '%vencid%'
                           OR LOWER(COALESCE(v_billing_method, '')) LIKE '%arrear%' THEN
                            v_bp_end   := (v_scheduled_invoice.invoice_date - INTERVAL '1 day')::date;
                            v_bp_start := (v_scheduled_invoice.invoice_date - (v_ci_freq_months || ' month')::INTERVAL)::date;
                        ELSE
                            v_bp_start := v_scheduled_invoice.invoice_date;
                            v_bp_end   := (v_scheduled_invoice.invoice_date + (v_ci_freq_months || ' month')::INTERVAL - INTERVAL '1 day')::date;
                        END IF;
                    END IF;
                    v_item_description := v_item_description || ' - Periodo '
                        || TO_CHAR(v_bp_start, 'DD/MM/YYYY') || ' a '
                        || TO_CHAR(v_bp_end, 'DD/MM/YYYY');
                END IF;
                INSERT INTO invoice_items (
                    invoice_id, contract_item_id, description,
                    quantity, unit_of_measure,
                    unit_price_contract_currency, unit_price_invoice_currency,
                    discount_pct,
                    subtotal_contract_currency, subtotal_invoice_currency,
                    tax_amount_contract_currency, tax_amount_invoice_currency,
                    total_contract_currency, total_invoice_currency,
                    holding_id, contract_id, product_id,
                    contract_currency, invoice_currency, fx_contract_to_invoice,
                    fx_rate_source, fx_rate_date, status, issue_date,
                    billing_period_start, billing_period_end
                ) VALUES (
                    v_new_invoice_id, v_contract_item_id,
                    v_item_description,
                    v_quantity, v_unit_of_measure,
                    v_unit_price, CASE WHEN COALESCE(NULLIF(v_contract_record.invoice_currency, ''), v_scheduled_invoice.currency) <> v_scheduled_invoice.currency THEN NULL ELSE v_unit_price END,
                    v_discount_pct,
                    v_item_subtotal, CASE WHEN COALESCE(NULLIF(v_contract_record.invoice_currency, ''), v_scheduled_invoice.currency) <> v_scheduled_invoice.currency THEN NULL ELSE v_item_subtotal END,
                    v_item_tax, CASE WHEN COALESCE(NULLIF(v_contract_record.invoice_currency, ''), v_scheduled_invoice.currency) <> v_scheduled_invoice.currency THEN NULL ELSE v_item_tax END,
                    v_item_total, CASE WHEN COALESCE(NULLIF(v_contract_record.invoice_currency, ''), v_scheduled_invoice.currency) <> v_scheduled_invoice.currency THEN NULL ELSE v_item_total END,
                    v_holding_id, p_contract_id, v_product_id,
                    v_scheduled_invoice.currency,
                    COALESCE(NULLIF(v_contract_record.invoice_currency, ''), v_scheduled_invoice.currency),
                    CASE WHEN COALESCE(NULLIF(v_contract_record.invoice_currency, ''), v_scheduled_invoice.currency) <> v_scheduled_invoice.currency THEN NULL ELSE 1 END,
                    'scheduled-generation', v_scheduled_invoice.invoice_date,
                    'Por Emitir', v_scheduled_invoice.invoice_date,
                    v_bp_start, v_bp_end
                );
            END LOOP;
        ELSE
            v_bp_start := v_scheduled_invoice.invoice_date;
            v_bp_end := (v_scheduled_invoice.invoice_date + interval '1 month' - interval '1 day')::date;
            INSERT INTO invoice_items (
                invoice_id, description, quantity, unit_of_measure,
                unit_price_contract_currency, unit_price_invoice_currency, discount_pct,
                subtotal_contract_currency, subtotal_invoice_currency,
                tax_amount_contract_currency, tax_amount_invoice_currency,
                total_contract_currency, total_invoice_currency,
                holding_id, contract_id,
                contract_currency, invoice_currency, fx_contract_to_invoice,
                fx_rate_source, fx_rate_date, status, issue_date,
                billing_period_start, billing_period_end
            ) VALUES (
                v_new_invoice_id,
                'Services as per contract - Periodo '
                    || TO_CHAR(v_bp_start, 'DD/MM/YYYY') || ' a '
                    || TO_CHAR(v_bp_end, 'DD/MM/YYYY'),
                1, 'UND',
                v_subtotal, v_subtotal, 0,
                v_subtotal, v_subtotal,
                v_tax_amount, v_tax_amount,
                v_total, v_total,
                v_holding_id, p_contract_id,
                v_scheduled_invoice.currency, v_scheduled_invoice.currency, 1,
                'scheduled-generation', v_scheduled_invoice.invoice_date,
                'Por Emitir', v_scheduled_invoice.invoice_date,
                v_bp_start, v_bp_end
            );
        END IF;
        IF COALESCE(NULLIF(v_contract_record.invoice_currency, ''), v_scheduled_invoice.currency) <> v_scheduled_invoice.currency THEN
            UPDATE invoice_items SET
                unit_price_invoice_currency = NULL,
                subtotal_invoice_currency = NULL,
                tax_amount_invoice_currency = NULL,
                total_invoice_currency = NULL,
                fx_contract_to_invoice = NULL,
                invoice_currency = COALESCE(NULLIF(v_contract_record.invoice_currency, ''), invoice_currency)
            WHERE invoice_id = v_new_invoice_id;
        END IF;
        v_invoice_count := v_invoice_count + 1;
    END LOOP;
    IF v_invoice_count > 0 THEN
        RETURN QUERY SELECT true, 'Generated ' || v_invoice_count || ' invoices', v_invoice_count;
    ELSE
        RETURN QUERY SELECT false, 'No scheduled invoices found (or all satisfied)', 0;
    END IF;
EXCEPTION WHEN OTHERS THEN
    RETURN QUERY SELECT false, 'Error: ' || SQLERRM, 0;
END;
$function$;

COMMENT ON FUNCTION public."generate_missing_invoices_for_contract"(p_contract_id uuid) IS 'Genera facturas reales desde contract_invoices programadas.
ACTUALIZADO 2026-02-05:
- Ignora facturas legacy al validar si ya existen invoices (COALESCE(is_legacy, false) = false)
- Solo genera facturas para contract_invoices con is_satisfied = false (COALESCE(is_satisfied, false) = false)
- Esto permite que contratos legacy reconciliados generen solo las facturas pendientes';
