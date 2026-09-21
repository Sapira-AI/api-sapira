CREATE OR REPLACE FUNCTION public.convert_amount(p_holding_id uuid, p_amount numeric, p_from_currency text, p_to_currency text, p_reference_date date, p_policy text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_rate numeric;
  v_source text;
  v_ref_date date;
  v_converted numeric;
BEGIN
  IF p_holding_id IS NULL OR p_holding_id <> public.get_current_user_holding_id() THEN
    RAISE EXCEPTION 'invalid holding_id';
  END IF;

  SELECT r.rate, r.source, r.reference_date
  INTO v_rate, v_source, v_ref_date
  FROM public.get_fx_rate(
    p_holding_id,
    p_from_currency,
    p_to_currency,
    p_reference_date,
    p_policy
  ) AS r;

  IF p_amount IS NULL THEN
    v_converted := NULL;
  ELSIF v_rate IS NULL THEN
    v_converted := NULL;
  ELSE
    v_converted := ROUND(p_amount * v_rate, 2);
  END IF;

  RETURN jsonb_build_object(
    'amount', p_amount,
    'from_currency', p_from_currency,
    'to_currency', p_to_currency,
    'reference_date', p_reference_date,
    'rate', v_rate,
    'fx_source', v_source,
    'fx_reference_date', v_ref_date,
    'converted_amount', v_converted
  );
END;
$function$

