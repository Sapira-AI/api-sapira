CREATE OR REPLACE FUNCTION public.get_custom_field_definitions(p_entity_type text, p_holding_id uuid)
 RETURNS SETOF custom_field_definitions
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT *
  FROM public.custom_field_definitions
  WHERE holding_id = p_holding_id
    AND entity_type = p_entity_type
    AND is_active = true
  ORDER BY display_order, created_at;
$function$;

COMMENT ON FUNCTION public."get_custom_field_definitions"(p_entity_type text, p_holding_id uuid) IS 'Obtiene las definiciones de campos personalizados activos para una entidad y holding específicos';
