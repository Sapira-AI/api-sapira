DROP POLICY IF EXISTS "tenant_isolation_update_quotes" ON "public"."quotes";

CREATE POLICY "tenant_isolation_update_quotes"
ON "public"."quotes"
AS PERMISSIVE
FOR UPDATE
TO public
USING ((holding_id = get_current_user_holding_id()))
WITH CHECK ((holding_id = get_current_user_holding_id()));
