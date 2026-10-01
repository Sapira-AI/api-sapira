CREATE OR REPLACE FUNCTION public.validate_contract_currency_consistency()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
BEGIN
  IF current_setting('sapira.skip_currency_validation', true) = 'on' THEN RETURN NEW; END IF;
  -- Multimoneda (spec-multimoneda-contrato §3 #3): con el flag los ítems pueden estar en otra moneda; no se apaga con ítems en otra moneda.
  IF COALESCE(NEW.requires_multicurrency_billing, false) THEN RETURN NEW; END IF;
  IF EXISTS (SELECT 1 FROM public.contract_items ci
    WHERE ci.contract_id = NEW.id AND ci.currency IS DISTINCT FROM NEW.contract_currency) THEN
    IF TG_OP = 'UPDATE' THEN
      IF COALESCE(OLD.requires_multicurrency_billing, false) THEN
        RAISE EXCEPTION 'No se puede desactivar multimoneda: hay ítems en otra moneda';
      END IF;
    END IF;
    RAISE EXCEPTION 'Contract currency (%) must match all contract items currency', NEW.contract_currency;
  END IF;
  RETURN NEW;
END; $function$
