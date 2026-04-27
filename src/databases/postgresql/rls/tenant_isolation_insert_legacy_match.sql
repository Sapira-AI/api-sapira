DROP POLICY IF EXISTS "tenant_isolation_insert_legacy_match" ON "public"."invoice_items_legacy_match";

CREATE POLICY "tenant_isolation_insert_legacy_match"
ON "public"."invoice_items_legacy_match"
AS PERMISSIVE
FOR INSERT
TO public
WITH CHECK ((holding_id = get_current_user_holding_id()));
