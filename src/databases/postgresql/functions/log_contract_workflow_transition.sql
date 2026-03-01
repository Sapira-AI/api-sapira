CREATE OR REPLACE FUNCTION public.log_contract_workflow_transition()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
BEGIN
  -- Only log when current_step_id actually changes
  IF OLD.current_step_id IS DISTINCT FROM NEW.current_step_id THEN
    INSERT INTO contract_workflow_history (
      contract_id,
      workflow_step_id,
      status,
      comments,
      transition_type,
      metadata,
      user_id,
      created_at
    ) VALUES (
      NEW.id,
      -- Use OLD.current_step_id when NEW.current_step_id is NULL (workflow completion)
      COALESCE(NEW.current_step_id, OLD.current_step_id),
      CASE 
        WHEN NEW.current_step_id IS NULL THEN 'completed'
        ELSE 'pending'
      END,
      CASE 
        WHEN NEW.current_step_id IS NULL THEN 'Workflow completado automáticamente'
        ELSE 'Transición automática de workflow'
      END,
      'automatic',
      jsonb_build_object(
        'timestamp', NOW(),
        'previous_step_id', OLD.current_step_id,
        'new_step_id', NEW.current_step_id,
        'contract_status', NEW.status
      ),
      get_current_user_id(),
      NOW()
    );
  END IF;
  
  RETURN NEW;
END;
$function$;
