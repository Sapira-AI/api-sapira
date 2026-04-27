DROP POLICY IF EXISTS "tenant_isolation_insert_invoice_credit_notes" ON "public"."invoice_credit_notes";

CREATE POLICY "tenant_isolation_insert_invoice_credit_notes"
ON "public"."invoice_credit_notes"
AS PERMISSIVE
FOR INSERT
TO public
WITH CHECK ((holding_id = get_current_user_holding_id()));
