CREATE OR REPLACE FUNCTION public.emit_invoice_safe(p_invoice_id uuid, p_issue_date date)
 RETURNS TABLE(success boolean, message text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_invoice_record RECORD;
  v_user_id UUID;
  v_holding_id UUID;
BEGIN
  -- Obtener ID del usuario actual
  SELECT id INTO v_user_id
  FROM public.users 
  WHERE auth_id = auth.uid();
  
  IF v_user_id IS NULL THEN
    RETURN QUERY SELECT false, 'Usuario no encontrado';
    RETURN;
  END IF;

  -- Obtener holding del usuario
  SELECT holding_id INTO v_holding_id
  FROM public.user_holdings 
  WHERE user_id = v_user_id;
  
  IF v_holding_id IS NULL THEN
    RETURN QUERY SELECT false, 'Usuario sin holding asociado';
    RETURN;
  END IF;

  -- Verificar que la factura existe
  SELECT i.*
  INTO v_invoice_record
  FROM public.invoices i
  WHERE i.id = p_invoice_id 
    AND i.holding_id = v_holding_id;
  
  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 'Factura no encontrada';
    RETURN;
  END IF;

  -- Verificar que está en estado "Por Emitir"
  IF v_invoice_record.status != 'Por Emitir' THEN
    RETURN QUERY SELECT false, 'Solo se pueden emitir facturas en estado "Por Emitir"';
    RETURN;
  END IF;

  -- Validar fecha de emisión (mismo mes que scheduled_at)
  IF date_trunc('month', p_issue_date) != date_trunc('month', v_invoice_record.scheduled_at) THEN
    RETURN QUERY SELECT false, 'La fecha de emisión debe estar en el mismo mes que la fecha programada. Use reagenda para cambiar de mes.';
    RETURN;
  END IF;

  -- Actualizar la factura
  UPDATE public.invoices 
  SET 
    status = 'Enviada',
    issue_date = p_issue_date,
    sent_at = now()
  WHERE id = p_invoice_id;

  RETURN QUERY SELECT true, 'Factura emitida exitosamente';

EXCEPTION WHEN OTHERS THEN
  RETURN QUERY SELECT false, 'Error al emitir factura: ' || SQLERRM;
END;
$function$

