DROP POLICY IF EXISTS "tenant_isolation_insert_contracts" ON "public"."contracts";

CREATE POLICY "tenant_isolation_insert_contracts"
ON "public"."contracts"
AS PERMISSIVE
FOR INSERT
TO public
WITH CHECK ((holding_id = get_current_user_holding_id()));
