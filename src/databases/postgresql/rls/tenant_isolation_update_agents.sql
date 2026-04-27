DROP POLICY IF EXISTS "tenant_isolation_update_agents" ON "public"."agents";

CREATE POLICY "tenant_isolation_update_agents"
ON "public"."agents"
AS PERMISSIVE
FOR UPDATE
TO authenticated
USING ((holding_id = get_current_user_holding_id()));
