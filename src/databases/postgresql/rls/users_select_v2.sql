DROP POLICY IF EXISTS "users_select_v2" ON "public"."users";

CREATE POLICY "users_select_v2"
ON "public"."users"
AS PERMISSIVE
FOR SELECT
TO public
USING (rls_can_see_user(id));
