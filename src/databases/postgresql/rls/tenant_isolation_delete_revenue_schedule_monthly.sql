DROP POLICY IF EXISTS "tenant_isolation_delete_revenue_schedule_monthly" ON "public"."revenue_schedule_monthly";

CREATE POLICY "tenant_isolation_delete_revenue_schedule_monthly"
ON "public"."revenue_schedule_monthly"
AS PERMISSIVE
FOR DELETE
TO public
USING ((holding_id = get_current_user_holding_id()));
