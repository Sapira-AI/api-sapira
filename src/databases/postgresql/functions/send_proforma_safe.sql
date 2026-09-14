CREATE OR REPLACE FUNCTION public.send_proforma_safe(p_invoice_id uuid, p_recipient text, p_message text DEFAULT NULL::text)
 RETURNS TABLE(success boolean, message text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_invoice_record RECORD;
  v_user_id UUID;
  v_holding_id UUID;
  v_default_message TEXT;
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

  -- Mensaje por defecto
  v_default_message := 'Adjuntamos factura proforma Nº ' || COALESCE(v_invoice_record.invoice_number, 'SIN-NUM') || '. Si requiere OC, HES u otro documento de referencia, por favor envíelo para la correcta emisión.';

  -- Registrar el envío
  INSERT INTO public.invoice_emails (
    invoice_id,
    template,
    recipient,
    subject,
    message,
    sent_by,
    holding_id
  ) VALUES (
    p_invoice_id,
    'proforma',
    p_recipient,
    'Factura Proforma ' || COALESCE(v_invoice_record.invoice_number, 'SIN-NUM'),
    COALESCE(p_message, v_default_message),
    v_user_id,
    v_holding_id
  );

  RETURN QUERY SELECT true, 'Proforma enviada exitosamente';

EXCEPTION WHEN OTHERS THEN
  RETURN QUERY SELECT false, 'Error al enviar proforma: ' || SQLERRM;
END;
$function$

