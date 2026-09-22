CREATE OR REPLACE FUNCTION public.validate_invoice_status_for_quantity_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_contract_item_id uuid;
  v_period           date;
  v_blocking         RECORD;
BEGIN
  -- Bypass controlado (solo lo activa adjust_issued_invoice dentro de su
  -- transacción: la línea de la factura queda con la misma cantidad que el
  -- override, la consistencia que este guard protege se cumple por construcción)
  IF current_setting('sapira.bypass_quantity_invoice_guard', true) = 'on' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    v_contract_item_id := OLD.contract_item_id;
    v_period           := OLD.period;
  ELSE
    v_contract_item_id := NEW.contract_item_id;
    v_period           := NEW.period;
  END IF;

  IF v_contract_item_id IS NULL OR v_period IS NULL THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;

  -- Buscar CUALQUIER factura ACTIVA del mismo mes calendario que NO esté
  -- en estado "Por Emitir". Si existe al menos una así, bloquea la operación.
  -- Solo se consideran facturas is_active=true: las inactivas (consolidadas,
  -- reestructuradas) son históricas y no son la factura "real" del período.
  -- Las CANCELADAS tampoco bloquean (Tanda 1, 2026-08-28): una factura
  -- anulada del período no es razón para impedir corregir el override —
  -- bloquearla rompía el flujo NC → corregir cantidades → refacturar.
  -- Si solo existen inactivas/canceladas o si todas las activas son
  -- "Por Emitir", la operación procede.
  SELECT i.status, i.invoice_number
  INTO v_blocking
  FROM public.invoice_items ii
  JOIN public.invoices i ON i.id = ii.invoice_id
  WHERE ii.contract_item_id = v_contract_item_id
    AND ii.billing_period_start IS NOT NULL
    AND v_period = date_trunc('month', ii.billing_period_start)::date
    AND i.is_active = true
    AND i.status NOT IN ('Por Emitir', 'Cancelada')
  LIMIT 1;

  -- Si no encontró factura bloqueante (o no existe factura aún del período,
  -- caso pre-activación) → permite la operación.
  IF NOT FOUND THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;

  RAISE EXCEPTION
    'No se puede modificar el override del período %: la factura % está en estado "%". Anula la factura primero para que vuelva a "Por Emitir".',
    to_char(v_period, 'YYYY-MM'),
    COALESCE(v_blocking.invoice_number, '(sin número)'),
    v_blocking.status
    USING ERRCODE = 'P0001';
END;
$function$;

COMMENT ON FUNCTION public."validate_invoice_status_for_quantity_change"() IS 'Trigger BEFORE INSERT/UPDATE/DELETE en quantities. Bloquea la operación si
la factura del mismo mes calendario que el período del override no está en
estado "Por Emitir". Permite la operación si no existe factura asociada al
período (caso pre-activación de contrato). Bypass controlado vía GUC
sapira.bypass_quantity_invoice_guard (usado por adjust_issued_invoice).';
