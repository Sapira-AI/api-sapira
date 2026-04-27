DROP POLICY IF EXISTS "tenant_isolation_delete_invoice_collection_logs" ON "public"."invoice_collection_logs";

CREATE POLICY "tenant_isolation_delete_invoice_collection_logs"
ON "public"."invoice_collection_logs"
AS PERMISSIVE
FOR DELETE
TO public
USING ((holding_id = get_current_user_holding_id()));
