DROP POLICY IF EXISTS "tenant_isolation_select_contracts" ON "public"."contracts";

CREATE POLICY "tenant_isolation_select_contracts"
ON "public"."contracts"
AS PERMISSIVE
FOR SELECT
TO public
USING ((holding_id = get_current_user_holding_id()));
