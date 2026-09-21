DROP POLICY IF EXISTS "tenant_isolation_select_companies_current_holding" ON "public"."companies";

CREATE POLICY "tenant_isolation_select_companies_current_holding"
ON "public"."companies"
AS PERMISSIVE
FOR SELECT
TO public
USING ((holding_id = ( SELECT get_current_user_holding_id() AS get_current_user_holding_id)));
