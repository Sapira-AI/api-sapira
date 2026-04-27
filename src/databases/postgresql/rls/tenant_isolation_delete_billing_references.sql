DROP POLICY IF EXISTS "tenant_isolation_delete_billing_references" ON "public"."billing_references";

CREATE POLICY "tenant_isolation_delete_billing_references"
ON "public"."billing_references"
AS PERMISSIVE
FOR DELETE
TO public
USING ((holding_id = get_current_user_holding_id()));
