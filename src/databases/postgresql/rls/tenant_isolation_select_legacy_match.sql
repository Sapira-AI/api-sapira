DROP POLICY IF EXISTS "tenant_isolation_select_legacy_match" ON "public"."invoice_items_legacy_match";

CREATE POLICY "tenant_isolation_select_legacy_match"
ON "public"."invoice_items_legacy_match"
AS PERMISSIVE
FOR SELECT
TO public
USING ((holding_id = get_current_user_holding_id()));
