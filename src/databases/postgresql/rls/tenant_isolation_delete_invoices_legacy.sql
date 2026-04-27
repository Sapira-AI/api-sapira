DROP POLICY IF EXISTS "tenant_isolation_delete_invoices_legacy" ON "public"."invoices_legacy";

CREATE POLICY "tenant_isolation_delete_invoices_legacy"
ON "public"."invoices_legacy"
AS PERMISSIVE
FOR DELETE
TO public
USING ((holding_id = get_current_user_holding_id()));
