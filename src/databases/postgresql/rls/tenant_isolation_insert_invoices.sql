DROP POLICY IF EXISTS "tenant_isolation_insert_invoices" ON "public"."invoices";

CREATE POLICY "tenant_isolation_insert_invoices"
ON "public"."invoices"
AS PERMISSIVE
FOR INSERT
TO public
WITH CHECK ((holding_id = get_current_user_holding_id()));
