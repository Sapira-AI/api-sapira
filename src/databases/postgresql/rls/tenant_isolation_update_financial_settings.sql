DROP POLICY IF EXISTS "tenant_isolation_update_financial_settings" ON "public"."financial_settings";

CREATE POLICY "tenant_isolation_update_financial_settings"
ON "public"."financial_settings"
AS PERMISSIVE
FOR UPDATE
TO public
USING ((holding_id = get_current_user_holding_id()));
