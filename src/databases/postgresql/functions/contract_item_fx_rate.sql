CREATE OR REPLACE FUNCTION public.contract_item_fx_rate(p_contract_id uuid, p_from text, p_to text, p_month_start date, p_month_end date)
 RETURNS numeric
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
DECLARE
  v_rate numeric;
BEGIN
  -- Multimoneda (spec-multimoneda-contrato §3 #1/#5): tasa fija pactada ítem → contrato (`purpose = 'item'`) con la regla única
  -- "1 [from] = rate [to]": la fila directa que cubre el mes (la más reciente) o, si no, la inversa como 1/rate a 6 decimales (igual que
  -- findFixedRate del motor TS: MRR/TCV de la API y RSM usan la misma tasa). Misma moneda → 1.
  -- Sin fila → NULL (nunca 1): quien la usa marca la fila como missing_fx_rate.
  IF p_from IS NULL OR p_to IS NULL OR UPPER(TRIM(p_from)) = UPPER(TRIM(p_to)) THEN RETURN 1; END IF;
  SELECT r.rate INTO v_rate
  FROM contract_fx_period_rates r
  WHERE r.contract_id = p_contract_id AND r.purpose = 'item'
    AND UPPER(TRIM(r.from_currency)) = UPPER(TRIM(p_from)) AND UPPER(TRIM(r.to_currency)) = UPPER(TRIM(p_to))
    AND r.period_start <= p_month_end AND r.period_end >= p_month_start AND r.rate > 0
  ORDER BY r.created_at DESC NULLS LAST
  LIMIT 1;
  IF v_rate IS NOT NULL THEN RETURN v_rate; END IF;
  SELECT ROUND(1.0 / r.rate, 6) INTO v_rate
  FROM contract_fx_period_rates r
  WHERE r.contract_id = p_contract_id AND r.purpose = 'item'
    AND UPPER(TRIM(r.from_currency)) = UPPER(TRIM(p_to)) AND UPPER(TRIM(r.to_currency)) = UPPER(TRIM(p_from))
    AND r.period_start <= p_month_end AND r.period_end >= p_month_start AND r.rate > 0
  ORDER BY r.created_at DESC NULLS LAST
  LIMIT 1;
  RETURN v_rate;
END;
$function$
