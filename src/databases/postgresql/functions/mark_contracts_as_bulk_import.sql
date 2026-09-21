CREATE OR REPLACE FUNCTION public.mark_contracts_as_bulk_import(contract_ids uuid[])
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
    UPDATE public.contracts 
    SET from_bulk_import = true 
    WHERE id = ANY(contract_ids);
END;
$function$

