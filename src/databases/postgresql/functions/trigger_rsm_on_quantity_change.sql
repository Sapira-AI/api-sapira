CREATE OR REPLACE FUNCTION public.trigger_rsm_on_quantity_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_enabled boolean := false;
  v_contract_status text;
BEGIN
  SELECT revenue_schedule_monthly_enabled INTO v_enabled
  FROM financial_settings
  WHERE holding_id = get_current_user_holding_id()
  LIMIT 1;

  IF NOT COALESCE(v_enabled, false) THEN
    RETURN NEW;
  END IF;

  -- Solo actuar si el registro tiene amount y contract_id definidos
  IF NEW.amount IS NULL OR NEW.contract_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT status INTO v_contract_status FROM contracts WHERE id = NEW.contract_id;

  IF v_contract_status <> 'Activo' THEN
    RETURN NEW;
  END IF;

  BEGIN
    PERFORM revenue_schedule_update_period_quantities(
      NEW.contract_item_id,
      NEW.period,
      NEW.amount
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'RSM period update failed para contract_item % período %: %',
      NEW.contract_item_id, NEW.period, SQLERRM;
  END;

  RETURN NEW;
END;
$$;
