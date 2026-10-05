CREATE OR REPLACE FUNCTION public.update_contract_term()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  -- Costura sapira.writer: en una transacción de la API (v2) este trigger no hace nada; la API escribe cada campo.
  -- El front viejo nunca fija la marca: para él el trigger sigue igual. Regla: docs/reglas-desarrollo/logica-en-api-triggers.md
  IF current_setting('sapira.writer', true) = 'api' THEN
    RETURN NULL;  -- AFTER: el valor de retorno se ignora
  END IF;

  -- Actualizar el term del contrato con el MAX de term_months de sus items
  UPDATE public.contracts
  SET term = (
    SELECT MAX(term_months)
    FROM public.contract_items
    WHERE contract_id = COALESCE(NEW.contract_id, OLD.contract_id)
  )
  WHERE id = COALESCE(NEW.contract_id, OLD.contract_id);
  
  RETURN NEW;
END;
$function$

