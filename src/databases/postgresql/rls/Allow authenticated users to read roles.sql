DROP POLICY IF EXISTS "Allow authenticated users to read roles" ON "public"."roles";

CREATE POLICY "Allow authenticated users to read roles"
ON "public"."roles"
AS PERMISSIVE
FOR SELECT
TO authenticated
USING (true);
