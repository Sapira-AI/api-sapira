DROP POLICY IF EXISTS "tenant_amendments_sel" ON "public"."contract_amendments";

CREATE POLICY "tenant_amendments_sel"
ON "public"."contract_amendments"
AS PERMISSIVE
FOR SELECT
TO public
USING ((holding_id = get_current_user_holding_id()));
