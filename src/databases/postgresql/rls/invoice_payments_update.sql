DROP POLICY IF EXISTS "invoice_payments_update" ON "public"."invoice_payments";

CREATE POLICY "invoice_payments_update"
ON "public"."invoice_payments"
AS PERMISSIVE
FOR UPDATE
TO public
USING (((holding_id = get_current_user_holding_id()) AND user_has_permission('EDIT_FACTURACION'::text)))
WITH CHECK (((holding_id = get_current_user_holding_id()) AND user_has_permission('EDIT_FACTURACION'::text)));
