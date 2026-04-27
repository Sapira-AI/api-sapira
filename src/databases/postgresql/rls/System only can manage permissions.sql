DROP POLICY IF EXISTS "System only can manage permissions" ON "public"."permissions";

CREATE POLICY "System only can manage permissions"
ON "public"."permissions"
AS PERMISSIVE
FOR ALL
TO authenticated
USING (false)
WITH CHECK (false);
