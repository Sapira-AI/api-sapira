CREATE OR REPLACE FUNCTION public.auto_populate_invoice_tax_rate()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_company_tax_rate NUMERIC;
BEGIN
  IF NEW.company_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.tax_rate IS NOT NULL THEN
    RETURN NEW;
  END IF;

  SELECT tax_rate INTO v_company_tax_rate
  FROM public.companies
  WHERE id = NEW.company_id;

  IF v_company_tax_rate IS NULL THEN
    RAISE EXCEPTION 'TAX_RATE_NOT_CONFIGURED: La empresa no tiene configurada una tasa de impuesto (tax_rate). Configure el impuesto en la empresa antes de crear facturas.'
      USING ERRCODE = 'P0001';
  END IF;

  NEW.tax_rate := v_company_tax_rate;

  RETURN NEW;
END;
$$;
