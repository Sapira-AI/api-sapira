DROP POLICY IF EXISTS "invoice_payments_insert" ON "public"."invoice_payments";

CREATE POLICY "invoice_payments_insert"
ON "public"."invoice_payments"
AS PERMISSIVE
FOR INSERT
TO public
WITH CHECK (((holding_id = get_current_user_holding_id()) AND user_has_permission('EDIT_FACTURACION'::text)));
