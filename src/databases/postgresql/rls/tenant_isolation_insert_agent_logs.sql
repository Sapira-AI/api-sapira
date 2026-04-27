DROP POLICY IF EXISTS "tenant_isolation_insert_agent_logs" ON "public"."agent_logs";

CREATE POLICY "tenant_isolation_insert_agent_logs"
ON "public"."agent_logs"
AS PERMISSIVE
FOR INSERT
TO authenticated
WITH CHECK ((holding_id = get_current_user_holding_id()));
