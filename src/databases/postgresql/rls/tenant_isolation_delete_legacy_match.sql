DROP POLICY IF EXISTS "tenant_isolation_delete_legacy_match" ON "public"."invoice_items_legacy_match";

CREATE POLICY "tenant_isolation_delete_legacy_match"
ON "public"."invoice_items_legacy_match"
AS PERMISSIVE
FOR DELETE
TO public
USING ((holding_id = get_current_user_holding_id()));
