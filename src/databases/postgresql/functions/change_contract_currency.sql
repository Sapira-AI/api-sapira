CREATE OR REPLACE FUNCTION public.change_contract_currency(p_contract_id uuid, p_new_currency text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_holding_id uuid; v_contract record;
  v_items_updated int := 0; v_invoices_updated int := 0;
BEGIN
  IF p_new_currency IS NULL OR length(trim(p_new_currency)) = 0 THEN
    RAISE EXCEPTION 'Moneda destino requerida'; END IF;
  SELECT public.get_current_user_holding_id() INTO v_holding_id;
  IF v_holding_id IS NULL THEN
    RAISE EXCEPTION 'No se pudo obtener el holding del usuario'; END IF;
  SELECT * INTO v_contract FROM public.contracts
  WHERE id = p_contract_id AND holding_id = v_holding_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Contrato no encontrado o fuera del holding del usuario'; END IF;
  IF v_contract.status IN ('Firmado', 'Activo', 'Cancelado', 'Expirado') THEN
    RAISE EXCEPTION 'No se puede cambiar la moneda de un contrato en estado: %', v_contract.status; END IF;
  IF v_contract.contract_currency = p_new_currency
     AND NOT EXISTS (SELECT 1 FROM public.contract_items
       WHERE contract_id = p_contract_id AND currency IS DISTINCT FROM p_new_currency) THEN
    RETURN json_build_object('items_updated', 0, 'invoices_updated', 0, 'noop', true); END IF;
  PERFORM set_config('sapira.skip_currency_validation', 'on', true);
  UPDATE public.contracts SET contract_currency = p_new_currency
    WHERE id = p_contract_id AND contract_currency IS DISTINCT FROM p_new_currency;
  WITH upd AS (UPDATE public.contract_items SET currency = p_new_currency
    WHERE contract_id = p_contract_id AND currency IS DISTINCT FROM p_new_currency RETURNING 1)
  SELECT count(*) INTO v_items_updated FROM upd;
  WITH upd AS (UPDATE public.contract_invoices SET currency = p_new_currency
    WHERE contract_id = p_contract_id AND status = 'Programada'
      AND currency IS DISTINCT FROM p_new_currency RETURNING 1)
  SELECT count(*) INTO v_invoices_updated FROM upd;
  PERFORM set_config('sapira.skip_currency_validation', 'off', true);
  RETURN json_build_object('items_updated', v_items_updated,
    'invoices_updated', v_invoices_updated, 'noop', false);
END; $function$

