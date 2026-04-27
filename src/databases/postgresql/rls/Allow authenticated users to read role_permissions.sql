DROP POLICY IF EXISTS "Allow authenticated users to read role_permissions" ON "public"."role_permissions";

CREATE POLICY "Allow authenticated users to read role_permissions"
ON "public"."role_permissions"
AS PERMISSIVE
FOR SELECT
TO authenticated
USING (true);
