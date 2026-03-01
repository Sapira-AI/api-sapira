CREATE OR REPLACE FUNCTION public.trigger_rsm_on_invoice_change()
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
  v_old_status text;
  v_new_status text;
BEGIN
  SELECT revenue_schedule_monthly_enabled INTO v_enabled
  FROM financial_settings
  WHERE holding_id = get_current_user_holding_id()
  LIMIT 1;

  IF NOT COALESCE(v_enabled, false) THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  v_old_status := CASE WHEN TG_OP = 'DELETE' THEN OLD.status ELSE COALESCE(OLD.status, '') END;
  v_new_status := CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE NEW.status END;

  IF TG_OP = 'UPDATE' THEN
    -- Salir si ningún campo que impacta RSM cambió
    IF  v_old_status = v_new_status
    AND OLD.issue_date IS NOT DISTINCT FROM NEW.issue_date
    AND OLD.total_invoice_currency IS NOT DISTINCT FROM NEW.total_invoice_currency THEN
      RETURN NEW;
    END IF;
    -- Salir si ninguno de los dos status involucrados afecta billed_*
    IF v_old_status NOT IN ('Enviada','Pagada','Vencida','Anulada','Cancelada')
    AND COALESCE(v_new_status,'') NOT IN ('Enviada','Pagada','Vencida','Anulada','Cancelada') THEN
      RETURN NEW;
    END IF;
  END IF;

  v_contract_id    := CASE WHEN TG_OP = 'DELETE' THEN OLD.contract_id ELSE NEW.contract_id END;
  v_affected_month := DATE_TRUNC('month',
    CASE WHEN TG_OP = 'DELETE' THEN OLD.issue_date ELSE NEW.issue_date END
  )::date;

  IF v_contract_id IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  SELECT status INTO v_contract_status FROM contracts WHERE id = v_contract_id;

  IF v_contract_status <> 'Activo' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  BEGIN
    PERFORM revenue_schedule_rebuild(v_contract_id, v_affected_month);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'RSM rebuild failed para contrato % (trigger invoices): %', v_contract_id, SQLERRM;
  END;

  RETURN COALESCE(NEW, OLD);
END;
$$;
