CREATE OR REPLACE FUNCTION public.months_between_dates(p_end date, p_start date)
 RETURNS integer
 LANGUAGE sql
 IMMUTABLE
AS $function$
  SELECT (EXTRACT(YEAR FROM age(p_end, p_start)) * 12
        + EXTRACT(MONTH FROM age(p_end, p_start)))::int;
$function$

