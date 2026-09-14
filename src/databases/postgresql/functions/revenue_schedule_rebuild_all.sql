CREATE OR REPLACE FUNCTION public.revenue_schedule_rebuild_all()
 RETURNS TABLE(total_contracts integer, success_count integer, error_count integer, message text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_contract_id uuid;
  v_success integer := 0;
  v_error integer := 0;
  v_total integer := 0;
  v_error_msg text;
BEGIN
  RAISE NOTICE '🚀 Starting revenue_schedule_rebuild_all()';

  FOR v_contract_id IN
    SELECT c.id
    FROM contracts c
    WHERE c.status = 'Activo'
    ORDER BY c.id
  LOOP
    v_total := v_total + 1;
    
    BEGIN
      PERFORM revenue_schedule_rebuild(v_contract_id);
      v_success := v_success + 1;
    EXCEPTION WHEN OTHERS THEN
      v_error := v_error + 1;
      v_error_msg := SQLERRM;
      RAISE NOTICE '❌ Error processing contract %: %', v_contract_id, v_error_msg;
    END;
  END LOOP;

  RAISE NOTICE '✅ Completed: % total, % success, % errors', v_total, v_success, v_error;

  RETURN QUERY SELECT v_total, v_success, v_error, 
    format('Processed %s contracts: %s succeeded, %s failed', v_total, v_success, v_error);
END;
$function$

