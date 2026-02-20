
DECLARE
  v_year INT;
  v_month INT;
BEGIN
  v_year := EXTRACT(YEAR FROM NEW.rate_date);
  v_month := EXTRACT(MONTH FROM NEW.rate_date);
  
  -- Recalcular promedio mensual para el mes afectado
  INSERT INTO exchange_rates_monthly_avg (
    from_currency, to_currency, year, month,
    avg_rate, min_rate, max_rate, data_points
  )
  SELECT 
    from_currency, to_currency,
    v_year, v_month,
    AVG(rate) as avg_rate,
    MIN(rate) as min_rate,
    MAX(rate) as max_rate,
    COUNT(*) as data_points
  FROM exchange_rates
  WHERE EXTRACT(YEAR FROM rate_date) = v_year
    AND EXTRACT(MONTH FROM rate_date) = v_month
    AND from_currency = NEW.from_currency
    AND to_currency = NEW.to_currency
  GROUP BY from_currency, to_currency
  ON CONFLICT (from_currency, to_currency, year, month)
  DO UPDATE SET
    avg_rate = EXCLUDED.avg_rate,
    min_rate = EXCLUDED.min_rate,
    max_rate = EXCLUDED.max_rate,
    data_points = EXCLUDED.data_points,
    calculated_at = NOW();
    
  RETURN NEW;
END;
