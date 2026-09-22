CREATE OR REPLACE FUNCTION public.restore_rsm_on_quantity_delete()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_enabled         boolean := false;
  v_contract_id     uuid;
  v_contract_status text;
  v_unit_price      numeric;
  v_quantity        numeric;
  v_discount        numeric;
  v_amount          numeric;
BEGIN
  IF OLD.contract_item_id IS NULL THEN
    RETURN OLD;
  END IF;

  SELECT revenue_schedule_monthly_enabled INTO v_enabled
  FROM financial_settings
  WHERE holding_id = get_current_user_holding_id()
  LIMIT 1;

  IF NOT COALESCE(v_enabled, false) THEN
    RETURN OLD;
  END IF;

  SELECT contract_id, unit_price, quantity, discount_value
  INTO v_contract_id, v_unit_price, v_quantity, v_discount
  FROM public.contract_items
  WHERE id = OLD.contract_item_id;

  IF v_unit_price IS NULL OR v_quantity IS NULL OR v_contract_id IS NULL THEN
    RETURN OLD;
  END IF;

  SELECT status INTO v_contract_status FROM public.contracts WHERE id = v_contract_id;

  IF v_contract_status <> 'Activo' THEN
    RETURN OLD;
  END IF;

  v_amount := v_unit_price * v_quantity * (1 - COALESCE(v_discount, 0) / 100.0);

  BEGIN
    PERFORM public.revenue_schedule_update_period_quantities(
      OLD.contract_item_id,
      OLD.period,
      v_amount
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'restore_rsm_on_quantity_delete: error procesando contract_item % período %: %',
      OLD.contract_item_id, OLD.period, SQLERRM;
  END;

  RETURN OLD;
END;
$function$;

COMMENT ON FUNCTION public."restore_rsm_on_quantity_delete"() IS 'Trigger AFTER DELETE en quantities. Cuando se elimina un override, restaura
el revenue_schedule_monthly del período al amount base del contract_item
(unit_price × quantity × (1 - discount/100)). Reusa la RPC
revenue_schedule_update_period_quantities. Mismo guard que
trigger_rsm_on_quantity_change: financial_settings habilitado + contrato Activo.';
