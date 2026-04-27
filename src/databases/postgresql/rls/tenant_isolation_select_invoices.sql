DROP POLICY IF EXISTS "tenant_isolation_select_invoices" ON "public"."invoices";

CREATE POLICY "tenant_isolation_select_invoices"
ON "public"."invoices"
AS PERMISSIVE
FOR SELECT
TO public
USING ((holding_id = get_current_user_holding_id()));
