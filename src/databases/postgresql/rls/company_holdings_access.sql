DROP POLICY IF EXISTS "company_holdings_access" ON "public"."company_holdings";

CREATE POLICY "company_holdings_access"
ON "public"."company_holdings"
AS PERMISSIVE
FOR SELECT
TO public
USING ((rls_is_super_admin() OR (id = get_current_user_holding_id())));
