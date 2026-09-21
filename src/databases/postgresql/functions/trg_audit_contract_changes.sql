CREATE OR REPLACE FUNCTION public.trg_audit_contract_changes()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_user_id uuid;
  v_user_name text;
  v_user_email text;
  v_fields text[] := ARRAY[]::text[];
  v_before jsonb;
  v_after jsonb;
BEGIN
  IF COALESCE(NEW.status, OLD.status) NOT IN ('Activo', 'Cancelado', 'Expirado') THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  SELECT v_id, v_name, v_email INTO v_user_id, v_user_name, v_user_email FROM public.audit_resolve_user();

  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.contract_change_log(
      contract_id, company_id, holding_id,
      changed_by, changed_by_name, changed_by_email,
      change_type, after_values, source
    ) VALUES (
      NEW.id, NEW.company_id, NEW.holding_id,
      v_user_id, v_user_name, v_user_email,
      'CREATE', to_jsonb(NEW), 'manual_edit'
    );
    RETURN NEW;

  ELSIF TG_OP = 'DELETE' THEN
    INSERT INTO public.contract_change_log(
      contract_id, company_id, holding_id,
      changed_by, changed_by_name, changed_by_email,
      change_type, before_values, source
    ) VALUES (
      OLD.id, OLD.company_id, OLD.holding_id,
      v_user_id, v_user_name, v_user_email,
      'DELETE', to_jsonb(OLD), 'manual_edit'
    );
    RETURN OLD;

  ELSE
    IF OLD.company_id                IS DISTINCT FROM NEW.company_id                THEN v_fields := array_append(v_fields, 'company_id'); END IF;
    IF OLD.client_entity_id          IS DISTINCT FROM NEW.client_entity_id          THEN v_fields := array_append(v_fields, 'client_entity_id'); END IF;
    IF OLD.client_id                 IS DISTINCT FROM NEW.client_id                 THEN v_fields := array_append(v_fields, 'client_id'); END IF;
    IF OLD.contract_number           IS DISTINCT FROM NEW.contract_number           THEN v_fields := array_append(v_fields, 'contract_number'); END IF;
    IF OLD.contract_currency         IS DISTINCT FROM NEW.contract_currency         THEN v_fields := array_append(v_fields, 'contract_currency'); END IF;
    IF OLD.company_currency          IS DISTINCT FROM NEW.company_currency          THEN v_fields := array_append(v_fields, 'company_currency'); END IF;
    IF OLD.invoice_currency          IS DISTINCT FROM NEW.invoice_currency          THEN v_fields := array_append(v_fields, 'invoice_currency'); END IF;
    IF OLD.system_currency           IS DISTINCT FROM NEW.system_currency           THEN v_fields := array_append(v_fields, 'system_currency'); END IF;
    IF OLD.fx_rate_to_system         IS DISTINCT FROM NEW.fx_rate_to_system         THEN v_fields := array_append(v_fields, 'fx_rate_to_system'); END IF;
    IF OLD.quote_id                  IS DISTINCT FROM NEW.quote_id                  THEN v_fields := array_append(v_fields, 'quote_id'); END IF;
    IF OLD.renewed_from_contract_id  IS DISTINCT FROM NEW.renewed_from_contract_id  THEN v_fields := array_append(v_fields, 'renewed_from_contract_id'); END IF;
    IF OLD.renewed_to_contract_id    IS DISTINCT FROM NEW.renewed_to_contract_id    THEN v_fields := array_append(v_fields, 'renewed_to_contract_id'); END IF;
    IF OLD.contract_end_date         IS DISTINCT FROM NEW.contract_end_date         THEN v_fields := array_append(v_fields, 'contract_end_date'); END IF;
    IF OLD.total_value               IS DISTINCT FROM NEW.total_value               THEN v_fields := array_append(v_fields, 'total_value'); END IF;
    IF OLD.notes                     IS DISTINCT FROM NEW.notes                     THEN v_fields := array_append(v_fields, 'notes'); END IF;
    IF OLD.invoice_terms_and_conditions IS DISTINCT FROM NEW.invoice_terms_and_conditions THEN v_fields := array_append(v_fields, 'invoice_terms_and_conditions'); END IF;
    IF OLD.churn_date                IS DISTINCT FROM NEW.churn_date                THEN v_fields := array_append(v_fields, 'churn_date'); END IF;
    IF OLD.churn_reason              IS DISTINCT FROM NEW.churn_reason              THEN v_fields := array_append(v_fields, 'churn_reason'); END IF;
    IF OLD.status                    IS DISTINCT FROM NEW.status                    THEN v_fields := array_append(v_fields, 'status'); END IF;

    IF array_length(v_fields, 1) IS NULL THEN
      RETURN NEW;
    END IF;

    SELECT jsonb_object_agg(k, v_old.value)
      INTO v_before
      FROM unnest(v_fields) k,
           LATERAL (SELECT to_jsonb(OLD) -> k AS value) v_old;
    SELECT jsonb_object_agg(k, v_new.value)
      INTO v_after
      FROM unnest(v_fields) k,
           LATERAL (SELECT to_jsonb(NEW) -> k AS value) v_new;

    INSERT INTO public.contract_change_log(
      contract_id, company_id, holding_id,
      changed_by, changed_by_name, changed_by_email,
      change_type, fields_changed, before_values, after_values, source
    ) VALUES (
      NEW.id, NEW.company_id, NEW.holding_id,
      v_user_id, v_user_name, v_user_email,
      'UPDATE', v_fields, v_before, v_after, 'manual_edit'
    );
    RETURN NEW;
  END IF;
END $function$

