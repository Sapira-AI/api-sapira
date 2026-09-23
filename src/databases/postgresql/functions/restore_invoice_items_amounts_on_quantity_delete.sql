CREATE OR REPLACE FUNCTION public.restore_invoice_items_amounts_on_quantity_delete()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_item         RECORD;
  v_unit_price   NUMERIC;
  v_quantity     NUMERIC;
  v_discount_pct NUMERIC;
  v_tax_rate     NUMERIC;
  v_subtotal_cc  NUMERIC;
  v_tax_cc       NUMERIC;
  v_total_cc     NUMERIC;
  v_fx           NUMERIC;
BEGIN
  IF OLD.contract_item_id IS NULL THEN
    RETURN OLD;
  END IF;

  SELECT unit_price, quantity, discount_value
  INTO v_unit_price, v_quantity, v_discount_pct
  FROM public.contract_items
  WHERE id = OLD.contract_item_id;

  IF v_unit_price IS NULL OR v_quantity IS NULL THEN
    RETURN OLD;
  END IF;

  FOR v_item IN
    SELECT
      ii.id,
      ii.invoice_id,
      ii.fx_contract_to_invoice AS item_fx,
      i.fx_contract_to_invoice  AS header_fx,
      i.tax_rate
    FROM public.invoice_items ii
    JOIN public.invoices i ON i.id = ii.invoice_id
    WHERE ii.contract_item_id = OLD.contract_item_id
      AND i.status = 'Por Emitir'
      AND i.is_active = true
      AND ii.billing_period_start IS NOT NULL
      AND OLD.period = date_trunc('month', ii.billing_period_start)::date
  LOOP
    BEGIN
      v_tax_rate := CASE
        WHEN v_item.tax_rate IS NULL THEN 0
        WHEN v_item.tax_rate > 1    THEN v_item.tax_rate / 100.0
        ELSE v_item.tax_rate
      END;

      v_fx := COALESCE(v_item.item_fx, v_item.header_fx);

      v_subtotal_cc := v_unit_price * v_quantity
                       * (1 - COALESCE(v_discount_pct, 0) / 100.0);
      v_tax_cc      := v_subtotal_cc * v_tax_rate;
      v_total_cc    := v_subtotal_cc + v_tax_cc;

      UPDATE public.invoice_items
      SET
        quantity                     = v_quantity,
        unit_price_contract_currency = v_unit_price,
        subtotal_contract_currency   = v_subtotal_cc,
        tax_amount_contract_currency = v_tax_cc,
        total_contract_currency      = v_total_cc,
        unit_price_invoice_currency  = CASE WHEN v_fx IS NULL THEN NULL
                                            ELSE ROUND(v_unit_price  * v_fx, 2) END,
        subtotal_invoice_currency    = CASE WHEN v_fx IS NULL THEN NULL
                                            ELSE ROUND(v_subtotal_cc * v_fx, 2) END,
        tax_amount_invoice_currency  = CASE WHEN v_fx IS NULL THEN NULL
                                            ELSE ROUND(v_tax_cc      * v_fx, 2) END,
        total_invoice_currency       = CASE WHEN v_fx IS NULL THEN NULL
                                            ELSE ROUND(v_total_cc    * v_fx, 2) END,
        updated_at                   = now()
      WHERE id = v_item.id;

      UPDATE public.invoices
      SET
        amount_contract_currency = (
          SELECT COALESCE(SUM(subtotal_contract_currency), 0)
          FROM public.invoice_items
          WHERE invoice_id = v_item.invoice_id
        ),
        amount_invoice_currency = (
          SELECT SUM(subtotal_invoice_currency)
          FROM public.invoice_items
          WHERE invoice_id = v_item.invoice_id
        ),
        vat = (
          SELECT SUM(tax_amount_invoice_currency)
          FROM public.invoice_items
          WHERE invoice_id = v_item.invoice_id
        ),
        total_invoice_currency = (
          SELECT SUM(total_invoice_currency)
          FROM public.invoice_items
          WHERE invoice_id = v_item.invoice_id
        )
      WHERE id = v_item.invoice_id;

    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'restore_invoice_items_amounts_on_quantity_delete: error procesando invoice_item % (invoice %): %',
        v_item.id, v_item.invoice_id, SQLERRM;
    END;
  END LOOP;

  RETURN OLD;
END;
$function$;

COMMENT ON FUNCTION public."restore_invoice_items_amounts_on_quantity_delete"() IS 'Trigger AFTER DELETE en quantities. Cuando se elimina un override,
restaura los valores del invoice_item de la factura ACTIVA "Por Emitir" del mismo
mes calendario, usando unit_price y quantity base del contract_item
(con discount_value, tax_rate y FX cascada item→header).
Solo afecta facturas con is_active=true (inactivas son históricas).
Si el contract_item no tiene unit_price/quantity base (ej. Variable sin
defaults), no hace nada y la factura queda con los valores del último override.
Idéntico match-por-mes que sync_invoice_items_amounts_from_quantities.';
