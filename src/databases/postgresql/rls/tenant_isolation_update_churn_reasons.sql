DROP POLICY IF EXISTS "tenant_isolation_update_churn_reasons" ON "public"."churn_reasons";

CREATE POLICY "tenant_isolation_update_churn_reasons"
ON "public"."churn_reasons"
AS PERMISSIVE
FOR UPDATE
TO public
USING ((holding_id = get_current_user_holding_id()));
