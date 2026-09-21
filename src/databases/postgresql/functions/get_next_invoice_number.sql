CREATE OR REPLACE FUNCTION public.get_next_invoice_number(company_id_param uuid, series_param text DEFAULT 'FAC'::text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    next_number INTEGER;
    current_year INTEGER;
BEGIN
    current_year := EXTRACT(YEAR FROM CURRENT_DATE);
    
    -- Obtener el siguiente número para este año, compañía y serie
    SELECT COALESCE(MAX(CAST(SUBSTRING(invoice_number FROM '[0-9]+$') AS INTEGER)), 0) + 1
    INTO next_number
    FROM public.invoices 
    WHERE company_id = company_id_param 
    AND invoice_series = series_param
    AND invoice_number LIKE series_param || '-' || current_year || '-%';
    
    RETURN series_param || '-' || current_year || '-' || LPAD(next_number::text, 4, '0');
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_next_invoice_number(company_id_param uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    company_prefix TEXT;
    next_number INTEGER;
    current_year INTEGER;
BEGIN
    -- Obtener prefijo de la compañía
    SELECT invoice_prefix INTO company_prefix 
    FROM public.companies 
    WHERE id = company_id_param;
    
    IF company_prefix IS NULL THEN
        company_prefix := 'FAC-';
    END IF;
    
    current_year := EXTRACT(YEAR FROM CURRENT_DATE);
    
    -- Obtener el siguiente número para este año y compañía
    SELECT COALESCE(MAX(CAST(SUBSTRING(invoice_number FROM '[0-9]+$') AS INTEGER)), 0) + 1
    INTO next_number
    FROM public.invoices 
    WHERE company_id = company_id_param 
    AND invoice_number LIKE company_prefix || current_year || '-%';
    
    RETURN company_prefix || current_year || '-' || LPAD(next_number::text, 4, '0');
END;
$function$
