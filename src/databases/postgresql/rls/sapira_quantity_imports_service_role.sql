DROP POLICY IF EXISTS "sapira_quantity_imports_service_role" ON "public"."sapira_quantity_imports";

CREATE POLICY "sapira_quantity_imports_service_role"
ON "public"."sapira_quantity_imports"
AS PERMISSIVE
FOR ALL
TO service_role
USING (true)
WITH CHECK (true);
