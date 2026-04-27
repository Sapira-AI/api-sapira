DROP POLICY IF EXISTS "invoices_delete_access" ON "public"."invoices";

CREATE POLICY "invoices_delete_access"
ON "public"."invoices"
AS PERMISSIVE
FOR DELETE
TO public
USING ((is_holding_admin() AND (holding_id = get_current_user_holding_id())));
