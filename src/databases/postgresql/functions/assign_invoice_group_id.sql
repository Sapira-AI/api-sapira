CREATE OR REPLACE FUNCTION public.assign_invoice_group_id()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  -- Costura sapira.writer: en una transacción de la API (v2) este trigger no hace nada; la API escribe cada campo.
  -- El front viejo nunca fija la marca: para él el trigger sigue igual. Regla: docs/reglas-desarrollo/logica-en-api-triggers.md
  IF current_setting('sapira.writer', true) = 'api' THEN
    RETURN NEW;
  END IF;

  -- Si es una nota de crédito, usar el group_id de la factura relacionada
  IF NEW.document_type = 'NC' AND NEW.related_invoice_id IS NOT NULL THEN -- Cambio: usar document_type
    SELECT COALESCE(invoice_group_id, id) INTO NEW.invoice_group_id
    FROM public.invoices
    WHERE id = NEW.related_invoice_id;
  -- Si es una factura nueva sin group_id, usar su propio id
  ELSIF NEW.invoice_group_id IS NULL THEN
    NEW.invoice_group_id := NEW.id;
  END IF;
  
  RETURN NEW;
END;
$function$

