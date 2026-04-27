DROP POLICY IF EXISTS "tenant_isolation_insert_billing_references" ON "public"."billing_references";

CREATE POLICY "tenant_isolation_insert_billing_references"
ON "public"."billing_references"
AS PERMISSIVE
FOR INSERT
TO public
WITH CHECK ((holding_id = get_current_user_holding_id()));
