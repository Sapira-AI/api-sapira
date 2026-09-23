CREATE OR REPLACE FUNCTION public.standardize_invoice_items()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
    v_contract_item RECORD;
    v_frequency_months INTEGER;
    v_monthly_price NUMERIC;
    v_invoice_vat NUMERIC;
    v_invoice_total NUMERIC;
    v_final_quantity NUMERIC;
    v_final_unit_of_measure TEXT;
    v_final_unit_price NUMERIC;
BEGIN
    -- Only process if we have a contract_item_id reference
    IF NEW.contract_item_id IS NOT NULL THEN
        -- Get contract item details
        SELECT
            ci.billing_frequency,
            ci.final_price,
            ci.term_months,
            ci.quantity,
            ci.unit_of_measure,
            ci.unit_price,
            ci.billing_period_price
        INTO v_contract_item
        FROM contract_items ci
        WHERE ci.id = NEW.contract_item_id;

        IF FOUND THEN
            -- Calcular meses por período de facturación (fallback = 1 mensual)
            v_frequency_months := COALESCE(NULLIF(get_frequency_months(v_contract_item.billing_frequency), 0), 1);

            -- Precio mensual prorrateado (usado en fallback PERIODOS)
            IF COALESCE(v_contract_item.term_months, 0) > 0 THEN
                v_monthly_price := v_contract_item.final_price / v_contract_item.term_months;
            ELSE
                v_monthly_price := COALESCE(v_contract_item.final_price, 0);
            END IF;

            -- ─── Determinar valores finales ───────────────────────────────────
            -- Si el item tiene quantity Y unit_price reales: usar unidades reales.
            --   quantity = qty_real del contrato (sin multiplicar por meses)
            --   unit_price = unit_price real × meses del período (precio del período)
            --   unit_of_measure = el del contrato
            -- La descripción del item ya indica el rango del período facturado.
            -- Si no (items legacy sin campos reales): fallback PERIODOS original.
            --   quantity = meses_período
            --   unit_price = precio_mensual
            --   unit_of_measure = 'PERIODOS'

            IF NULLIF(v_contract_item.quantity, 0) IS NOT NULL
               AND NULLIF(v_contract_item.unit_price, 0) IS NOT NULL
            THEN
                -- Lógica de unidades reales: quantity preservada, unit_price expandido al período
                v_final_quantity        := v_contract_item.quantity;
                v_final_unit_price      := v_contract_item.unit_price * v_frequency_months;
                v_final_unit_of_measure := COALESCE(NULLIF(v_contract_item.unit_of_measure, ''), 'UND');
            ELSE
                -- Fallback PERIODOS (igual que antes)
                v_final_quantity        := v_frequency_months;
                v_final_unit_price      := v_monthly_price;
                v_final_unit_of_measure := COALESCE(NULLIF(v_contract_item.unit_of_measure, ''), 'PERIODOS');
            END IF;

            -- Set standardized values
            NEW.quantity                   := v_final_quantity;
            NEW.unit_of_measure            := v_final_unit_of_measure;
            NEW.unit_price_contract_currency := v_final_unit_price;
            NEW.unit_price_invoice_currency  := v_final_unit_price;

            -- Recalcular subtotal
            NEW.subtotal_contract_currency := NEW.quantity * NEW.unit_price_contract_currency
                                              * (1 - COALESCE(NEW.discount_pct, 0) / 100);
            NEW.subtotal_invoice_currency  := NEW.subtotal_contract_currency;

            -- Calcular VAT desde la invoice si no se proporciona
            IF NEW.tax_amount_contract_currency IS NULL OR NEW.tax_amount_contract_currency = 0 THEN
                SELECT i.vat, i.total_invoice_currency
                INTO v_invoice_vat, v_invoice_total
                FROM invoices i
                WHERE i.id = NEW.invoice_id;

                IF FOUND AND v_invoice_vat > 0 AND v_invoice_total > 0 THEN
                    NEW.tax_amount_contract_currency := NEW.subtotal_contract_currency
                        * (v_invoice_vat / NULLIF(v_invoice_total - v_invoice_vat, 0));
                ELSE
                    NEW.tax_amount_contract_currency := 0;
                END IF;
            END IF;

            NEW.tax_amount_invoice_currency := NEW.tax_amount_contract_currency;
            NEW.total_contract_currency     := NEW.subtotal_contract_currency + NEW.tax_amount_contract_currency;
            NEW.total_invoice_currency      := NEW.total_contract_currency;
        END IF;
    END IF;

    RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public."standardize_invoice_items"() IS 'Trigger que estandariza invoice_items al INSERT usando campos reales de contract_items.
ACTUALIZADO 2026-04-23:
- Preserva quantity real del contrato (sin multiplicar por meses del período).
- unit_price se ajusta al período de facturación: unit_price_contrato × frequency_months.
- El subtotal (quantity × unit_price) queda idéntico al comportamiento anterior.
- La descripción del item incluye el rango de fechas del período, por lo que no se duplica en cantidad.
  Ej mensual: qty=5, unit_price=1.32, subtotal=6.60
  Ej anual:   qty=1, unit_price=15.84, subtotal=15.84
- Fallback PERIODOS (sin unit_price/quantity reales) se mantiene igual para datos legacy.
- Solo actúa si contract_item_id IS NOT NULL en el INSERT
  (reconcile_legacy_invoice inserta sin contract_item_id → no se ve afectado).';
