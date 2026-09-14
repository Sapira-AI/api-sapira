CREATE OR REPLACE FUNCTION public.validate_custom_fields(p_entity_type text, p_holding_id uuid, p_custom_fields jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  field_def RECORD;
  field_value TEXT;
BEGIN
  -- Iterar sobre cada definición de campo requerido
  FOR field_def IN
    SELECT field_name, field_label, is_required
    FROM public.custom_field_definitions
    WHERE holding_id = p_holding_id
      AND entity_type = p_entity_type
      AND is_active = true
      AND is_required = true
  LOOP
    -- Verificar si el campo requerido existe y no es nulo/vacío
    field_value := p_custom_fields->>field_def.field_name;

    IF field_value IS NULL OR TRIM(field_value) = '' THEN
      RAISE EXCEPTION 'El campo "%" es requerido', field_def.field_label;
    END IF;
  END LOOP;

  RETURN true;
END;
$function$

