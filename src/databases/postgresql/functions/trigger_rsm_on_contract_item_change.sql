CREATE OR REPLACE FUNCTION public.trigger_rsm_on_contract_item_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_enabled boolean := false;
  v_contract_id uuid;
  v_contract_status text;
  v_affected_month date;
BEGIN
  -- Costura sapira.writer: en una transacción de la API (v2) este trigger no hace nada; la API escribe cada campo.
  -- El front viejo nunca fija la marca: para él el trigger sigue igual. Regla: docs/reglas-desarrollo/logica-en-api-triggers.md
  IF current_setting('sapira.writer', true) = 'api' THEN
    RETURN NULL;  -- AFTER: el valor de retorno se ignora
  END IF;

  -- U9: la configuración del holding del registro, no la del usuario de sesión (sin sesión —webhook Odoo, DWH, cron— el
  -- holding de sesión es NULL y el RSM no se actualizaba).
  SELECT revenue_schedule_monthly_enabled INTO v_enabled
  FROM financial_settings
  WHERE holding_id = CASE WHEN TG_OP = 'DELETE' THEN OLD.holding_id ELSE NEW.holding_id END
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

  v_affected_month := DATE_TRUNC('month',
    LEAST(
      COALESCE(
        LEAST(NEW.start_date, OLD.start_date),
        COALESCE(NEW.start_date, OLD.start_date)
      ),
      COALESCE(
        LEAST(NEW.booking_date, OLD.booking_date),
        COALESCE(NEW.booking_date, OLD.booking_date, NEW.start_date, OLD.start_date)
      )
    )
  )::date;

  BEGIN
    PERFORM revenue_schedule_rebuild(v_contract_id, v_affected_month);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'RSM rebuild failed para contrato % (trigger contract_items): %', v_contract_id, SQLERRM;
  END;

  RETURN COALESCE(NEW, OLD);
END;
$function$

