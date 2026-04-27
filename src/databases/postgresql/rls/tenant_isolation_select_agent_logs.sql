DROP POLICY IF EXISTS "tenant_isolation_select_agent_logs" ON "public"."agent_logs";

CREATE POLICY "tenant_isolation_select_agent_logs"
ON "public"."agent_logs"
AS PERMISSIVE
FOR SELECT
TO authenticated
USING ((holding_id = get_current_user_holding_id()));
