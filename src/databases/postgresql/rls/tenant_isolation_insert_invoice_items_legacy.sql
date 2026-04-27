DROP POLICY IF EXISTS "tenant_isolation_insert_invoice_items_legacy" ON "public"."invoice_items_legacy";

CREATE POLICY "tenant_isolation_insert_invoice_items_legacy"
ON "public"."invoice_items_legacy"
AS PERMISSIVE
FOR INSERT
TO public
WITH CHECK ((holding_id = get_current_user_holding_id()));
