DROP POLICY IF EXISTS "invoice_payments_delete" ON "public"."invoice_payments";

CREATE POLICY "invoice_payments_delete"
ON "public"."invoice_payments"
AS PERMISSIVE
FOR DELETE
TO public
USING (((holding_id = get_current_user_holding_id()) AND user_has_permission('EDIT_FACTURACION'::text)));
