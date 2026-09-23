CREATE OR REPLACE FUNCTION public.reconcile_contract_status(p_contract_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_msg text := 'Sin cambios';
  v_updated boolean := false;
BEGIN
  -- Si hay un churn aplicado, marcar como Terminado
  IF EXISTS (
    SELECT 1 FROM public.contract_lifecycle_events 
    WHERE contract_id = p_contract_id 
      AND event_type IN ('CHURN','CHURN_APPLIED')
  ) THEN
    UPDATE public.contracts SET status = 'Terminado' 
    WHERE id = p_contract_id AND status IS DISTINCT FROM 'Terminado';
    v_updated := FOUND;
    v_msg := 'Estado reconciliado a Terminado';
  ELSIF EXISTS (
    SELECT 1 FROM public.contract_lifecycle_events 
    WHERE contract_id = p_contract_id 
      AND event_type IN ('RENEWAL_APPLIED','SIGNED','ACTIVATION','activate','signed')
  ) THEN
    UPDATE public.contracts SET status = 'Activo' 
    WHERE id = p_contract_id AND status IS DISTINCT FROM 'Activo';
    v_updated := FOUND;
    v_msg := 'Estado reconciliado a Activo';
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'updated', v_updated,
    'message', v_msg,
    'contract_id', p_contract_id
  );
END;
$function$;

COMMENT ON FUNCTION public."reconcile_contract_status"(p_contract_id uuid) IS 'Revisa eventos del ciclo de vida y ajusta el status del contrato cuando corresponde. Devuelve JSON con el resultado.';
