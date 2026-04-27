DROP POLICY IF EXISTS "tenant_isolation_select_invoice_references" ON "public"."invoice_references";

CREATE POLICY "tenant_isolation_select_invoice_references"
ON "public"."invoice_references"
AS PERMISSIVE
FOR SELECT
TO public
USING ((holding_id = get_current_user_holding_id()));
