DROP POLICY IF EXISTS "users_update_v2" ON "public"."users";

CREATE POLICY "users_update_v2"
ON "public"."users"
AS PERMISSIVE
FOR UPDATE
TO public
USING ((rls_is_super_admin() OR (rls_is_holding_admin() AND rls_can_see_user(id))));
