# Políticas RLS (Row Level Security)

Esta carpeta contiene las políticas de seguridad a nivel de fila (RLS) de PostgreSQL.

Los archivos SQL en esta carpeta son generados automáticamente por el servicio `DatabaseGeneratorService`.

## Estructura

Cada archivo contiene una política RLS individual con el formato:

```sql
DROP POLICY IF EXISTS "policy_name" ON "schema"."table";

CREATE POLICY "policy_name"
ON "schema"."table"
AS PERMISSIVE
FOR SELECT
TO public
USING (condition)
WITH CHECK (condition);
```

## Generación Automática

Para generar/actualizar las políticas RLS de una tabla:

```bash
POST /database/generate-from-table
{
  "table_name": "contracts",
  "schema_name": "public"
}
```

Para generar todas las políticas de todas las tablas:

```bash
POST /database/generate-all-tables
{
  "schema_name": "public"
}
```
