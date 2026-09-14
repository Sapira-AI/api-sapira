CREATE OR REPLACE FUNCTION public.get_contract_holding(p_contract_id uuid)
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
    SELECT holding_id FROM contracts WHERE id = p_contract_id;
$function$

