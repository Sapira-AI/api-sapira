DROP POLICY IF EXISTS "tenant_isolation_insert_invoice_references" ON "public"."invoice_references";

CREATE POLICY "tenant_isolation_insert_invoice_references"
ON "public"."invoice_references"
AS PERMISSIVE
FOR INSERT
TO public
WITH CHECK ((holding_id = get_current_user_holding_id()));
