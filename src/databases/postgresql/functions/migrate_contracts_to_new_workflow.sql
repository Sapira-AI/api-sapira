CREATE OR REPLACE FUNCTION public.migrate_contracts_to_new_workflow()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
    contract_record RECORD;
    first_step_id UUID;
    second_step_id UUID;
    third_step_id UUID;
BEGIN
    -- Para cada contrato existente, asignar el current_step_id basado en su status actual
    FOR contract_record IN 
        SELECT id, status, holding_id FROM public.contracts 
        WHERE current_step_id IS NULL
    LOOP
        -- Obtener los primeros 3 steps del workflow para este holding
        SELECT id INTO first_step_id 
        FROM public.workflow_steps 
        WHERE holding_id = contract_record.holding_id 
        AND is_active = true 
        ORDER BY order_index LIMIT 1;
        
        SELECT id INTO second_step_id 
        FROM public.workflow_steps 
        WHERE holding_id = contract_record.holding_id 
        AND is_active = true 
        ORDER BY order_index LIMIT 1 OFFSET 1;
        
        SELECT id INTO third_step_id 
        FROM public.workflow_steps 
        WHERE holding_id = contract_record.holding_id 
        AND is_active = true 
        ORDER BY order_index LIMIT 1 OFFSET 2;
        
        -- Asignar current_step_id basado en el status actual
        UPDATE public.contracts 
        SET current_step_id = CASE 
            WHEN contract_record.status = 'En revisión' THEN first_step_id
            WHEN contract_record.status = 'Pendiente aprobación' THEN second_step_id
            WHEN contract_record.status = 'Aprobado' THEN third_step_id
            WHEN contract_record.status = 'Activo' THEN NULL -- Workflow completado
            ELSE first_step_id -- Default
        END,
        workflow_started_at = COALESCE(workflow_started_at, created_at),
        workflow_completed_at = CASE 
            WHEN contract_record.status = 'Activo' THEN now()
            ELSE NULL
        END
        WHERE id = contract_record.id;
    END LOOP;
    
    RAISE NOTICE 'Migración de contratos completada';
END;
$function$

