CREATE OR REPLACE FUNCTION public.revenue_schedule_rebuild(p_contract_id uuid, p_from_month date DEFAULT NULL::date)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Step 1: Calcular en moneda de contrato
  PERFORM public.revenue_schedule_rebuild_contract_ccy(p_contract_id, p_from_month);

  -- Step 2: Aplicar FX
  PERFORM public.revenue_schedule_apply_fx_for_contract(p_contract_id, p_from_month);

  -- Step 3 (01-10, D19): el rebuild borra las filas del contrato, incluida la cola PENDING_RENEWAL que escribe
  -- apply_pending_renewal_tail; hasta hoy esa cola solo volvía con el cron de las 06:00 (refresh-pending-renewals) o con el trigger
  -- de ítems, así que "Por renovar" quedaba en 0 el resto del día tras cualquier rebuild (v2 lo llama en cada cambio, consumo o
  -- edición de factura). Se regenera aquí mismo: idempotente y ya aplica su propio FX.
  PERFORM public.apply_pending_renewal_tail(p_contract_id);
END;
$function$;

COMMENT ON FUNCTION public."revenue_schedule_rebuild"(p_contract_id uuid, p_from_month date) IS 'Wrapper: rebuild en moneda de contrato → FX → cola PENDING_RENEWAL (apply_pending_renewal_tail, 01-10: antes la cola solo volvía con el cron de las 06:00 y Por renovar quedaba en 0 tras cada rebuild). Compatible with existing triggers (p_from_month defaults to NULL for full rebuild).';
