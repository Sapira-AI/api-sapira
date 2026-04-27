DROP POLICY IF EXISTS "tenant_isolation_update_invoice_emails" ON "public"."invoice_emails";

CREATE POLICY "tenant_isolation_update_invoice_emails"
ON "public"."invoice_emails"
AS PERMISSIVE
FOR UPDATE
TO public
USING ((holding_id = get_current_user_holding_id()));
