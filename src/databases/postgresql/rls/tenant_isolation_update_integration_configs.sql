DROP POLICY IF EXISTS "tenant_isolation_update_integration_configs" ON "public"."integration_configs";

CREATE POLICY "tenant_isolation_update_integration_configs"
ON "public"."integration_configs"
AS PERMISSIVE
FOR UPDATE
TO authenticated
USING ((holding_id = get_current_user_holding_id()));
