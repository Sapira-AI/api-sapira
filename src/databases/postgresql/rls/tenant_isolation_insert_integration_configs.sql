DROP POLICY IF EXISTS "tenant_isolation_insert_integration_configs" ON "public"."integration_configs";

CREATE POLICY "tenant_isolation_insert_integration_configs"
ON "public"."integration_configs"
AS PERMISSIVE
FOR INSERT
TO authenticated
WITH CHECK ((holding_id = get_current_user_holding_id()));
