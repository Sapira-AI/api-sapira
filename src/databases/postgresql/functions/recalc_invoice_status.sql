CREATE OR REPLACE FUNCTION public.recalc_invoice_status(p_invoice_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_inv public.invoices%ROWTYPE;
  v_total_paid numeric := 0;
  v_total_due  numeric := 0;
BEGIN
  SELECT *
  INTO v_inv
  FROM public.invoices
  WHERE id = p_invoice_id;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT COALESCE(SUM(amount), 0)
  INTO v_total_paid
  FROM public.invoice_payments
  WHERE invoice_id = p_invoice_id
    AND confirmed = true;

  v_total_due := COALESCE(v_inv.total_invoice_currency, v_inv.amount_invoice_currency, 0);

  IF v_total_due <= 0 THEN
    -- Factura en cero (período sin cobro): con al menos un pago confirmado
    -- (monto 0 permitido) se marca Pagada. Sin pagos registrados no se toca
    -- el estado automáticamente (comportamiento previo).
    IF EXISTS (
      SELECT 1 FROM public.invoice_payments
      WHERE invoice_id = p_invoice_id AND confirmed = true
    ) THEN
      UPDATE public.invoices
      SET status = 'Pagada'
      WHERE id = p_invoice_id AND status <> 'Pagada';
    END IF;
    RETURN;
  END IF;

  IF v_total_paid >= v_total_due THEN
    -- Pagada completamente
    UPDATE public.invoices
    SET status = 'Pagada'
    WHERE id = p_invoice_id AND status <> 'Pagada';
  ELSE
    -- No está pagada completamente. Si fue emitida:
    IF v_inv.issue_date IS NOT NULL THEN
      IF v_inv.due_date IS NOT NULL AND v_inv.due_date < CURRENT_DATE THEN
        UPDATE public.invoices
        SET status = 'Vencida'
        WHERE id = p_invoice_id AND status <> 'Pagada' AND status <> 'Vencida';
      ELSE
        UPDATE public.invoices
        SET status = 'Enviada'
        WHERE id = p_invoice_id AND status NOT IN ('Enviada', 'Pagada');
      END IF;
    END IF;
  END IF;
END;
$function$;

COMMENT ON FUNCTION public."recalc_invoice_status"(p_invoice_id uuid) IS 'Recalcula el estado de una factura según sus pagos confirmados. Facturas con total 0 (períodos sin cobro) pasan a Pagada al registrar un pago confirmado (monto 0 permitido); sin pagos, el estado no se toca automáticamente.';
