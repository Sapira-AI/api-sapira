DROP POLICY IF EXISTS "tenant_isolation_select_quotes" ON "public"."quotes";

CREATE POLICY "tenant_isolation_select_quotes"
ON "public"."quotes"
AS PERMISSIVE
FOR SELECT
TO public
USING ((holding_id = get_current_user_holding_id()));
