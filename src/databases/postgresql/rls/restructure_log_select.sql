DROP POLICY IF EXISTS "restructure_log_select" ON "public"."invoice_restructure_log";

CREATE POLICY "restructure_log_select"
ON "public"."invoice_restructure_log"
AS PERMISSIVE
FOR SELECT
TO public
USING (((holding_id = get_current_user_holding_id()) AND (user_has_permission('VIEW_FACTURACION'::text) OR user_has_permission('EDIT_FACTURACION'::text))));
