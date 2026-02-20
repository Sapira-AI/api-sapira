
BEGIN
  INSERT INTO exchange_rates_monthly_avg (
    from_currency, to_currency, year, month, 
    avg_rate, min_rate, max_rate, data_points
  )
  SELECT 
    from_currency,
    to_currency,
    EXTRACT(YEAR FROM rate_date)::INTEGER,
    EXTRACT(MONTH FROM rate_date)::INTEGER,
    AVG(rate),
    MIN(rate),
    MAX(rate),
    COUNT(*)
  FROM exchange_rates
  WHERE from_currency = NEW.from_currency
    AND to_currency = NEW.to_currency
    AND EXTRACT(YEAR FROM rate_date) = EXTRACT(YEAR FROM NEW.rate_date)
    AND EXTRACT(MONTH FROM rate_date) = EXTRACT(MONTH FROM NEW.rate_date)
  GROUP BY from_currency, to_currency, 
    EXTRACT(YEAR FROM rate_date), EXTRACT(MONTH FROM rate_date)
  ON CONFLICT (from_currency, to_currency, year, month) 
  DO UPDATE SET
    avg_rate = EXCLUDED.avg_rate,
    min_rate = EXCLUDED.min_rate,
    max_rate = EXCLUDED.max_rate,
    data_points = EXCLUDED.data_points,
    calculated_at = now();
  
  RETURN NEW;
END;
