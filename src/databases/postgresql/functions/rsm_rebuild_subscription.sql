CREATE OR REPLACE FUNCTION public.rsm_rebuild_subscription(p_subscription_id uuid, p_from_month date DEFAULT NULL::date)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Paso 1: Generar RSM en moneda de contrato
  PERFORM rsm_rebuild_from_subscription(p_subscription_id, p_from_month);

  -- Paso 2: Aplicar conversión FX a moneda company y sistema
  PERFORM rsm_apply_fx_for_subscription(p_subscription_id, p_from_month);
END;
$function$

