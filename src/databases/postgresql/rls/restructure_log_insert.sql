DROP POLICY IF EXISTS "restructure_log_insert" ON "public"."invoice_restructure_log";

CREATE POLICY "restructure_log_insert"
ON "public"."invoice_restructure_log"
AS PERMISSIVE
FOR INSERT
TO public
WITH CHECK (((holding_id = get_current_user_holding_id()) AND user_has_permission('EDIT_FACTURACION'::text)));
