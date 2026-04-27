DROP POLICY IF EXISTS "tenant_amendments_ins" ON "public"."contract_amendments";

CREATE POLICY "tenant_amendments_ins"
ON "public"."contract_amendments"
AS PERMISSIVE
FOR INSERT
TO public
WITH CHECK ((holding_id = get_current_user_holding_id()));
