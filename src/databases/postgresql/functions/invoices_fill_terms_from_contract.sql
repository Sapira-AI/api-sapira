CREATE OR REPLACE FUNCTION public.invoices_fill_terms_from_contract()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Costura sapira.writer: en una transacción de la API (v2) este trigger no hace nada; la API escribe cada campo.
  -- El front viejo nunca fija la marca: para él el trigger sigue igual. Regla: docs/reglas-desarrollo/logica-en-api-triggers.md
  IF current_setting('sapira.writer', true) = 'api' THEN
    RETURN NEW;
  END IF;

  IF NEW.invoice_terms_and_conditions IS NULL AND NEW.contract_id IS NOT NULL THEN
    SELECT invoice_terms_and_conditions
      INTO NEW.invoice_terms_and_conditions
    FROM contracts
    WHERE id = NEW.contract_id;
  END IF;
  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public."invoices_fill_terms_from_contract"() IS 'Copia contracts.invoice_terms_and_conditions a invoices.invoice_terms_and_conditions si este viene NULL. Permite override explícito al insertar.';
