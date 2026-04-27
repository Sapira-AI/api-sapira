DROP POLICY IF EXISTS "tenant_isolation_insert_financial_settings" ON "public"."financial_settings";

CREATE POLICY "tenant_isolation_insert_financial_settings"
ON "public"."financial_settings"
AS PERMISSIVE
FOR INSERT
TO public
WITH CHECK ((holding_id = get_current_user_holding_id()));
