CREATE OR REPLACE FUNCTION public.inherit_auto_renew_from_quote_item()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_quote_item RECORD;
BEGIN
  -- Costura sapira.writer: en una transacción de la API (v2) este trigger no hace nada; la API escribe cada campo.
  -- El front viejo nunca fija la marca: para él el trigger sigue igual. Regla: docs/reglas-desarrollo/logica-en-api-triggers.md
  IF current_setting('sapira.writer', true) = 'api' THEN
    RETURN NEW;
  END IF;

  -- Si el contract_item tiene quote_item_id, heredar configuración de auto_renew
  IF NEW.quote_item_id IS NOT NULL THEN
    SELECT auto_renew, auto_renew_term_months
    INTO v_quote_item
    FROM public.quote_items
    WHERE id = NEW.quote_item_id;
    
    IF FOUND THEN
      -- Heredar solo si no se especificó explícitamente en el contract_item
      IF NEW.auto_renew IS NULL OR NEW.auto_renew = false THEN
        NEW.auto_renew := COALESCE(v_quote_item.auto_renew, false);
      END IF;
      
      IF NEW.auto_renew_term_months IS NULL THEN
        NEW.auto_renew_term_months := v_quote_item.auto_renew_term_months;
      END IF;
    END IF;
  END IF;
  
  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public."inherit_auto_renew_from_quote_item"() IS 'Hereda automáticamente la configuración de auto_renew desde quote_items cuando se crea un contract_item';
