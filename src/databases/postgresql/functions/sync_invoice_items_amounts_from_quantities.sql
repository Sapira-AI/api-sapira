CREATE OR REPLACE FUNCTION public.sync_invoice_items_amounts_from_quantities()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_item         RECORD;
  v_unit_price   NUMERIC;
  v_quantity     NUMERIC;
  v_tax_rate     NUMERIC;
  v_subtotal_cc  NUMERIC;
  v_tax_cc       NUMERIC;
  v_total_cc     NUMERIC;
  v_fx           NUMERIC;
  v_ci_unit_price NUMERIC;
  v_ci_quantity   NUMERIC;
BEGIN
  IF NEW.contract_item_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.unit_price IS NULL AND NEW.quantity IS NULL AND NEW.amount IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.unit_price IS NOT NULL AND NEW.quantity IS NOT NULL THEN
    v_unit_price := NEW.unit_price;
    v_quantity   := NEW.quantity;
  ELSIF NEW.amount IS NOT NULL AND NEW.unit_price IS NULL AND NEW.quantity IS NULL THEN
    v_unit_price := NEW.amount;
    v_quantity   := 1;
  ELSIF NEW.quantity IS NOT NULL AND NEW.unit_price IS NULL THEN
    SELECT unit_price INTO v_ci_unit_price
    FROM public.contract_items WHERE id = NEW.contract_item_id;
    IF v_ci_unit_price IS NULL THEN
      RETURN NEW;
    END IF;
    v_unit_price := v_ci_unit_price;
    v_quantity   := NEW.quantity;
  ELSIF NEW.unit_price IS NOT NULL AND NEW.quantity IS NULL THEN
    SELECT quantity INTO v_ci_quantity
    FROM public.contract_items WHERE id = NEW.contract_item_id;
    IF v_ci_quantity IS NULL THEN
      RETURN NEW;
    END IF;
    v_unit_price := NEW.unit_price;
    v_quantity   := v_ci_quantity;
  ELSE
    RETURN NEW;
  END IF;

  FOR v_item IN
    SELECT
      ii.id,
      ii.invoice_id,
      ii.discount_pct,
      ii.fx_contract_to_invoice AS item_fx,
      i.fx_contract_to_invoice  AS header_fx,
      i.tax_rate
    FROM public.invoice_items ii
    JOIN public.invoices i ON i.id = ii.invoice_id
    WHERE ii.contract_item_id = NEW.contract_item_id
      AND i.status = 'Por Emitir'
      AND i.is_active = true
      AND ii.billing_period_start IS NOT NULL
      AND NEW.period = date_trunc('month', ii.billing_period_start)::date
  LOOP
    BEGIN
      v_tax_rate := CASE
        WHEN v_item.tax_rate IS NULL THEN 0
        WHEN v_item.tax_rate > 1    THEN v_item.tax_rate / 100.0
        ELSE v_item.tax_rate
      END;

      v_fx := COALESCE(v_item.item_fx, v_item.header_fx);

      v_subtotal_cc := v_unit_price * v_quantity
                       * (1 - COALESCE(v_item.discount_pct, 0) / 100.0);
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
      RAISE WARNING 'sync_invoice_items_amounts_from_quantities: error procesando invoice_item % (invoice %): %',
        v_item.id, v_item.invoice_id, SQLERRM;
    END;
  END LOOP;

  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public."sync_invoice_items_amounts_from_quantities"() IS 'Trigger AFTER INSERT OR UPDATE en quantities.
Actualiza invoice_items de la factura ACTIVA "Por Emitir" cuyo billing_period_start
está en el mismo mes calendario que NEW.period.
Recalcula subtotal, tax_amount y total en moneda contrato.
Si la factura tiene FX (item o header), recalcula en moneda factura
con convención invoice = contract × fx. Si no hay FX, deja invoice_currency en NULL.
Hereda unit_price o quantity desde contract_items cuando el override solo trae uno.
PRESERVA caso "solo amount" (cant=1, precio=amount).

FIX 2026-02-27: cambiada condición ii.status (siempre NULL) por i.status.
FIX 2026-04-28: eliminado updated_at = now() del UPDATE a invoices.
FIX 2026-06-14: heredar campos del contract_item; FX cascada item→header→NULL;
                convención FX multiplicativa.
FIX 2026-06-14: guard del FOR LOOP usa date_trunc(month, bp_start).
FIX 2026-06-14: agregado filtro is_active = true para no afectar facturas
                inactivas (consolidadas/reestructuradas).';
