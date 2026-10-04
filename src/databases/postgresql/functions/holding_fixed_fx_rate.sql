CREATE OR REPLACE FUNCTION public.holding_fixed_fx_rate(p_holding_id uuid, p_from text, p_to text, p_date date)
 RETURNS TABLE(rate numeric, is_inverse boolean, period_start date, period_end date, projected boolean)
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
-- Tasa fija del holding (política fixed_period, `holding_fx_period_rates`) para convertir p_from → p_to en p_date. Una sola búsqueda
-- para el devengo (revenue_schedule_apply_fx_for_contract), las facturas (calculate_system_fx_rate) y la API.
--
-- Devuelve la fila tal como está guardada ("1 [to] = rate [from]"): `rate` crudo e `is_inverse` = la fila es p_to → p_from. Cada caller
-- conserva su convención (devengo multiplica por 1/rate directa o rate inversa; facturas dividen por rate directa o 1/rate inversa).
--
-- Orden: 1) fila directa que cubre la fecha (la más reciente), 2) inversa que cubre la fecha, 3) PROYECTADA (decisión de Domi 04-10):
-- si la fecha es posterior a todas las tasas registradas del par (en cualquier sentido), la última tasa registrada (mayor period_end;
-- empate: directa y la más reciente) extendida hacia adelante, sin escribirla, con `projected = true`. Cuando el holding registra la tasa
-- del período, esa pasa a cubrir la fecha y las posteriores se proyectan desde ella. Un hueco ENTRE dos tasas registradas no se proyecta
-- (es un error de carga): devuelve cero filas y quien llama marca missing_fx_rate. Sin ninguna tasa del par: cero filas.
-- Solo hacia adelante (Domi 04-10): la proyección aplica a fechas de meses POSTERIORES al mes en curso. Un mes pasado o el actual sin
-- tasa es un error de datos y sigue sin tasa ("Sin tipo de cambio", missing_fx_rate). El mes en curso es el del "hoy" del holding
-- (holding_settings.timezone, default America/Santiago: la misma zona con que la API calcula cierres, vencimientos y jobs), no el de
-- CURRENT_DATE de la sesión (UTC en Supabase, que adelanta el cambio de mes 3–4 horas).
DECLARE
  v_next_month date;
BEGIN
  IF p_from IS NULL OR p_to IS NULL OR p_date IS NULL OR p_from = p_to THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT r.rate, false, r.period_start, r.period_end, false
  FROM holding_fx_period_rates r
  WHERE r.holding_id = p_holding_id AND r.from_currency = p_from AND r.to_currency = p_to
    AND p_date BETWEEN r.period_start AND r.period_end AND r.rate > 0
  ORDER BY r.created_at DESC NULLS LAST
  LIMIT 1;
  IF FOUND THEN RETURN; END IF;

  RETURN QUERY
  SELECT r.rate, true, r.period_start, r.period_end, false
  FROM holding_fx_period_rates r
  WHERE r.holding_id = p_holding_id AND r.from_currency = p_to AND r.to_currency = p_from
    AND p_date BETWEEN r.period_start AND r.period_end AND r.rate > 0
  ORDER BY r.created_at DESC NULLS LAST
  LIMIT 1;
  IF FOUND THEN RETURN; END IF;

  -- Proyectada, solo hacia adelante: la fecha tiene que caer después del último día del mes en curso del holding, y la última tasa del
  -- par tiene que terminar ANTES de la fecha (si no, la fecha cae en un hueco).
  SELECT (DATE_TRUNC('month', now() AT TIME ZONE COALESCE(
            (SELECT hs.timezone FROM holding_settings hs WHERE hs.holding_id = p_holding_id LIMIT 1), 'America/Santiago'))
          + INTERVAL '1 month')::date
  INTO v_next_month;
  IF p_date < v_next_month THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT last.rate, last.is_inverse, last.period_start, last.period_end, true
  FROM (
    SELECT r.rate, (r.from_currency = p_to) AS is_inverse, r.period_start, r.period_end
    FROM holding_fx_period_rates r
    WHERE r.holding_id = p_holding_id AND r.rate > 0
      AND ((r.from_currency = p_from AND r.to_currency = p_to) OR (r.from_currency = p_to AND r.to_currency = p_from))
    ORDER BY r.period_end DESC, (r.from_currency = p_to), r.created_at DESC NULLS LAST
    LIMIT 1
  ) last
  WHERE last.period_end < p_date;
END;
$function$;

COMMENT ON FUNCTION public."holding_fixed_fx_rate"(p_holding_id uuid, p_from text, p_to text, p_date date) IS 'Tasa fija del holding (holding_fx_period_rates) para p_from → p_to en p_date, con la fila cruda ("1 [to] = rate [from]") e is_inverse. Sin tasa que cubra la fecha, con la fecha en un mes posterior al mes en curso del holding (holding_settings.timezone) y posterior a todas las tasas del par: última tasa registrada extendida hacia adelante, projected = true (sin escribirla; decisión de Domi 04-10). Mes pasado o actual sin tasa, hueco entre tasas o par sin tasas: sin filas.';
