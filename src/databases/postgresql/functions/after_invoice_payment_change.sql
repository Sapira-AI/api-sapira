CREATE OR REPLACE FUNCTION public.after_invoice_payment_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Costura sapira.writer: en una transacción de la API (v2, módulo billing) este trigger no hace nada; la API recalcula el estado por pagos
  -- (Pagada solo con pagos en la moneda de la factura, nunca sobre Por Emitir, y hacia atrás al anular un pago). El front viejo nunca fija
  -- la marca: para él el trigger sigue igual. Regla: docs/reglas-desarrollo/logica-en-api-triggers.md; spec-facturacion-v2 §8.
  IF current_setting('sapira.writer', true) = 'api' THEN
    RETURN NULL;  -- AFTER: el valor de retorno se ignora
  END IF;

  IF TG_OP = 'INSERT' OR TG_OP = 'UPDATE' THEN
    PERFORM public.recalc_invoice_status(NEW.invoice_id);
  ELSIF TG_OP = 'DELETE' THEN
    PERFORM public.recalc_invoice_status(OLD.invoice_id);
  END IF;
  RETURN NULL;
END;
$function$

