CREATE OR REPLACE FUNCTION public.trigger_revenue_schedule_update()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_contract_id uuid;
    v_affected_month date;
    v_holding_id uuid;
    v_feature_enabled boolean := false;
    v_contract_status text;
BEGIN
    IF TG_TABLE_NAME = 'invoices' THEN
        SELECT c.id, c.holding_id, c.status INTO v_contract_id, v_holding_id, v_contract_status
        FROM contracts c 
        WHERE c.id = COALESCE(NEW.contract_id, OLD.contract_id);
        
        v_affected_month := date_trunc('month', COALESCE(NEW.issue_date, OLD.issue_date));
    ELSIF TG_TABLE_NAME = 'contract_items' THEN
        v_contract_id := COALESCE(NEW.contract_id, OLD.contract_id);
        SELECT holding_id, status INTO v_holding_id, v_contract_status FROM contracts WHERE id = v_contract_id;
        
        v_affected_month := date_trunc('month', COALESCE(NEW.start_date, OLD.start_date, CURRENT_DATE));
    END IF;
    
    SELECT revenue_schedule_monthly_enabled INTO v_feature_enabled
    FROM financial_settings 
    WHERE holding_id = v_holding_id;
    
    IF v_feature_enabled AND v_contract_id IS NOT NULL AND v_contract_status = 'Activo' THEN
        PERFORM revenue_schedule_rebuild(v_contract_id, v_affected_month);
        RAISE NOTICE 'Revenue schedule updated for contract % from month %', v_contract_id, v_affected_month;
    END IF;
    
    RETURN COALESCE(NEW, OLD);
EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'Error in revenue schedule trigger: %', SQLERRM;
    RETURN COALESCE(NEW, OLD);
END;
$function$
