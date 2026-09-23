CREATE OR REPLACE FUNCTION public.get_table_columns(table_name text, schema_name text DEFAULT 'public'::text)
 RETURNS TABLE(column_name text, data_type text, is_nullable text, column_default text, character_maximum_length integer)
 LANGUAGE sql
 SECURITY DEFINER
AS $function$
  SELECT 
    c.column_name::TEXT,
    c.data_type::TEXT,
    c.is_nullable::TEXT,
    c.column_default::TEXT,
    c.character_maximum_length
  FROM information_schema.columns c
  WHERE c.table_name = $1 
    AND c.table_schema = $2
  ORDER BY c.ordinal_position;
$function$;

COMMENT ON FUNCTION public."get_table_columns"(table_name text, schema_name text) IS 'Obtiene dinámicamente las columnas de una tabla específica. Usado para mapeo de campos en integraciones.';
