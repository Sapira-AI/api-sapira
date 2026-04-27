DROP POLICY IF EXISTS "tenant_isolation_select_wsd" ON "public"."workflow_step_documents";

CREATE POLICY "tenant_isolation_select_wsd"
ON "public"."workflow_step_documents"
AS PERMISSIVE
FOR SELECT
TO public
USING ((holding_id = get_current_user_holding_id()));
