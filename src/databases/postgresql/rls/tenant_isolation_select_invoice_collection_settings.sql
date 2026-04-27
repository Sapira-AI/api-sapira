DROP POLICY IF EXISTS "tenant_isolation_select_invoice_collection_settings" ON "public"."invoice_collection_settings";

CREATE POLICY "tenant_isolation_select_invoice_collection_settings"
ON "public"."invoice_collection_settings"
AS PERMISSIVE
FOR SELECT
TO public
USING ((holding_id = get_current_user_holding_id()));
