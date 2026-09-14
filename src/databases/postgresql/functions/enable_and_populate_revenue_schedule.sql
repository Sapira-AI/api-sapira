CREATE OR REPLACE FUNCTION public.enable_and_populate_revenue_schedule()
 RETURNS TABLE(success boolean, message text, contracts_processed integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_holding_id uuid;
    v_result RECORD;
BEGIN
    -- Get user's holding
    v_holding_id := get_current_user_holding_id();
    
    IF v_holding_id IS NULL THEN
        RETURN QUERY SELECT false, 'No holding found for current user', 0;
        RETURN;
    END IF;
    
    -- Enable the feature
    INSERT INTO financial_settings (holding_id, revenue_schedule_monthly_enabled) 
    VALUES (v_holding_id, true)
    ON CONFLICT (holding_id) 
    DO UPDATE SET revenue_schedule_monthly_enabled = true;
    
    -- Populate the schedule
    SELECT * INTO v_result FROM revenue_schedule_rebuild_all();
    
    RETURN QUERY SELECT v_result.success, v_result.message, v_result.contracts_processed;
END;
$function$

