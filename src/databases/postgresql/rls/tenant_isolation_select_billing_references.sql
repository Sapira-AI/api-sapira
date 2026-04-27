DROP POLICY IF EXISTS "tenant_isolation_select_billing_references" ON "public"."billing_references";

CREATE POLICY "tenant_isolation_select_billing_references"
ON "public"."billing_references"
AS PERMISSIVE
FOR SELECT
TO public
USING ((holding_id = get_current_user_holding_id()));
