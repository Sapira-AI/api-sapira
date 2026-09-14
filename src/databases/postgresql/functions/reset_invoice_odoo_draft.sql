CREATE OR REPLACE FUNCTION public.reset_invoice_odoo_draft(p_invoice_id uuid)
 RETURNS TABLE(success boolean, message text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_user_id UUID;
  v_invoice RECORD;
BEGIN
  SELECT id INTO v_user_id FROM public.users WHERE auth_id = auth.uid();
  IF v_user_id IS NULL THEN
    RETURN QUERY SELECT false, 'Usuario no encontrado';
    RETURN;
  END IF;

  SELECT i.* INTO v_invoice
  FROM public.invoices i
  WHERE i.id = p_invoice_id
    AND i.holding_id IN (SELECT holding_id FROM public.user_holdings WHERE user_id = v_user_id);

  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 'Factura no encontrada';
    RETURN;
  END IF;

  IF v_invoice.status <> 'Por Emitir' THEN
    RETURN QUERY SELECT false, 'Solo se pueden reestablecer facturas en estado "Por Emitir"';
    RETURN;
  END IF;

  IF v_invoice.sent_to_odoo_at IS NULL AND v_invoice.odoo_invoice_id IS NULL THEN
    RETURN QUERY SELECT false, 'Esta factura no está vinculada al ERP';
    RETURN;
  END IF;

  UPDATE public.invoices
  SET odoo_invoice_id = NULL,
      sent_to_odoo_at = NULL,
      sent_at = NULL
  WHERE id = p_invoice_id;

  RETURN QUERY SELECT true, 'Factura reestablecida correctamente';

EXCEPTION WHEN OTHERS THEN
  RETURN QUERY SELECT false, 'Error al reestablecer factura: ' || SQLERRM;
END;
$function$

