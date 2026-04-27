CREATE OR REPLACE FUNCTION public.auto_calculate_pricing_fields()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_prices RECORD;
  v_frequency_multiplier INTEGER;
BEGIN
  IF NEW.price_entry_mode = 'annual' AND NEW.annual_unit_price IS NOT NULL THEN
    NEW.unit_price := ROUND(NEW.annual_unit_price / 12.0, 6);
    NEW.annual_price := ROUND(NEW.annual_unit_price * COALESCE(NEW.quantity, 1), 2);
  ELSE
    IF NEW.unit_price IS NOT NULL THEN
      NEW.annual_unit_price := ROUND(NEW.unit_price * 12.0, 6);
      NEW.annual_price := ROUND(NEW.annual_unit_price * COALESCE(NEW.quantity, 1), 2);
    END IF;
    IF NEW.price_entry_mode IS NULL THEN
      NEW.price_entry_mode := 'monthly';
    END IF;
  END IF;

  IF COALESCE(NEW.categoria, '') IN ('CHURN', 'DOWNSELL')
     AND COALESCE(NEW.term_months, 0) > 0
     AND NEW.final_price IS NOT NULL
  THEN
    NEW.monthly_price := ROUND(NEW.final_price / NEW.term_months, 2);
    CASE LOWER(COALESCE(NEW.billing_frequency, 'mensual'))
      WHEN 'mensual' THEN v_frequency_multiplier := 1;
      WHEN 'trimestral' THEN v_frequency_multiplier := 3;
      WHEN 'semestral' THEN v_frequency_multiplier := 6;
      WHEN 'anual' THEN v_frequency_multiplier := 12;
      WHEN 'bianual' THEN v_frequency_multiplier := 24;
      ELSE v_frequency_multiplier := 1;
    END CASE;
    NEW.billing_period_price := ROUND(NEW.monthly_price * v_frequency_multiplier, 2);
  ELSE
    SELECT * INTO v_prices
    FROM public.calculate_monthly_and_period_prices(
      NEW.unit_price, NEW.quantity, NEW.billing_frequency, NEW.is_recurring,
      NEW.final_price, NEW.term_months, NEW.discount_type, NEW.discount_value
    );
    NEW.monthly_price := v_prices.monthly_price;
    NEW.billing_period_price := v_prices.billing_period_price;

    IF NEW.price_entry_mode = 'annual' AND NEW.annual_price IS NOT NULL AND COALESCE(NEW.is_recurring, false) THEN
      CASE LOWER(COALESCE(NEW.billing_frequency, 'mensual'))
        WHEN 'mensual' THEN v_frequency_multiplier := 1;
        WHEN 'trimestral' THEN v_frequency_multiplier := 3;
        WHEN 'semestral' THEN v_frequency_multiplier := 6;
        WHEN 'anual' THEN v_frequency_multiplier := 12;
        WHEN 'bianual' THEN v_frequency_multiplier := 24;
        ELSE v_frequency_multiplier := 1;
      END CASE;
      NEW.billing_period_price := ROUND(NEW.annual_price * v_frequency_multiplier / 12.0, 2);
    END IF;
  END IF;

  RETURN NEW;
END;
$function$

