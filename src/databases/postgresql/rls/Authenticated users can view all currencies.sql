DROP POLICY IF EXISTS "Authenticated users can view all currencies" ON "public"."currencies";

CREATE POLICY "Authenticated users can view all currencies"
ON "public"."currencies"
AS PERMISSIVE
FOR SELECT
TO public
USING ((auth.role() = 'authenticated'::text));
