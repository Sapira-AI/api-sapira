DROP POLICY IF EXISTS "tenant_isolation_insert_wsd" ON "public"."workflow_step_documents";

CREATE POLICY "tenant_isolation_insert_wsd"
ON "public"."workflow_step_documents"
AS PERMISSIVE
FOR INSERT
TO public
WITH CHECK ((holding_id = get_current_user_holding_id()));
