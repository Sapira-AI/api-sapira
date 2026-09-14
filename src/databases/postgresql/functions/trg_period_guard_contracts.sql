CREATE OR REPLACE FUNCTION public.trg_period_guard_contracts()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_mode text;
  v_cutoff date;
  v_has_locked_item boolean;
  v_changed_locked boolean := false;
  v_fields_changed text[] := ARRAY[]::text[];
  v_warn_msg text;
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF public.is_period_guard_bypassed() THEN
    RETURN NEW;
  END IF;

  v_mode := public.get_period_guard_mode();
  IF v_mode = 'off' THEN
    RETURN NEW;
  END IF;

  IF NEW.status NOT IN ('Activo', 'Cancelado', 'Expirado') THEN
    RETURN NEW;
  END IF;

  IF OLD.company_id                IS DISTINCT FROM NEW.company_id                THEN v_fields_changed := array_append(v_fields_changed, 'company_id'); END IF;
  IF OLD.client_entity_id          IS DISTINCT FROM NEW.client_entity_id          THEN v_fields_changed := array_append(v_fields_changed, 'client_entity_id'); END IF;
  IF OLD.client_id                 IS DISTINCT FROM NEW.client_id                 THEN v_fields_changed := array_append(v_fields_changed, 'client_id'); END IF;
  IF OLD.contract_number           IS DISTINCT FROM NEW.contract_number           THEN v_fields_changed := array_append(v_fields_changed, 'contract_number'); END IF;
  IF OLD.contract_currency         IS DISTINCT FROM NEW.contract_currency         THEN v_fields_changed := array_append(v_fields_changed, 'contract_currency'); END IF;
  IF OLD.company_currency          IS DISTINCT FROM NEW.company_currency          THEN v_fields_changed := array_append(v_fields_changed, 'company_currency'); END IF;
  IF OLD.system_currency           IS DISTINCT FROM NEW.system_currency           THEN v_fields_changed := array_append(v_fields_changed, 'system_currency'); END IF;
  IF OLD.fx_rate_to_system         IS DISTINCT FROM NEW.fx_rate_to_system         THEN v_fields_changed := array_append(v_fields_changed, 'fx_rate_to_system'); END IF;
  IF OLD.quote_id                  IS DISTINCT FROM NEW.quote_id                  THEN v_fields_changed := array_append(v_fields_changed, 'quote_id'); END IF;
  IF OLD.renewed_from_contract_id  IS DISTINCT FROM NEW.renewed_from_contract_id  THEN v_fields_changed := array_append(v_fields_changed, 'renewed_from_contract_id'); END IF;
  IF OLD.renewed_to_contract_id    IS DISTINCT FROM NEW.renewed_to_contract_id    THEN v_fields_changed := array_append(v_fields_changed, 'renewed_to_contract_id'); END IF;

  v_changed_locked := COALESCE(array_length(v_fields_changed, 1), 0) > 0;
  IF NOT v_changed_locked THEN
    RETURN NEW;
  END IF;

  v_cutoff := public.get_cutoff_date(OLD.holding_id, OLD.company_id);
  IF v_cutoff IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.contract_items
     WHERE contract_id = NEW.id
       AND start_date <= v_cutoff
  ) INTO v_has_locked_item;

  IF NOT v_has_locked_item THEN
    RETURN NEW;
  END IF;

  v_warn_msg := format(
    'UPDATE bloqueado en contracts.%s — al menos un ítem tiene start_date <= cutoff %s (company %s)',
    array_to_string(v_fields_changed, ','), v_cutoff, OLD.company_id
  );

  IF v_mode = 'warn' THEN
    INSERT INTO public.period_guard_warnings(
      triggered_by, table_name, operation, contract_id,
      holding_id, company_id, cutoff_date, fields_changed, message,
      payload
    ) VALUES (
      public.get_current_user_id(), 'contracts', 'UPDATE', NEW.id,
      OLD.holding_id, OLD.company_id, v_cutoff, v_fields_changed, v_warn_msg,
      jsonb_build_object(
        'old', to_jsonb(OLD),
        'new', to_jsonb(NEW)
      )
    );
    RETURN NEW;
  END IF;

  RAISE EXCEPTION
    'No se puede modificar campo(s) padre del contrato (%): existe al menos un ítem con start_date <= % (período cerrado de la compañía)',
    array_to_string(v_fields_changed, ','), v_cutoff
    USING ERRCODE = 'P0001',
          HINT = 'Reabrir el período correspondiente o restringir el cambio';
END $function$

