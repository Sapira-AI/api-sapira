CREATE OR REPLACE FUNCTION public.trigger_rsm_on_quantity_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_enabled boolean := false;
  v_contract_status text;
  v_amount numeric;
BEGIN
  SELECT revenue_schedule_monthly_enabled INTO v_enabled
  FROM financial_settings
  WHERE holding_id = get_current_user_holding_id()
  LIMIT 1;

  IF NOT COALESCE(v_enabled, false) THEN
    RETURN NEW;
  END IF;

  v_amount := COALESCE(
    NEW.amount,
    CASE
      WHEN NEW.unit_price IS NOT NULL AND NEW.quantity IS NOT NULL
      THEN NEW.unit_price * NEW.quantity
    END
  );

  IF v_amount IS NULL OR NEW.contract_id IS NULL THEN
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
      v_amount
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'RSM period update failed para contract_item % período %: %',
      NEW.contract_item_id, NEW.period, SQLERRM;
  END;

  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public."trigger_rsm_on_quantity_change"() IS 'Trigger AFTER INSERT OR UPDATE en quantities.
Actualiza revenue_schedule_monthly del período afectado cuando el contrato
está Activo y revenue_schedule_monthly_enabled = true en financial_settings.

FIX 2026-04-28: ahora deriva amount = unit_price * quantity cuando NEW.amount
                es NULL. Antes el trigger se saltaba todos los overrides
                ingresados en formato Opción A (unit_price + quantity).';
