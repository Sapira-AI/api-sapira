CREATE OR REPLACE FUNCTION public.populate_initial_revenue_schedule()
 RETURNS TABLE(success boolean, message text, contracts_processed integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_result RECORD;
BEGIN
    -- Check if feature is enabled
    IF NOT EXISTS (
        SELECT 1 FROM financial_settings 
        WHERE holding_id = get_current_user_holding_id() 
        AND revenue_schedule_monthly_enabled = true
    ) THEN
        RETURN QUERY SELECT false, 'Monthly revenue schedule feature not enabled', 0;
        RETURN;
    END IF;
    
    -- Rebuild all contracts for the user's holding
    SELECT * INTO v_result FROM revenue_schedule_rebuild_all();
    
    RETURN QUERY SELECT v_result.success, v_result.message, v_result.contracts_processed;
END;
$function$

