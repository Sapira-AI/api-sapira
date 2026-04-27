DROP POLICY IF EXISTS "tenant_isolation_update_invoice_credit_notes" ON "public"."invoice_credit_notes";

CREATE POLICY "tenant_isolation_update_invoice_credit_notes"
ON "public"."invoice_credit_notes"
AS PERMISSIVE
FOR UPDATE
TO public
USING ((holding_id = get_current_user_holding_id()));
