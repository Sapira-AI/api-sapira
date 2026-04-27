DROP POLICY IF EXISTS "tenant_isolation_update_invoice_references" ON "public"."invoice_references";

CREATE POLICY "tenant_isolation_update_invoice_references"
ON "public"."invoice_references"
AS PERMISSIVE
FOR UPDATE
TO public
USING ((holding_id = get_current_user_holding_id()));
