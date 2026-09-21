CREATE OR REPLACE FUNCTION public.detect_invoice_line_changes(new_data jsonb, old_data jsonb, relevant_fields text[] DEFAULT ARRAY['name'::text, 'quantity'::text, 'price_unit'::text, 'price_subtotal'::text])
 RETURNS boolean
 LANGUAGE plpgsql
AS $function$
DECLARE
    field TEXT;
BEGIN
    -- Si no hay datos anteriores, siempre hay cambios
    IF old_data IS NULL THEN
        RETURN TRUE;
    END IF;
    
    -- Comparar cada campo relevante
    FOREACH field IN ARRAY relevant_fields
    LOOP
        IF (new_data ->> field) IS DISTINCT FROM (old_data ->> field) THEN
            RETURN TRUE;
        END IF;
    END LOOP;
    
    RETURN FALSE;
END;
$function$

