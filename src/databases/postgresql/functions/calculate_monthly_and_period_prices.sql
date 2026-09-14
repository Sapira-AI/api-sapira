CREATE OR REPLACE FUNCTION public.calculate_monthly_and_period_prices(p_unit_price numeric, p_quantity numeric, p_billing_frequency text, p_is_recurring boolean, p_final_price numeric DEFAULT NULL::numeric, p_term_months integer DEFAULT NULL::integer, p_discount_type text DEFAULT NULL::text, p_discount_value numeric DEFAULT NULL::numeric)
 RETURNS TABLE(monthly_price numeric, billing_period_price numeric)
 LANGUAGE plpgsql
 IMMUTABLE
AS $function$
DECLARE
  v_monthly_price NUMERIC;
  v_billing_period_price NUMERIC;
  v_frequency_multiplier INTEGER;
  v_term_months INTEGER;
  v_monthly_equivalent NUMERIC;
  v_base_monthly_price NUMERIC;
BEGIN
  -- Calcular monthly_price
  -- Para items recurrentes: (unit_price × quantity) con descuento aplicado
  IF COALESCE(p_is_recurring, false) THEN
    -- Calcular precio base mensual (unit_price × quantity)
    v_base_monthly_price := COALESCE(p_unit_price, 0) * COALESCE(p_quantity, 1);
    
    -- Aplicar descuento según el tipo
    IF p_discount_value IS NOT NULL AND p_discount_value > 0 AND p_discount_type IS NOT NULL THEN
      IF p_discount_type = 'Porcentaje' THEN
        -- Para descuento porcentual: aplicar % al precio mensual base
        v_monthly_price := v_base_monthly_price * (1 - p_discount_value / 100.0);
      ELSIF p_discount_type = 'Monto fijo' THEN
        -- Para descuento de monto fijo: usar final_price / term_months
        -- final_price ya tiene el descuento aplicado al total del contrato
        IF p_final_price IS NOT NULL AND p_term_months IS NOT NULL AND p_term_months > 0 THEN
          v_monthly_price := p_final_price / p_term_months;
        ELSE
          -- Fallback: aplicar descuento directo (puede no ser correcto)
          v_monthly_price := v_base_monthly_price - p_discount_value;
        END IF;
      ELSE
        v_monthly_price := v_base_monthly_price;
      END IF;
    ELSE
      -- Sin descuento
      v_monthly_price := v_base_monthly_price;
    END IF;
    
    -- Asegurar que el precio no sea negativo y redondear
    v_monthly_price := GREATEST(ROUND(v_monthly_price, 2), 0);
  ELSE
    v_monthly_price := NULL;
  END IF;

  -- Determinar multiplicador de frecuencia de facturación
  CASE LOWER(COALESCE(p_billing_frequency, 'mensual'))
    WHEN 'mensual' THEN v_frequency_multiplier := 1;
    WHEN 'trimestral' THEN v_frequency_multiplier := 3;
    WHEN 'semestral' THEN v_frequency_multiplier := 6;
    WHEN 'anual' THEN v_frequency_multiplier := 12;
    WHEN 'bianual' THEN v_frequency_multiplier := 24;
    ELSE v_frequency_multiplier := 1;
  END CASE;

  -- Calcular billing_period_price
  IF COALESCE(p_is_recurring, false) THEN
    -- Para recurrentes: monthly_price × frequency_multiplier
    v_billing_period_price := ROUND(
      COALESCE(v_monthly_price, 0) * v_frequency_multiplier, 
      2
    );
  ELSE
    -- Para one-time: calcular precio mensual equivalente y multiplicar por frecuencia
    v_term_months := GREATEST(COALESCE(p_term_months, 1), 1);
    v_monthly_equivalent := COALESCE(p_final_price, 0) / v_term_months;
    v_billing_period_price := ROUND(v_monthly_equivalent * v_frequency_multiplier, 2);
  END IF;

  RETURN QUERY SELECT v_monthly_price, v_billing_period_price;
END;
$function$

