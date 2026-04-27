DROP POLICY IF EXISTS "user_holdings_access" ON "public"."user_holdings";

CREATE POLICY "user_holdings_access"
ON "public"."user_holdings"
AS PERMISSIVE
FOR SELECT
TO public
USING ((rls_is_super_admin() OR (holding_id = get_current_user_holding_id()) OR (user_id IN ( SELECT users.id
   FROM users
  WHERE (users.auth_id = auth.uid())))));
