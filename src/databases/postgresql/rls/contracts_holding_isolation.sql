DROP POLICY IF EXISTS "contracts_holding_isolation" ON "public"."contracts";

CREATE POLICY "contracts_holding_isolation"
ON "public"."contracts"
AS PERMISSIVE
FOR SELECT
TO public
USING ((holding_id = ( SELECT get_current_user_holding_id() AS get_current_user_holding_id)));
