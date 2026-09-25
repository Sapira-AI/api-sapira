CREATE OR REPLACE FUNCTION public.refresh_all_pending_renewals()
 RETURNS TABLE(contracts_processed integer, rows_upserted integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_contract_id uuid; v_count int := 0; v_rows int := 0; v_result jsonb;
BEGIN
  FOR v_contract_id IN
    SELECT DISTINCT ci.contract_id FROM public.contract_items ci
     WHERE COALESCE(ci.is_recurring, false) = TRUE
       AND ci.end_date IS NOT NULL
       AND ci.end_date < DATE_TRUNC('month', CURRENT_DATE)::date
       AND ci.renewed_by_item_id IS NULL AND ci.churn_date IS NULL
       AND COALESCE(ci.term_months, 0) > 0
       AND COALESCE(ci.categoria, '') NOT IN ('DOWNSELL', 'CHURN')
  LOOP
    BEGIN v_result := public.apply_pending_renewal_tail(v_contract_id);
      v_count := v_count + 1;
      v_rows  := v_rows + COALESCE((v_result->>'rows_upserted')::int, 0);
    EXCEPTION WHEN OTHERS THEN RAISE WARNING 'refresh_all_pending_renewals: falló contract %: %', v_contract_id, SQLERRM; END;
  END LOOP;
  RETURN QUERY SELECT v_count, v_rows;
END; $function$;

COMMENT ON FUNCTION public."refresh_all_pending_renewals"() IS 'Itera contratos con items en limbo (categoria NOT IN DOWNSELL/CHURN) y ejecuta apply_pending_renewal_tail. v1.2. Usado por pg_cron diario (refresh-pending-renewals).';
