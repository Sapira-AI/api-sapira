DROP POLICY IF EXISTS "Anyone can read permissions" ON "public"."permissions";

CREATE POLICY "Anyone can read permissions"
ON "public"."permissions"
AS PERMISSIVE
FOR SELECT
TO authenticated
USING (true);
