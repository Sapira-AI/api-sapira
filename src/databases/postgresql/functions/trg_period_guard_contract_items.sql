CREATE OR REPLACE FUNCTION public.trg_period_guard_contract_items()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_mode text;
  v_status text;
  v_holding uuid;
  v_company uuid;
  v_cutoff date;
  v_old_closed boolean := false;
  v_new_closed boolean := false;
  v_changed_locked boolean := false;
  v_offending text;
  v_fields_changed text[] := ARRAY[]::text[];
  v_contract_id uuid;
  v_warn_msg text;
BEGIN
  IF public.is_period_guard_bypassed() THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  v_mode := public.get_period_guard_mode();
  IF v_mode = 'off' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  v_contract_id := COALESCE(NEW.contract_id, OLD.contract_id);
  SELECT c.status, c.holding_id, c.company_id
    INTO v_status, v_holding, v_company
  FROM public.contracts c
  WHERE c.id = v_contract_id;

  IF v_status NOT IN ('Activo', 'Cancelado', 'Expirado') THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  v_cutoff := public.get_cutoff_date(v_holding, v_company);
  IF v_cutoff IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF OLD.start_date IS NOT NULL THEN
    v_old_closed := OLD.start_date <= v_cutoff;
  END IF;
  IF NEW.start_date IS NOT NULL THEN
    v_new_closed := NEW.start_date <= v_cutoff;
  END IF;

  IF TG_OP = 'INSERT' AND v_new_closed THEN
    v_warn_msg := format(
      'INSERT bloqueado: contract_item con start_date %s <= cutoff %s (company %s)',
      NEW.start_date, v_cutoff, v_company
    );

    IF v_mode = 'warn' THEN
      INSERT INTO public.period_guard_warnings(
        triggered_by, table_name, operation, contract_id, contract_item_id,
        holding_id, company_id, cutoff_date, message,
        payload
      ) VALUES (
        public.get_current_user_id(), 'contract_items', 'INSERT', NEW.contract_id, NEW.id,
        v_holding, v_company, v_cutoff, v_warn_msg,
        jsonb_build_object('new', to_jsonb(NEW))
      );
      RETURN NEW;
    END IF;

    RAISE EXCEPTION
      'No se puede crear un ítem con start_date en período cerrado (% <= cutoff %)',
      NEW.start_date, v_cutoff
      USING ERRCODE = 'P0001',
            HINT = 'Reabrir el período en Configuración → Sistema → Cierre de Períodos';
  END IF;

  IF TG_OP = 'DELETE' AND v_old_closed THEN
    v_warn_msg := format(
      'DELETE bloqueado: contract_item id %s con start_date %s <= cutoff %s',
      OLD.id, OLD.start_date, v_cutoff
    );

    IF v_mode = 'warn' THEN
      INSERT INTO public.period_guard_warnings(
        triggered_by, table_name, operation, contract_id, contract_item_id,
        holding_id, company_id, cutoff_date, message,
        payload
      ) VALUES (
        public.get_current_user_id(), 'contract_items', 'DELETE', OLD.contract_id, OLD.id,
        v_holding, v_company, v_cutoff, v_warn_msg,
        jsonb_build_object('old', to_jsonb(OLD))
      );
      RETURN OLD;
    END IF;

    RAISE EXCEPTION
      'No se puede eliminar un ítem cuyo start_date (%) está en período cerrado (cutoff %)',
      OLD.start_date, v_cutoff
      USING ERRCODE = 'P0001';
  END IF;

  IF TG_OP = 'UPDATE' AND (v_old_closed OR v_new_closed) THEN
    IF OLD.unit_price            IS DISTINCT FROM NEW.unit_price           THEN v_fields_changed := array_append(v_fields_changed, 'unit_price'); END IF;
    IF OLD.quantity              IS DISTINCT FROM NEW.quantity             THEN v_fields_changed := array_append(v_fields_changed, 'quantity'); END IF;
    IF OLD.monthly_price         IS DISTINCT FROM NEW.monthly_price        THEN v_fields_changed := array_append(v_fields_changed, 'monthly_price'); END IF;
    IF OLD.billing_period_price  IS DISTINCT FROM NEW.billing_period_price THEN v_fields_changed := array_append(v_fields_changed, 'billing_period_price'); END IF;
    IF OLD.annual_price          IS DISTINCT FROM NEW.annual_price         THEN v_fields_changed := array_append(v_fields_changed, 'annual_price'); END IF;
    IF OLD.price                 IS DISTINCT FROM NEW.price                THEN v_fields_changed := array_append(v_fields_changed, 'price'); END IF;
    IF OLD.final_price           IS DISTINCT FROM NEW.final_price          THEN v_fields_changed := array_append(v_fields_changed, 'final_price'); END IF;
    IF OLD.discount_value        IS DISTINCT FROM NEW.discount_value       THEN v_fields_changed := array_append(v_fields_changed, 'discount_value'); END IF;
    IF OLD.discount_type         IS DISTINCT FROM NEW.discount_type        THEN v_fields_changed := array_append(v_fields_changed, 'discount_type'); END IF;
    IF OLD.start_date            IS DISTINCT FROM NEW.start_date           THEN v_fields_changed := array_append(v_fields_changed, 'start_date'); END IF;
    IF OLD.end_date              IS DISTINCT FROM NEW.end_date             THEN v_fields_changed := array_append(v_fields_changed, 'end_date'); END IF;
    IF OLD.term_months           IS DISTINCT FROM NEW.term_months          THEN v_fields_changed := array_append(v_fields_changed, 'term_months'); END IF;
    IF OLD.billing_frequency     IS DISTINCT FROM NEW.billing_frequency    THEN v_fields_changed := array_append(v_fields_changed, 'billing_frequency'); END IF;
    IF OLD.billing_method        IS DISTINCT FROM NEW.billing_method       THEN v_fields_changed := array_append(v_fields_changed, 'billing_method'); END IF;
    IF OLD.is_recurring          IS DISTINCT FROM NEW.is_recurring         THEN v_fields_changed := array_append(v_fields_changed, 'is_recurring'); END IF;
    IF OLD.product_id            IS DISTINCT FROM NEW.product_id           THEN v_fields_changed := array_append(v_fields_changed, 'product_id'); END IF;
    IF OLD.currency              IS DISTINCT FROM NEW.currency             THEN v_fields_changed := array_append(v_fields_changed, 'currency'); END IF;
    IF OLD.categoria             IS DISTINCT FROM NEW.categoria            THEN v_fields_changed := array_append(v_fields_changed, 'categoria'); END IF;
    IF OLD.annual_unit_price     IS DISTINCT FROM NEW.annual_unit_price    THEN v_fields_changed := array_append(v_fields_changed, 'annual_unit_price'); END IF;
    IF OLD.renewal_base_unit_price IS DISTINCT FROM NEW.renewal_base_unit_price THEN v_fields_changed := array_append(v_fields_changed, 'renewal_base_unit_price'); END IF;
    IF OLD.booking_date          IS DISTINCT FROM NEW.booking_date         THEN v_fields_changed := array_append(v_fields_changed, 'booking_date'); END IF;

    v_changed_locked := array_length(v_fields_changed, 1) > 0;

    IF v_changed_locked THEN
      IF v_old_closed AND NOT v_new_closed THEN
        v_offending := format(
          'el ítem actualmente está en período cerrado (start_date original %s <= cutoff %s)',
          OLD.start_date, v_cutoff
        );
      ELSIF v_new_closed AND NOT v_old_closed THEN
        v_offending := format(
          'la nueva start_date (%s) cae en período cerrado (cutoff %s)',
          NEW.start_date, v_cutoff
        );
      ELSE
        v_offending := format(
          'tanto la start_date original (%s) como la nueva (%s) están en período cerrado (cutoff %s)',
          OLD.start_date, NEW.start_date, v_cutoff
        );
      END IF;

      v_warn_msg := format(
        'UPDATE bloqueado: contract_item id %s campos %s — %s',
        NEW.id, array_to_string(v_fields_changed, ','), v_offending
      );

      IF v_mode = 'warn' THEN
        INSERT INTO public.period_guard_warnings(
          triggered_by, table_name, operation, contract_id, contract_item_id,
          holding_id, company_id, cutoff_date, fields_changed, message,
          payload
        ) VALUES (
          public.get_current_user_id(), 'contract_items', 'UPDATE', NEW.contract_id, NEW.id,
          v_holding, v_company, v_cutoff, v_fields_changed, v_warn_msg,
          jsonb_build_object(
            'old', to_jsonb(OLD),
            'new', to_jsonb(NEW)
          )
        );
        RETURN NEW;
      END IF;

      RAISE EXCEPTION 'No se puede modificar campos contables del ítem: %', v_offending
        USING ERRCODE = 'P0001',
              HINT = 'Reabrir el período en Configuración → Sistema → Cierre de Períodos';
    END IF;
  END IF;

  RETURN COALESCE(NEW, OLD);
END $function$;

COMMENT ON FUNCTION public."trg_period_guard_contract_items"() IS 'Guard que bloquea cambios contables en contract_items cuyo start_date cae en período cerrado de la company. Respeta GUCs sapira.period_guard_mode y sapira.bypass_period_guard.';
