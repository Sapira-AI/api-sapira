DROP POLICY IF EXISTS "tenant_isolation_insert_agents" ON "public"."agents";

CREATE POLICY "tenant_isolation_insert_agents"
ON "public"."agents"
AS PERMISSIVE
FOR INSERT
TO authenticated
WITH CHECK ((holding_id = get_current_user_holding_id()));
