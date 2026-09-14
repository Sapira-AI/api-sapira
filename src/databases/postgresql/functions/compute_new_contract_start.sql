CREATE OR REPLACE FUNCTION public.compute_new_contract_start(p_start date, p_cutoff date)
 RETURNS date
 LANGUAGE plpgsql
 IMMUTABLE
AS $function$
DECLARE
  v_day        int;
  v_next_month date;
  v_last_day   int;
BEGIN
  IF p_start IS NULL OR p_cutoff IS NULL THEN
    RETURN p_start;
  END IF;
  IF p_start > p_cutoff THEN
    RETURN p_start;
  END IF;
  v_day := EXTRACT(DAY FROM p_start)::int;
  v_next_month := date_trunc('month', p_cutoff + INTERVAL '1 month')::date;
  v_last_day := EXTRACT(DAY FROM (v_next_month + INTERVAL '1 month - 1 day'))::int;
  RETURN v_next_month + (LEAST(v_day, v_last_day) - 1);
END;
$function$

