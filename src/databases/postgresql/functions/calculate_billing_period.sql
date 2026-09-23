CREATE OR REPLACE FUNCTION public.calculate_billing_period(p_item_start_date date, p_period_index integer, p_frequency_months integer, p_billing_method text)
 RETURNS TABLE(period_start date, period_end date, scheduled_date date)
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_period_start DATE;
  v_period_end DATE;
  v_scheduled_date DATE;
BEGIN
  -- Calcular inicio del periodo
  v_period_start := p_item_start_date + (p_period_index * p_frequency_months || ' months')::INTERVAL;
  
  -- Calcular fin del periodo (un día antes del siguiente periodo)
  v_period_end := p_item_start_date + ((p_period_index + 1) * p_frequency_months || ' months')::INTERVAL - INTERVAL '1 day';
  
  -- Calcular fecha de emisión según método de facturación
  IF LOWER(p_billing_method) LIKE '%vencid%' OR LOWER(p_billing_method) LIKE '%arrear%' THEN
    -- Vencido: facturar un periodo después del inicio
    v_scheduled_date := p_item_start_date + ((p_period_index + 1) * p_frequency_months || ' months')::INTERVAL;
  ELSE
    -- Anticipado: facturar al inicio del periodo
    v_scheduled_date := v_period_start;
  END IF;
  
  RETURN QUERY SELECT v_period_start, v_period_end, v_scheduled_date;
END;
$function$;

COMMENT ON FUNCTION public."calculate_billing_period"(p_item_start_date date, p_period_index integer, p_frequency_months integer, p_billing_method text) IS 'Calcula el periodo de facturación y la fecha de emisión según el método de facturación (Anticipado/Vencido).';
