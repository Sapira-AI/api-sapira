DROP POLICY IF EXISTS "invoice_payments_select" ON "public"."invoice_payments";

CREATE POLICY "invoice_payments_select"
ON "public"."invoice_payments"
AS PERMISSIVE
FOR SELECT
TO public
USING (((holding_id = get_current_user_holding_id()) AND (user_has_permission('VIEW_FACTURACION'::text) OR user_has_permission('EDIT_FACTURACION'::text))));
