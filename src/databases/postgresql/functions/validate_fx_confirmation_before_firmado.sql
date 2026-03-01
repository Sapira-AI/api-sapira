CREATE OR REPLACE FUNCTION public.validate_fx_confirmation_before_firmado()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  -- Solo validar si el contrato está cambiando a estado 'Firmado'
  IF NEW.status = 'Firmado' AND (OLD.status IS NULL OR OLD.status != 'Firmado') THEN
    -- Validar que fx_company_confirmed_at esté establecido
    IF NEW.fx_company_confirmed_at IS NULL THEN
      RAISE EXCEPTION 'Debe confirmar la política FX de Compañía antes de firmar el contrato';
    END IF;
    
    -- Validar que fx_invoice_confirmed_at esté establecido
    IF NEW.fx_invoice_confirmed_at IS NULL THEN
      RAISE EXCEPTION 'Debe confirmar la política FX de Facturación antes de firmar el contrato';
    END IF;
  END IF;
  
  RETURN NEW;
END;
$function$;
