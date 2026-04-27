DROP POLICY IF EXISTS "tenant_isolation_insert_revenue_schedule_monthly" ON "public"."revenue_schedule_monthly";

CREATE POLICY "tenant_isolation_insert_revenue_schedule_monthly"
ON "public"."revenue_schedule_monthly"
AS PERMISSIVE
FOR INSERT
TO public
WITH CHECK ((holding_id = get_current_user_holding_id()));
