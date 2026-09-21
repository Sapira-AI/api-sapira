CREATE OR REPLACE FUNCTION public.trg_audit_contract_item_changes()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_user_id uuid;
  v_user_name text;
  v_user_email text;
  v_status text;
  v_holding uuid;
  v_company uuid;
  v_contract_id uuid;
  v_fields text[] := ARRAY[]::text[];
  v_change_type text;
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_contract_id := COALESCE(NEW.contract_id, OLD.contract_id);
  SELECT c.status, c.holding_id, c.company_id
    INTO v_status, v_holding, v_company
  FROM public.contracts c
  WHERE c.id = v_contract_id;

  IF v_status NOT IN ('Activo', 'Cancelado', 'Expirado') THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  SELECT v_id, v_name, v_email INTO v_user_id, v_user_name, v_user_email FROM public.audit_resolve_user();

  IF TG_OP = 'INSERT' THEN
    v_change_type := 'CREATE';
    v_after := to_jsonb(NEW);
    INSERT INTO public.contract_item_change_log(
      contract_item_id, contract_id, company_id, holding_id,
      changed_by, changed_by_name, changed_by_email,
      change_type, after_values, source
    ) VALUES (
      NEW.id, NEW.contract_id, v_company, v_holding,
      v_user_id, v_user_name, v_user_email,
      v_change_type, v_after, 'manual_edit'
    );
    RETURN NEW;

  ELSIF TG_OP = 'DELETE' THEN
    v_change_type := 'DELETE';
    v_before := to_jsonb(OLD);
    INSERT INTO public.contract_item_change_log(
      contract_item_id, contract_id, company_id, holding_id,
      changed_by, changed_by_name, changed_by_email,
      change_type, before_values, source
    ) VALUES (
      OLD.id, OLD.contract_id, v_company, v_holding,
      v_user_id, v_user_name, v_user_email,
      v_change_type, v_before, 'manual_edit'
    );
    RETURN OLD;

  ELSE
    v_change_type := 'UPDATE';
    IF OLD.unit_price            IS DISTINCT FROM NEW.unit_price            THEN v_fields := array_append(v_fields, 'unit_price'); END IF;
    IF OLD.quantity              IS DISTINCT FROM NEW.quantity              THEN v_fields := array_append(v_fields, 'quantity'); END IF;
    IF OLD.monthly_price         IS DISTINCT FROM NEW.monthly_price         THEN v_fields := array_append(v_fields, 'monthly_price'); END IF;
    IF OLD.billing_period_price  IS DISTINCT FROM NEW.billing_period_price  THEN v_fields := array_append(v_fields, 'billing_period_price'); END IF;
    IF OLD.annual_price          IS DISTINCT FROM NEW.annual_price          THEN v_fields := array_append(v_fields, 'annual_price'); END IF;
    IF OLD.price                 IS DISTINCT FROM NEW.price                 THEN v_fields := array_append(v_fields, 'price'); END IF;
    IF OLD.final_price           IS DISTINCT FROM NEW.final_price           THEN v_fields := array_append(v_fields, 'final_price'); END IF;
    IF OLD.discount_value        IS DISTINCT FROM NEW.discount_value        THEN v_fields := array_append(v_fields, 'discount_value'); END IF;
    IF OLD.discount_type         IS DISTINCT FROM NEW.discount_type        THEN v_fields := array_append(v_fields, 'discount_type'); END IF;
    IF OLD.start_date            IS DISTINCT FROM NEW.start_date            THEN v_fields := array_append(v_fields, 'start_date'); END IF;
    IF OLD.end_date              IS DISTINCT FROM NEW.end_date              THEN v_fields := array_append(v_fields, 'end_date'); END IF;
    IF OLD.term_months           IS DISTINCT FROM NEW.term_months           THEN v_fields := array_append(v_fields, 'term_months'); END IF;
    IF OLD.billing_frequency     IS DISTINCT FROM NEW.billing_frequency     THEN v_fields := array_append(v_fields, 'billing_frequency'); END IF;
    IF OLD.billing_method        IS DISTINCT FROM NEW.billing_method        THEN v_fields := array_append(v_fields, 'billing_method'); END IF;
    IF OLD.is_recurring          IS DISTINCT FROM NEW.is_recurring          THEN v_fields := array_append(v_fields, 'is_recurring'); END IF;
    IF OLD.product_id            IS DISTINCT FROM NEW.product_id            THEN v_fields := array_append(v_fields, 'product_id'); END IF;
    IF OLD.currency              IS DISTINCT FROM NEW.currency              THEN v_fields := array_append(v_fields, 'currency'); END IF;
    IF OLD.categoria             IS DISTINCT FROM NEW.categoria             THEN v_fields := array_append(v_fields, 'categoria'); END IF;
    IF OLD.annual_unit_price     IS DISTINCT FROM NEW.annual_unit_price     THEN v_fields := array_append(v_fields, 'annual_unit_price'); END IF;
    IF OLD.renewal_base_unit_price IS DISTINCT FROM NEW.renewal_base_unit_price THEN v_fields := array_append(v_fields, 'renewal_base_unit_price'); END IF;
    IF OLD.booking_date          IS DISTINCT FROM NEW.booking_date          THEN v_fields := array_append(v_fields, 'booking_date'); END IF;
    IF OLD.product_name          IS DISTINCT FROM NEW.product_name          THEN v_fields := array_append(v_fields, 'product_name'); END IF;
    IF OLD.account               IS DISTINCT FROM NEW.account               THEN v_fields := array_append(v_fields, 'account'); END IF;
    IF OLD.churn_date            IS DISTINCT FROM NEW.churn_date            THEN v_fields := array_append(v_fields, 'churn_date'); END IF;
    IF OLD.churn_monthly_amount  IS DISTINCT FROM NEW.churn_monthly_amount  THEN v_fields := array_append(v_fields, 'churn_monthly_amount'); END IF;
    IF OLD.custom_fields         IS DISTINCT FROM NEW.custom_fields         THEN v_fields := array_append(v_fields, 'custom_fields'); END IF;

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

    INSERT INTO public.contract_item_change_log(
      contract_item_id, contract_id, company_id, holding_id,
      changed_by, changed_by_name, changed_by_email,
      change_type, fields_changed, before_values, after_values, source
    ) VALUES (
      NEW.id, NEW.contract_id, v_company, v_holding,
      v_user_id, v_user_name, v_user_email,
      v_change_type, v_fields, v_before, v_after, 'manual_edit'
    );
    RETURN NEW;
  END IF;
END $function$

