CREATE OR REPLACE FUNCTION public.admin_populate_revenue_schedule(p_holding_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
    v_contract_record RECORD;
    v_result jsonb;
    v_total_contracts integer := 0;
    v_total_months integer := 0;
    v_final_result jsonb := '{"success": true, "message": "Population completed", "contracts_processed": 0, "total_months": 0}';
BEGIN
    -- Procesar todos los contratos del holding
    FOR v_contract_record IN
        SELECT c.id, c.contract_number, c.status
        FROM contracts c
        WHERE c.holding_id = p_holding_id
        AND c.status IN ('Activo', 'Aprobado')
        ORDER BY c.created_at
    LOOP
        -- Rebuild schedule para cada contrato
        SELECT * INTO v_result FROM public.revenue_schedule_rebuild(v_contract_record.id);
        
        v_total_contracts := v_total_contracts + 1;
        v_total_months := v_total_months + COALESCE((v_result->>'months_processed')::integer, 0);
        
        RAISE NOTICE 'Processed contract %: % months', v_contract_record.contract_number, (v_result->>'months_processed');
    END LOOP;
    
    -- Actualizar resultado final
    v_final_result := jsonb_set(v_final_result, '{contracts_processed}', to_jsonb(v_total_contracts));
    v_final_result := jsonb_set(v_final_result, '{total_months}', to_jsonb(v_total_months));
    
    RETURN v_final_result;
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object(
        'success', false,
        'message', 'Error in admin population: ' || SQLERRM,
        'contracts_processed', v_total_contracts,
        'total_months', v_total_months
    );
END;
$function$

