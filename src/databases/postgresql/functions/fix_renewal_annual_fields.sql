CREATE OR REPLACE FUNCTION public.fix_renewal_annual_fields()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_orig_annual_unit_price NUMERIC;
  v_orig_annual_price NUMERIC;
  v_orig_price_entry_mode TEXT;
  v_frequency_multiplier INTEGER;
BEGIN
  IF NEW.categoria = 'RENEWAL' AND NEW.renews_item_id IS NOT NULL THEN
    SELECT annual_unit_price, annual_price, price_entry_mode
    INTO v_orig_annual_unit_price, v_orig_annual_price, v_orig_price_entry_mode
    FROM public.contract_items
    WHERE id = NEW.renews_item_id;

    NEW.annual_unit_price := v_orig_annual_unit_price;
    NEW.annual_price := v_orig_annual_price;
    NEW.price_entry_mode := v_orig_price_entry_mode;

    IF v_orig_price_entry_mode = 'annual' AND v_orig_annual_unit_price IS NOT NULL THEN
      NEW.unit_price := ROUND(v_orig_annual_unit_price / 12, 6);
      NEW.monthly_price := ROUND(NEW.unit_price * COALESCE(NEW.quantity, 1), 2);

      CASE LOWER(COALESCE(NEW.billing_frequency, 'mensual'))
        WHEN 'mensual' THEN v_frequency_multiplier := 1;
        WHEN 'trimestral' THEN v_frequency_multiplier := 3;
        WHEN 'semestral' THEN v_frequency_multiplier := 6;
        WHEN 'anual' THEN v_frequency_multiplier := 12;
        WHEN 'bianual' THEN v_frequency_multiplier := 24;
        ELSE v_frequency_multiplier := 1;
      END CASE;

      IF v_frequency_multiplier = 12 AND v_orig_annual_price IS NOT NULL THEN
        NEW.billing_period_price := ROUND(v_orig_annual_price, 2);
      ELSE
        NEW.billing_period_price := ROUND(NEW.monthly_price * v_frequency_multiplier, 2);
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$function$

