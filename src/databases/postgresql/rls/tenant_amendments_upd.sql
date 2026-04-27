DROP POLICY IF EXISTS "tenant_amendments_upd" ON "public"."contract_amendments";

CREATE POLICY "tenant_amendments_upd"
ON "public"."contract_amendments"
AS PERMISSIVE
FOR UPDATE
TO public
USING ((holding_id = get_current_user_holding_id()));
