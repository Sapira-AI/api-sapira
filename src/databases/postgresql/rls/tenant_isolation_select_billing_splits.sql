DROP POLICY IF EXISTS "tenant_isolation_select_billing_splits" ON "public"."contract_billing_splits";

CREATE POLICY "tenant_isolation_select_billing_splits"
ON "public"."contract_billing_splits"
AS PERMISSIVE
FOR SELECT
TO public
USING ((holding_id = get_current_user_holding_id()));
