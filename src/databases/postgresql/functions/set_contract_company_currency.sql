CREATE OR REPLACE FUNCTION public.set_contract_company_currency()
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

  -- Auto-populate company_currency from companies table if not provided
  IF NEW.company_currency IS NULL AND NEW.company_id IS NOT NULL THEN
    SELECT currency INTO NEW.company_currency
    FROM public.companies
    WHERE id = NEW.company_id;
  END IF;
  
  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public."set_contract_company_currency"() IS 'Trigger BEFORE INSERT/UPDATE que calcula company_currency, system_currency y sus FX rates.
CORREGIDO: Usa calculate_system_fx_rate en lugar de fx_rate_v2 (que no existe).
DIVIDE por fx_rate porque los rates están configurados como inversos (1 USD = X moneda).';
