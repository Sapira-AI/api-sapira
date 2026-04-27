DROP POLICY IF EXISTS "tenant_isolation_insert_churn_reasons" ON "public"."churn_reasons";

CREATE POLICY "tenant_isolation_insert_churn_reasons"
ON "public"."churn_reasons"
AS PERMISSIVE
FOR INSERT
TO public
WITH CHECK ((holding_id = get_current_user_holding_id()));
