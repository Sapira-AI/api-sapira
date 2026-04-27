DROP POLICY IF EXISTS "tenant_isolation_update_holding_fx_period_rates" ON "public"."holding_fx_period_rates";

CREATE POLICY "tenant_isolation_update_holding_fx_period_rates"
ON "public"."holding_fx_period_rates"
AS PERMISSIVE
FOR UPDATE
TO public
USING ((holding_id = get_current_user_holding_id()));
