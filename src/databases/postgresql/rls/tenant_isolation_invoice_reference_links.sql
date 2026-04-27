DROP POLICY IF EXISTS "tenant_isolation_invoice_reference_links" ON "public"."invoice_reference_links";

CREATE POLICY "tenant_isolation_invoice_reference_links"
ON "public"."invoice_reference_links"
AS PERMISSIVE
FOR ALL
TO public
USING ((holding_id = get_current_user_holding_id()));
