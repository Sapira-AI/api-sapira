CREATE OR REPLACE FUNCTION public.get_frequency_months(p_frequency text)
 RETURNS integer
 LANGUAGE plpgsql
AS $function$
BEGIN
  RETURN CASE 
    WHEN LOWER(p_frequency) IN ('mensual', 'monthly') THEN 1
    WHEN LOWER(p_frequency) IN ('trimestral', 'quarterly') THEN 3
    WHEN LOWER(p_frequency) IN ('semestral', 'semi-annual') THEN 6
    WHEN LOWER(p_frequency) IN ('anual', 'annual', 'yearly') THEN 12
    ELSE 1
  END;
END;
$function$

