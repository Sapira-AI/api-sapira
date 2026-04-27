DROP POLICY IF EXISTS "Allow authenticated users to read permissions" ON "public"."permissions";

CREATE POLICY "Allow authenticated users to read permissions"
ON "public"."permissions"
AS PERMISSIVE
FOR SELECT
TO authenticated
USING (true);
