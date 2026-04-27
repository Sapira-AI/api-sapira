DROP POLICY IF EXISTS "tenant_isolation_insert_invoice_collection_logs" ON "public"."invoice_collection_logs";

CREATE POLICY "tenant_isolation_insert_invoice_collection_logs"
ON "public"."invoice_collection_logs"
AS PERMISSIVE
FOR INSERT
TO public
WITH CHECK ((holding_id = get_current_user_holding_id()));
