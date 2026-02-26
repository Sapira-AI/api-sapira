CREATE OR REPLACE FUNCTION public.auto_populate_invoice_tax_rate()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_company_tax_rate NUMERIC;
BEGIN
  -- Solo procesar si el invoice tiene company_id y tax_rate está vacío
  IF NEW.company_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Si tax_rate ya está definido, no sobrescribir
  IF NEW.tax_rate IS NOT NULL THEN
    RETURN NEW;
  END IF;

  -- Obtener tax_rate de la company
  SELECT tax_rate INTO v_company_tax_rate
  FROM public.companies
  WHERE id = NEW.company_id;

  -- Asignar tax_rate (default 0.19 si no existe en company)
  NEW.tax_rate := COALESCE(v_company_tax_rate, 0.19);

  RETURN NEW;
END;
$function$
