DROP POLICY IF EXISTS "invoices_holding_isolation" ON "public"."invoices";

CREATE POLICY "invoices_holding_isolation"
ON "public"."invoices"
AS PERMISSIVE
FOR SELECT
TO public
USING (((holding_id = get_current_user_holding_id()) AND (user_has_permission('VIEW_FACTURACION'::text) OR user_has_permission('EDIT_FACTURACION'::text))));
