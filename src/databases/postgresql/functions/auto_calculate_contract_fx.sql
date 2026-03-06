CREATE OR REPLACE FUNCTION public.auto_calculate_contract_fx()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_result RECORD;
    v_should_calculate BOOLEAN := false;
BEGIN
    -- Determinar si debemos calcular FX
    IF TG_OP = 'INSERT' THEN
        -- En INSERT, solo calcular si el contrato ya viene en estado Firmado/Activo
        IF NEW.status IN ('Firmado', 'Activo') THEN
            v_should_calculate := true;
        END IF;
    ELSIF TG_OP = 'UPDATE' THEN
        -- En UPDATE, calcular si:
        -- 1. El estado cambió a Firmado o Activo
        IF (OLD.status NOT IN ('Firmado', 'Activo') AND NEW.status IN ('Firmado', 'Activo')) THEN
            v_should_calculate := true;
        -- 2. O si YA está en Firmado/Activo y cambiaron campos relevantes
        ELSIF NEW.status IN ('Firmado', 'Activo') AND (
            OLD.total_value IS DISTINCT FROM NEW.total_value OR
            OLD.contract_currency IS DISTINCT FROM NEW.contract_currency OR
            OLD.booking_date IS DISTINCT FROM NEW.booking_date
        ) THEN
            v_should_calculate := true;
        END IF;
    END IF;
    
    -- Solo ejecutar cálculo si se cumplieron las condiciones
    IF v_should_calculate THEN
        SELECT * INTO v_result FROM public.calculate_contract_fx_amounts(NEW.id);
        
        IF NOT v_result.success THEN
            RAISE WARNING 'Failed to calculate FX amounts for contract %: %', NEW.id, v_result.message;
        END IF;
    END IF;
    
    RETURN NEW;
END;
$function$;
