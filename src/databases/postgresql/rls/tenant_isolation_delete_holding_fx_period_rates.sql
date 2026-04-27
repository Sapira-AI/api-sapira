DROP POLICY IF EXISTS "tenant_isolation_delete_holding_fx_period_rates" ON "public"."holding_fx_period_rates";

CREATE POLICY "tenant_isolation_delete_holding_fx_period_rates"
ON "public"."holding_fx_period_rates"
AS PERMISSIVE
FOR DELETE
TO public
USING ((holding_id = get_current_user_holding_id()));
