DROP POLICY IF EXISTS "Anyone can view active currencies" ON "public"."currencies";

CREATE POLICY "Anyone can view active currencies"
ON "public"."currencies"
AS PERMISSIVE
FOR SELECT
TO public
USING ((is_active = true));
