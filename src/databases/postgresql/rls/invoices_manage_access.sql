DROP POLICY IF EXISTS "invoices_manage_access" ON "public"."invoices";

CREATE POLICY "invoices_manage_access"
ON "public"."invoices"
AS PERMISSIVE
FOR INSERT
TO public
WITH CHECK ((user_has_permission('EDIT_FACTURACION'::text) AND (holding_id = get_current_user_holding_id())));
