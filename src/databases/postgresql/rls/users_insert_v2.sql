DROP POLICY IF EXISTS "users_insert_v2" ON "public"."users";

CREATE POLICY "users_insert_v2"
ON "public"."users"
AS PERMISSIVE
FOR INSERT
TO public
WITH CHECK ((rls_is_super_admin() OR rls_is_holding_admin()));
