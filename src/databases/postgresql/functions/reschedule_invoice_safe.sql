CREATE OR REPLACE FUNCTION public.reschedule_invoice_safe(p_invoice_id uuid, p_new_date date, p_reason text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_invoice_record RECORD;
  v_user_id UUID;
  v_holding_id UUID;
  v_old_date DATE;
BEGIN
  -- Obtener ID del usuario actual
  SELECT id INTO v_user_id
  FROM public.users 
  WHERE auth_id = auth.uid();
  
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Usuario no encontrado';
  END IF;

  -- Obtener holding del usuario
  SELECT holding_id INTO v_holding_id
  FROM public.user_holdings 
  WHERE user_id = v_user_id;
  
  IF v_holding_id IS NULL THEN
    RAISE EXCEPTION 'Usuario sin holding asociado';
  END IF;

  -- Verificar que la factura existe y pertenece al holding del usuario
  SELECT i.*, i.scheduled_at as current_scheduled_at
  INTO v_invoice_record
  FROM public.invoices i
  WHERE i.id = p_invoice_id 
    AND i.holding_id = v_holding_id;
  
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Factura no encontrada o sin permisos';
  END IF;

  -- Verificar que la factura está en estado "Por Emitir"
  IF v_invoice_record.status != 'Por Emitir' THEN
    RAISE EXCEPTION 'Solo se pueden reagendar facturas en estado "Por Emitir"';
  END IF;

  -- Verificar que la nueva fecha no es anterior a hoy
  IF p_new_date < CURRENT_DATE THEN
    RAISE EXCEPTION 'La nueva fecha no puede ser anterior a hoy';
  END IF;

  -- Verificar que el motivo no está vacío
  IF TRIM(p_reason) = '' OR LENGTH(TRIM(p_reason)) < 10 THEN
    RAISE EXCEPTION 'El motivo debe tener al menos 10 caracteres';
  END IF;

  -- Guardar fecha actual para el historial
  v_old_date := v_invoice_record.current_scheduled_at;

  -- Solo proceder si la fecha realmente cambió
  IF v_old_date = p_new_date THEN
    RAISE EXCEPTION 'La nueva fecha debe ser diferente a la actual';
  END IF;

  -- Insertar en historial de reagendados
  INSERT INTO public.invoice_reschedules (
    invoice_id,
    holding_id,
    old_date,
    new_date,
    reason,
    changed_by
  ) VALUES (
    p_invoice_id,
    v_holding_id,
    v_old_date,
    p_new_date,
    TRIM(p_reason),
    v_user_id
  );

  -- Actualizar la fecha programada en la factura
  UPDATE public.invoices 
  SET scheduled_at = p_new_date
  WHERE id = p_invoice_id;

  RETURN TRUE;

EXCEPTION WHEN OTHERS THEN
  RAISE EXCEPTION 'Error al reagendar factura: %', SQLERRM;
END;
$function$

