DROP POLICY IF EXISTS "sapira_quantity_imports_select" ON "public"."sapira_quantity_imports";

CREATE POLICY "sapira_quantity_imports_select"
ON "public"."sapira_quantity_imports"
AS PERMISSIVE
FOR SELECT
TO public
USING ((holding_id = get_current_user_holding_id()));
