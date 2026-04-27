DROP POLICY IF EXISTS "invoices_update_access" ON "public"."invoices";

CREATE POLICY "invoices_update_access"
ON "public"."invoices"
AS PERMISSIVE
FOR UPDATE
TO public
USING ((user_has_permission('EDIT_FACTURACION'::text) AND (holding_id = get_current_user_holding_id())))
WITH CHECK ((user_has_permission('EDIT_FACTURACION'::text) AND (holding_id = get_current_user_holding_id())));
