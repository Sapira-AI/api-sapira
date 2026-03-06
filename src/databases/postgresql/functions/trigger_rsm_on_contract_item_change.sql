CREATE OR REPLACE FUNCTION public.trigger_rsm_on_contract_item_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_enabled boolean := false;
  v_contract_id uuid;
  v_contract_status text;
  v_affected_month date;
BEGIN
  SELECT revenue_schedule_monthly_enabled INTO v_enabled
  FROM financial_settings
  WHERE holding_id = get_current_user_holding_id()
  LIMIT 1;

  IF NOT COALESCE(v_enabled, false) THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  v_contract_id := COALESCE(NEW.contract_id, OLD.contract_id);

  IF v_contract_id IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  SELECT status INTO v_contract_status FROM contracts WHERE id = v_contract_id;

  IF v_contract_status <> 'Activo' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- Recalcular desde el mes más temprano afectado por el cambio.
  -- En DELETE solo existe OLD; COALESCE lo maneja automáticamente.
  v_affected_month := DATE_TRUNC('month',
    COALESCE(
      LEAST(NEW.start_date, OLD.start_date),
      COALESCE(NEW.start_date, OLD.start_date)
    )
  )::date;

  BEGIN
    PERFORM revenue_schedule_rebuild(v_contract_id, v_affected_month);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'RSM rebuild failed para contrato % (trigger contract_items): %', v_contract_id, SQLERRM;
  END;

  RETURN COALESCE(NEW, OLD);
END;
$$;
